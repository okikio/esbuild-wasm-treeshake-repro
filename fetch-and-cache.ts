import { extname } from "node:path";

export const CACHE = new Map();
export const CACHE_NAME = "EXTERNAL_FETCHES";
export const SUPPORTS_CACHE_API = "caches" in globalThis;
export const SUPPORTS_REQUEST_API = "Request" in globalThis;

export function requestKey(request: RequestInfo) {
    return SUPPORTS_REQUEST_API && request instanceof Request ? request.url.toString() : request.toString()
}

export async function newRequest(request: RequestInfo, cache?: Cache, fetchOpts?: RequestInit) {
    const networkResponse: Response = await fetch(request, fetchOpts);

    if (!fetchOpts?.method || (fetchOpts?.method && fetchOpts.method.toUpperCase() !== "GET"))
        return networkResponse;

    const clonedResponse = networkResponse.clone();
    if (SUPPORTS_CACHE_API && cache) {
        cache.put(request, clonedResponse);
    } else {
        const reqKey = requestKey(request);
        CACHE.set(reqKey, clonedResponse);
    }

    return networkResponse;
}

export let OPEN_CACHE: Cache;
export async function openCache() {
    if (OPEN_CACHE) return OPEN_CACHE;
    return (OPEN_CACHE = await globalThis.caches.open(CACHE_NAME));
}

export async function getRequest(url: RequestInfo | URL, permanent = false, fetchOpts?: RequestInit) {
    const request = SUPPORTS_REQUEST_API ? new Request(url.toString(), fetchOpts) : url.toString();
    let response: Response;

    let cache: Cache | undefined;
    let cacheResponse: Response | undefined;

    // In specific situations the browser will sometimes disable access to cache storage, 
    // so, I create my own in memory cache
    if (SUPPORTS_CACHE_API) {
        cache = await openCache();
        cacheResponse = await cache.match(request);
    } else {
        const reqKey = requestKey(request);
        cacheResponse = CACHE.get(reqKey);
    }

    if (cacheResponse)
        response = cacheResponse;

    // If permanent is true, use the cache first and only go to the network if there is nothing in the cache, 
    // otherwise, still use cache first, but in the background queue up a network request
    if (!cacheResponse)
        response = await newRequest(request, cache, fetchOpts);
    else if (!permanent) {
        newRequest(request, cache, fetchOpts);
    }

    return response!;
}

/**
 * Fetches packages and handles redirects
 * 
 * @param url package url to fetch
 */
export async function fetchPkg(url: string, fetchOpts?: RequestInit) {
    try {
      const response = await getRequest(url, undefined, fetchOpts);
      if (!response.ok)
        throw new Error(`Couldn't load ${response.url || url} (${response.status} code)`);
  
      console.log(`Fetch ${fetchOpts?.method === "HEAD" ? `(test)` : ""} ${response.url || url}`, "info");
  
      return {
        // Deno doesn't have a `response.url` which is odd but whatever
        url: response.url || url,
        content: new Uint8Array(await response.arrayBuffer()),
      };
    } catch (err) {
      throw new Error(`[getRequest] Failed at request (${url})\n${err.toString()}`);
    }
  }
  

// Imports have various extentions, fetch each extention to confirm what the user meant
const fileEndings = ["", "/index"];
const exts = ["", ".js", ".mjs", "/index.js", ".ts", ".tsx", ".cjs", ".d.ts"];

// It's possible to have `./lib/index.d.ts` or `./lib/index.mjs`, and have a user enter use `./lib` as the import
// It's very annoying but you have to check all variants
const allEndingVariants = Array.from(new Set(fileEndings.map(ending => {
  return exts.map(extension => ending + extension)
}).flat()));

const endingVariantsLength = allEndingVariants.length;
const FAILED_EXT_URLS = new Set<string>();

/**
 * Test the waters, what extension are we talking about here?
 * @param path 
 */
export async function determineExtension(path: string, headersOnly: boolean = true) {
  // Some typescript files don't have file extensions but you can't fetch a file without their file extension
  // so bundle tries to solve for that
  const argPath = (suffix = "") => path + suffix;
  let url = path;
  let ext = "";
  let content: Uint8Array | undefined;

  let err: Error | undefined;
  for (let i = 0; i < endingVariantsLength; i++) {
    const endings = allEndingVariants[i];
    const testingUrl = argPath(endings);

    try {
      if (FAILED_EXT_URLS.has(testingUrl)) {
        continue;
      }

      ({ url, content } = await fetchPkg(testingUrl, headersOnly ? { method: "HEAD" } : undefined));
      ext = extname(url) ?? "";
      break;
    } catch (e) {
      FAILED_EXT_URLS.add(testingUrl);

      if (i === 0) {
        err = e as Error;
      }

      // If after checking all the different file extensions none of them are valid
      // Throw the first fetch error encountered, as that is generally the most accurate error
      if (i >= endingVariantsLength - 1) {
        console.log((err ?? e).toString(), "error");
        throw err ?? e;
      }
    }
  }

  return headersOnly ? { url, ext } : { url, content, ext };
}
