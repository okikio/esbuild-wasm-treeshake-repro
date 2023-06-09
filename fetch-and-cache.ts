// Importing the 'extname' function from Node's 'path' module.
// We use this to get the file extension of our resources.
import { extname } from "node:path";

// Define a Map to serve as a cache. We store the request URLs and their responses here.
export const CACHE = new Map();

// A function that creates a unique key for each request, allowing us to cache them effectively.
export function requestKey(request: RequestInfo) {
  // If we can, we use the Request object's URL as a key, else we simply convert the request info to a string and use it as a key.
  return request instanceof Request ? request.url : request;
}

// Here's where we actually perform a network request for a resource.
export async function newRequest(request: RequestInfo, clone = true) {
  // Fetch the resource and store the response.
  const networkResponse: Response = await fetch(request);
  
  if (clone) {
    // If the Cache API isn't supported, we fall back to our Map-based cache.
    CACHE.set(requestKey(request), networkResponse);

    // And finally, we return the original network response.
    return networkResponse;
  } 

  CACHE.set(requestKey(request), networkResponse);
}

// This function is what you'd call to get a resource, it manages both cache retrieval and network requests for you.
export async function getRequest(url: RequestInfo | URL, permanent = false) {
  // We first prepare our request. If the Request API is supported, we create a new Request object. If not, we just use the URL.
  const request = new Request(url);
  // Then, we check the cache for a response to this request.
  let response = CACHE.get(requestKey(request));

  // If the response isn't in the cache, we fetch it.
  if (!response) {
    response = await newRequest(request);
  } else if (!permanent) {
    // If the response is in the cache but not permanent, we make a new request to update the cache.
    newRequest(request, false);
  }

  // We return the response!
  return response!.clone();
}

// This function fetches the content of a package.
export async function fetchPkg(url: string) {
  // We use our getRequest function to fetch the package content.
  const response = await getRequest(url);

  // If the response isn't okay (HTTP 200), we throw an error.
  if (!response.ok)
    throw new Error(`Couldn't load ${response.url || url} (${response.status} code}`);

  // For debug purposes, we log the URL we fetched.
  // console.log(`Fetch  ${response.url || url}`);

  // We return an object containing the URL and the actual content.
  return {
    url: response.url || url,
    content: new Uint8Array(await response.arrayBuffer()),
  };
}

// We're preparing a list of possible file endings.
// We use this to support a range of JavaScript and TypeScript files.
const allEndingVariants = Array.from(new Set(["", "/index"].map(ending => {
  return ["", ".js", ".mjs", "/index.js", ".ts", ".tsx", ".cjs", ".d.ts"].map(extension => ending + extension)
}).flat()));

// This function helps us handle cases where file extensions aren't clear.
export async function determineExtension(path: string) {
  // Set up variables to hold the URL, file extension, and content of the fetched file.
  let url = path;
  let ext = "";
  let content: Uint8Array | undefined;
  let err: Error | undefined;

  // We try out all possible endings to fetch the correct file.
  for (const endings of allEndingVariants) {
    const testingUrl = path + endings;

    try {
      // Use fetchPkg to fetch the resource, updating url and content variables.
      ({ url, content } = await fetchPkg(testingUrl));
      // Once a fetch is successful, get the file extension and break out of the loop.
      ext = extname(url) ?? "";
      break;
    } catch (e) {
      // If there's an error, we save it to throw it later if we can't find a valid extension.
      err = err || e;
    }
  }

  // If we couldn't determine a valid extension, log the error and throw it.
  if (!ext) {
    // console.log(err.toString(), "error");
    throw err;
  }

  // We return an object with the URL, the content, and the file extension.
  return { url, content, ext };
}

// Create cache of URLs that have been resolved.
export const urlCache = new Map<string, { path: string, sideEffects?: boolean }>()

// Create a virtual file system in memory to store content fetched from the CDN.
export const virtualFS = new Map<string, string>()

// Instantiate a TextDecoder to convert Uint8Array data to strings.
export const decoder = new TextDecoder()

// Function to fetch and cache content, reducing duplication
export async function fetchAndCacheContent(url: URL, argPath: string, sideEffects?: boolean) {
  // Determines the correct extension for typescript files (which sometimes don't have extensions)
  const { content, url: urlStr } = await determineExtension(url.toString());
  const filePath = "/node_modules" + new URL(urlStr).pathname;
  virtualFS.set(filePath, decoder.decode(content));
  urlCache.set(argPath, { path: filePath, sideEffects });
  return filePath;
}