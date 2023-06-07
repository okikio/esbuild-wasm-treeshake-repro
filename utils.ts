import type { Loader } from 'esbuild';
import { extname, isAbsolute, join } from 'node:path';

/**
 * The default CDN host
 */
export const DEFAULT_CDN_HOST = 'https://unpkg.com';

/**
 * Generates a CDN URL for an import, taking advantage of CDN URL Schemes in imports and the default CDN hosts parameter to decide the CDN host
 * Read through {@link getCDNOrigin} and {@link getPureImportPath}
 */
export const getCDNUrl = (importStr: string, cdn = DEFAULT_CDN_HOST) => {
	let origin = /\/$/.test(cdn) ? cdn : `${cdn}/`;
	let path = importStr.replace(/^\//, "");
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