import type { Loader } from 'esbuild-wasm';
import { extname, isAbsolute, join } from 'node:path';

/**
 * The default CDN host
 */
export const DEFAULT_CDN_HOST = 'https://unpkg.com';

/**
 * Returns the CDN style supported by certain CDN's
 * e.g. 
 * - `npm` - unpkg, skypack, esm.sh, and jsdelivr all support `npm` style imports for example they support adding versions to their URLs like this `https://unpkg.com/@okikio/animate@beta`
 * - `github` - github, and jsdelivr.gh both support `github` style imports, as in they don't support adding versions to their URLs like this `https://cdn.jsdelivr.net/gh/jquery/jquery/dist/jquery.min.js`
 * - `deno` - deno supports `deno` style imports, as in they don't support adding versions to their URLs like this `https://deno.land/x/brotli/mod.ts`
 * - `other` - CDNs that haven't been added to the list
 */
export const getCDNStyle = (urlStr: string) => {
    if (/^(skypack|esm|esm\.sh|unpkg|jsdelivr|esm\.run)\:?/.test(urlStr) || /^https?:\/\/(cdn\.skypack\.dev|cdn\.esm\.sh|cdn\.jsdelivr\.net\/npm|unpkg\.com)/.test(urlStr)) 
        return "npm";

    else if (/^(jsdelivr\.gh|github)\:?/.test(urlStr) || /^https?:\/\/(cdn\.jsdelivr\.net\/gh|raw\.githubusercontent\.com)/.test(urlStr)) 
        return "github";

    else if (/^(deno)\:?/.test(urlStr) || /^https?:\/\/(deno\.land\/x)/.test(urlStr) )
        return "deno";

    return "other";
}

/**
 * Based on the URL scheme of the import, this method will return an actual CDN host origin to use,
 * e.g. 
 * ```ts
 * getCDNHost("react") //= https://unpkg.com
 * getCDNHost("react", "https://cdn.skypack.dev") //= https://cdn.skypack.dev/
 * 
 * // CDN URL Schemes take precedence above everything
 * getCDNHost("esm:react", "https://cdn.skypack.dev") //= https://cdn.esm.sh/
 * ```
 * 
 * > _**Note**: The returned CDN URL string will end with a '/' e.g. `https://cdn.esm.sh/`_
 * 
 * @param importStr imports to find a CDN for
 * @param cdn The default CDN host to use. This can change based on the config of the user. This may be diregarded if the `importStr` has a CDN URL Scheme
 * @returns CDN URL host string
 */
export const getCDNOrigin = (importStr: string, cdn = DEFAULT_CDN_HOST) => {
    // `skypack:` --> `https://cdn.skypack.dev`
    if (/^skypack\:/.test(importStr))
        cdn = `https://cdn.skypack.dev`;

    // `esm.sh:` or `esm:` --> `https://cdn.esm.sh`
    else if (/^(esm\.sh|esm)\:/.test(importStr))
        cdn = `https://cdn.esm.sh`;

    // `unpkg:` --> `https://unpkg.com`
    else if (/^unpkg\:/.test(importStr))
        cdn = `https://unpkg.com`;

    // (NPM) `jsdelivr:` or `esm.run:` --> `https://cdn.jsdelivr.net/npm`
    else if (/^(jsdelivr|esm\.run)\:/.test(importStr))
        cdn = `https://cdn.jsdelivr.net/npm`;

    // (GitHub) `jsdelivr.gh:` --> `https://cdn.jsdelivr.net/gh`
    else if (/^(jsdelivr\.gh)\:/.test(importStr))
        cdn = `https://cdn.jsdelivr.net/gh`;

    // `deno:` --> `https://deno.land/x`
    else if (/^(deno)\:/.test(importStr))
        cdn = `https://deno.land/x`;

    // `github:` --> `https://raw.githubusercontent.com`
    else if (/^(github)\:/.test(importStr)) 
        cdn = `https://raw.githubusercontent.com`;

    return /\/$/.test(cdn) ? cdn : `${cdn}/`;
}

/**
 * Remove CDN URL Schemes like `deno:...`, `unpkg:...`, etc... and known CDN hosts, e.g. `https://raw.githubusercontent.com/...`, `https://cdn.skypack.dev/...`, etc...  Leaving only the import path
 */
 export const getPureImportPath = (importStr: string) => 
    importStr
        .replace(/^(skypack|esm|esm\.sh|unpkg|jsdelivr|jsdelivr\.gh|esm\.run|deno|github)\:/, "")
        .replace(/^https?:\/\/(cdn\.skypack\.dev|cdn\.esm\.sh|cdn\.jsdelivr\.net\/npm|unpkg\.com|cdn\.jsdelivr\.net\/gh|raw\.githubusercontent\.com|deno\.land\/x)/, "")
        .replace(/^\//, "");

/**
 * Generates a CDN URL for an import, taking advantage of CDN URL Schemes in imports and the default CDN hosts parameter to decide the CDN host
 * Read through {@link getCDNOrigin} and {@link getPureImportPath}
 */
export const getCDNUrl = (importStr: string, cdn = DEFAULT_CDN_HOST) => {
    let origin = getCDNOrigin(importStr, cdn);
    let path = getPureImportPath(importStr);
    let url = new URL(path, origin);
    return { import: importStr, path, origin, cdn, url };
}

/**  */ 
export const RESOLVE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".css", ".json"];

/**
 * Based on https://github.com/egoist/play-esbuild/blob/main/src/lib/esbuild.ts
 * Uses the file extention to determine the loader esbuild should use
 */
export const inferLoader = (urlStr: string): Loader => {
    const ext = extname(urlStr);
    if (RESOLVE_EXTENSIONS.includes(ext))
        // Resolve all .js and .jsx files to .ts and .tsx files
        return (/\.js(x)?$/.test(ext) ? ext.replace(/^\.js/, ".ts") : ext).slice(1) as Loader;

    if (ext === ".mjs" || ext === ".cjs") return "ts"; // "js"
    if (ext === ".mts" || ext === ".cts") return "ts";
    
    if (ext == ".scss") return "css";

    if (ext == ".png" || ext == ".jpeg" || ext == ".ttf") return "dataurl";
    if (ext == ".svg" || ext == ".html" || ext == ".txt") return "text";
    if (ext == ".wasm") return "file";

    return ext.length ? "text" : "ts";
}


const WHITESPACE_ENCODINGS: Record<string, string> = {
    "\u0009": "%09",
    "\u000A": "%0A",
    "\u000B": "%0B",
    "\u000C": "%0C",
    "\u000D": "%0D",
    "\u0020": "%20",
  };
  
  export function encodeWhitespace(string: string): string {
    return string.replaceAll(/[\s]/g, (c) => {
      return WHITESPACE_ENCODINGS[c] ?? c;
    });
  }

/** 
 * Based on https://github.com/egoist/play-esbuild/blob/main/src/lib/path.ts#L123
 * 
 * Support joining paths to a URL
 */
export const urlJoin = (urlStr: string, ...args: string[]) => {
    const url = new URL(urlStr);
    url.pathname = encodeWhitespace(
        join(url.pathname, ...args).replace(/%/g, "%25").replace(/\\/g, "%5C"),
    );
    return url.toString();
}

/**
 * An import counts as a bare import if it's neither a relative import of an absolute import
 */
 export const isBareImport = (importStr: string) => {
    return /^(?!\.).*/.test(importStr) && !isAbsolute(importStr);
}