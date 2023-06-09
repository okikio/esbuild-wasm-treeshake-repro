import type { Loader } from 'esbuild-wasm';
import { resolve, legacy } from "resolve.exports";
import { extname, isAbsolute, join } from 'node:path';

/**
 * The default CDN host
 */
export const DEFAULT_CDN_HOST = 'https://unpkg.com';

/**
 * Function to generate a CDN URL for a given import. This makes use of the CDN URL schemes in 
 * the imports and the default CDN hosts provided as parameters. The result is an object that 
 * contains the path of the import, the origin URL, the CDN, and 
 * the newly formed URL.
 *
 * @param importStr - The import string.
 * @param cdn - The CDN URL (defaults to {@link DEFAULT_CDN_HOST}).
 * @returns An object that contains the path, origin, CDN and URL.
 */
export const getCDNUrl = (importStr: string, cdn = DEFAULT_CDN_HOST) => {
	let origin = /\/$/.test(cdn) ? cdn : `${cdn}/`;
	let path = importStr.replace(/^\//, "");
	let url = new URL(path, origin);
	return { path, origin, cdn, url };
}

export const RESOLVE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".css", ".json"];

/**
 * Infers the loader to use with esbuild based on the file extension. It supports the extensions
 * specified in the RESOLVE_EXTENSIONS array, as well as others like .mjs, .cjs, .scss and more.
 *
 * @param urlStr - The URL string.
 * @returns The inferred loader.
 */
export const inferLoader = (urlStr: string): Loader => {
	const ext = extname(urlStr);
	if (RESOLVE_EXTENSIONS.includes(ext))
		return (/\.js(x)?$/.test(ext) ? ext.replace(/^\.js/, ".ts") : ext).slice(1) as Loader;

	if (ext === ".mjs" || ext === ".cjs") return "ts";
	if (ext === ".mts" || ext === ".cts") return "ts";
	if (ext == ".scss") return "css";
	if (ext == ".png" || ext == ".jpeg" || ext == ".ttf") return "dataurl";
	if (ext == ".svg" || ext == ".html" || ext == ".txt") return "text";
	if (ext == ".wasm") return "file";

	return ext.length ? "text" : "ts";
}

/**
 * A dictionary to represent whitespace encodings
 */
const WHITESPACE_ENCODINGS: Record<string, string> = {
	"\u0009": "%09",
	"\u000A": "%0A",
	"\u000B": "%0B",
	"\u000C": "%0C",
	"\u000D": "%0D",
	"\u0020": "%20",
};

/**
 * Function to encode whitespace in a string.
 *
 * @param string - The string to encode.
 * @returns The encoded string.
 */
export function encodeWhitespace(string: string): string {
	return string.replaceAll(/[\s]/g, (c) => {
		return WHITESPACE_ENCODINGS[c] ?? c;
	});
}

/**
 * Joins the paths to a URL, making sure to properly encode whitespaces.
 *
 * @param urlStr - The base URL.
 * @param args - The paths to join.
 * @returns The joined URL.
 */
export const urlJoin = (urlStr: string, ...args: string[]) => {
	const url = new URL(urlStr);
	url.pathname = encodeWhitespace(
		join(url.pathname, ...args).replace(/%/g, "%25").replace(/\\/g, "%5C"),
	);
	return url.toString();
}

/**
 * Determines if an import is a bare import. A bare import is neither a relative import nor an 
 * absolute import.
 *
 * @param importStr - The import string.
 * @returns True if the import is a bare import, false otherwise.
 */
export const isBareImport = (importStr: string) => {
	return /^(?!\.).*/.test(importStr) && !isAbsolute(importStr);
}

// Define a helper function to determine if a path is relative
export const isRelative = (path: string) => path.startsWith('./') || path.startsWith('../');

// Define a helper function to determine if a path is in node_modules
export const isNodeModule = (path: string) => path.includes('node_modules');

// Function to convert absolute path to relative path
export const resolveRelativePath = (path: string): string => {
	// Remove leading slash to make it relative
	return path.replace(/^\//, "./");
}

// Function to resolve modern imports based on the "exports" field in package.json
export const modernImportResolve = (pkg: any, path: string): any => {
	// Try multiple methods to resolve the package imports
	// Prioritize browser environment, then unsafe deno and worker conditions, and finally require
	return resolve(pkg, path, { browser: true, conditions: ["module"] }) ||
		resolve(pkg, path, { unsafe: true, conditions: ["deno", "worker", "production"] }) ||
		resolve(pkg, path, { require: true });
}

// Function to resolve legacy imports based on other fields in package.json
export const legacyImportResolve = (pkg: any): any => {
	// Try resolving based on browser and then fields like "unpkg" and "bin"
	return legacy(pkg, { browser: true }) ||
		legacy(pkg, { fields: ["unpkg", "bin"] });
}

// Function to extract the first valid value from the resolved package
export const getFirstValidValue = (legacyResolve: any): any => {
	// If it's an array, get the first value
	if (Array.isArray(legacyResolve)) {
		return legacyResolve[0];
		// If it's an object, get the first value that's not a CommonJS module or from a source directory
	} else if (typeof legacyResolve === "object") {
		const nonCJSKeys = Object.keys(legacyResolve).filter(key => {
			return !/\.cjs$/.exec(key) && !/src\//.exec(key) && legacyResolve[key];
		});
		const keysToUse = nonCJSKeys.length > 0 ? nonCJSKeys : Object.keys(legacyResolve);
		return legacyResolve[keysToUse[0]];
		// If it's neither, just return the value itself
	} else {
		return legacyResolve;
	}
}