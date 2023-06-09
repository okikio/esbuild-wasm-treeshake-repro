// Import necessary modules for the code.
import esbuild from "esbuild"; // esbuild-wasm is too slow
import { fileURLToPath } from "node:url";
import { join, extname, dirname } from "node:path";

// resolve and parse-package-name help in resolving packages and parsing package names respectively.
import { parse as parsePackageName } from "parse-package-name";

// Utility functions to handle URLs, infer the type of module loader, and to identify if a given path is a bare import.
import { getCDNUrl, isBareImport, inferLoader, isNodeModule, isRelative, getFirstValidValue, legacyImportResolve, modernImportResolve, resolveRelativePath } from "./utils.ts";

// Utility functions to determine the file extension of fetched resources and to make HTTP requests.
import { fetchAndCacheContent, getRequest, urlCache, virtualFS } from "./fetch-and-cache.ts";

export type PackageJson = {
  // The name of the package.
  name: string;
  // The version of the package.
  version: string;
  // A short description of the package.
  description?: string;
  // An array of keywords that describe the package.
  keywords?: string[];
  // The URL to the homepage of the package.
  homepage?: string;
  // The URL to the issue tracker and/or the email address to which issues should be reported.
  bugs?: { url: string; email?: string } | { url?: string; email: string };
  // The license identifier or a path/url to a license file for the package.
  license?: string;
  // The person or persons who authored the package. Can be a name, an email address, or an object with name, email and url properties.
  author?: string | { name: string; email?: string; url?: string };
  // An array of people who contributed to the package. Each element can be a name, an email address, or an object with name, email and url properties.
  contributors?: Array<string | {
    name: string; email?: string; url?:
    string
  }>;
  // An array of files included in the package. Each element can be a file path or an object with include and exclude arrays of file paths. If this field is omitted, all files in the package root are included (except those listed in .npmignore or .gitignore).
  files?: Array<string | { include: Array<string>; exclude: Array<string> }>;

  // An object that maps package names to version ranges that the package depends on at runtime.
  dependencies?: { [packageName: string]: string };
  // An object that maps package names to version ranges that the package depends on for development purposes only.
  devDependencies?: { [packageName: string]: string };
  // An object that maps package names to version ranges that the package depends on optionally. If a dependency cannot be installed, npm will skip it and continue with the installation process.
  optionalDependencies?: { [packageName: string]: string };
  // An object that maps package names to version ranges that the package depends on if they are available in the same environment as the package. If a peer dependency is not met, npm will warn but not fail.
  peerDependencies?: { [packageName: string]: string };
}

// The directory of the current script.
const dir = dirname(fileURLToPath(import.meta.url));

// Default build configuration options.
const config: esbuild.BuildOptions = {
  entryPoints: [join(dir, "./src/index.ts")],  // Entry point for the application.
  target: ["esnext"],  // The output file will be compatible with esnext.

  format: "esm",  // The output file will be in ECMAScript module format.
  treeShaking: true,  // Tree shaking is disabled, so unused code will not be removed.
  bundle: true, // Code will be bundled into a single file.

  color: true,  // Enable colorful log output.
  logLevel: "info",  // Logs of "info" level and above will be shown.
  platform: "browser",  // The output file will be runnable in a browser.
}

// Initialize esbuild.
await esbuild.initialize({});

// Start logging group for esbuild without plugins.
console.group("esbuild-wasm - no plugins");

// Run esbuild without plugins.
await esbuild.build({
  ...config,
  outfile: "dist/no-plugin-bundle.js",  // The output file will be written here.
});

// End logging group.
console.groupEnd()

// Start logging group for esbuild with plugins.
console.group("esbuild-wasm - w/ plugins");

// Run esbuild with plugins.
await esbuild.build({
  ...config,
  outfile: "dist/with-plugin-bundle.js",  // The output file will be written here.
  plugins: [
    {
      name: "cdn",
      setup(build) {
        // This block handles resolution of paths. It checks if the path is a bare import or a relative path,
        // fetches the package.json files for bare imports and resolves the paths, caches the resolved paths,
        // fetches the actual file content and caches that too.
        build.onResolve({ filter: /.*/ }, async (args) => {
          const { path: argPath, origin } = getCDNUrl(args.path);

          // Determine the path depending on whether it's a bare import (like 'react') or a relative/absolute path
          const path = isBareImport(args.path) ? argPath : join(args.resolveDir, argPath)

          // Check if the URL for this path has already been resolved and cached.
          // If so, return it. Otherwise, continue with resolution.
          if (urlCache.has(path)) {
            const cachedUrl = urlCache.get(path);
            return {
              path: cachedUrl.path,
              namespace: 'cdn',
              sideEffects: cachedUrl.sideEffects,
              pluginData: {
                sideEffects: cachedUrl.sideEffects,
                pkg: cachedUrl.pkg
              }
            }
          }

          let sideEffects = args.pluginData?.sideEffects;

          // The import is not in the cache, so resolve it. This may involve
          // fetching the package.json file for the package from the CDN,
          // parsing the package.json to find the entry point of the package,
          // and constructing a full URL to the entry point on the CDN.

          // If path is a bare import like 'react', resolve it to a full URL on a CDN.
          if (isBareImport(args.path)) {
            // Parse the package name (and optionally the version and file/subdirectory)
            const parsed = parsePackageName(argPath);

            let oldPkg: PackageJson = args.pluginData?.pkg ?? {};
            let newPkg: Partial<PackageJson> = Object.assign({}, oldPkg);

            // Are there an dependecies???? Well Goood.
            const depsExists = "dependencies" in oldPkg || 
              "devDependencies" in oldPkg || 
              "peerDependencies" in oldPkg;
            if (depsExists && !/\S+@\S+/.test(argPath)) {
              const {
                devDependencies = {},
                dependencies = {},
                peerDependencies = {}
              } = oldPkg;

              const deps = Object.assign({}, devDependencies, peerDependencies, dependencies);
              const keys = Object.keys(deps);

              if (keys.includes(parsed.name))
                parsed.version = deps[parsed.name];
            }

            let version = "@" + parsed.version;
            let subpath = parsed.path;
            let name = parsed.name;

            try {
              // Here, the code attempts to fetch the package.json file for the package from the CDN.
              // It uses several potential URLs, since the package.json file could be in different locations depending on the package structure.
              // This section also manages a cache of failed package.json fetches to avoid repeating failed requests.
              // All fetched package.json are stored in a virtual file system (VirtualFS) for future use.

              const fileExtension = extname(parsed.path);
              const isDirectory = fileExtension.length === 0;
              const directory = isDirectory ? parsed.path : "";

              // Defines potential package.json locations
              const packageJsonLocations = [
                isDirectory ? `${parsed.name}@${parsed.version}${parsed.path}/package.json` : null,
                `${parsed.name}@${parsed.version}/package.json`
              ];
              const uniquePackageJsonLocations = Array.from(new Set(packageJsonLocations))
                .filter(location => location !== null);  // Filter out null locations

              // Fetch all different package.json files in parallel
              const packageJsonFetches = uniquePackageJsonLocations
                .map(async (packageJsonLocation) => {  // Map each location to a Promise
                  const isSubpathPackageJson = packageJsonLocation === packageJsonLocations[0];
                  const { url } = getCDNUrl(packageJsonLocation, origin);
                  const href = url.toString();

                  if (urlCache.has(href)) {
                    const pkgPath = urlCache.get(href).path;
                    const pkg = virtualFS.get(pkgPath);

                    return { pkg: JSON.parse(pkg), isSubpathPackageJson };
                  }

                  // Send the request and strongly cache package.json files
                  const res = await getRequest(url);
                  if (!res.ok) {
                    // If the request fails, reject the Promise with the URL
                    throw href;
                  }

                  // If successful, parse and cache the JSON response
                  const pkg = await res.json();
                  const pkgPath = "/node_modules" + new URL(res.url).pathname;
                  virtualFS.set(pkgPath, JSON.stringify(pkg))
                  urlCache.set(href, { path: pkgPath })

                  return { pkg, isSubpathPackageJson };
                });

              // Use Promise.allSettled to get results of all fetches
              const results = await Promise.allSettled(packageJsonFetches);

              // Filter out rejected Promises and retrieve their results
              const successfulFetches = results
                .filter(result => result.status === 'fulfilled')
                .map(result => (result as PromiseFulfilledResult<Awaited<typeof packageJsonFetches[0]>>).value);

              if (successfulFetches.length === 0) {
                // If all fetches failed, add all URLs to the FAILED_PKGJSON_URLs set and throw an error
                throw new Error(`All package.json fetches failed`);
              }

              // Use the first successful fetch
              const { pkg, isSubpathPackageJson } = successfulFetches[0];

              version = pkg.version ? "@" + pkg.version : version;
              name = pkg.name ?? name;

              // The following block attempts to resolve the import by trying a number of different methods
              // 1. Modern resolution using the "exports" field in package.json (if it exists)
              // 2. Legacy resolution using other fields in package.json (if "exports" does not exist or fails)
              // 3. Default to the relative path if both modern and legacy resolution fail

              // Start by converting the path to relative
              let relativePath = resolveRelativePath(parsed.path);
              // Assume the path is resolved initially
              let resolvedPath: string | void = parsed.path;

              // Try resolving as a modern import
              let modernResolve = modernImportResolve(pkg, relativePath);

              // If modern resolution succeeded, use it
              if (modernResolve) {
                resolvedPath = Array.isArray(modernResolve) ? modernResolve[0] : modernResolve;
                // If modern resolution failed and it's a subpath with a package.json, try legacy resolution
              } else if (isSubpathPackageJson) {
                let legacyResolve = legacyImportResolve(pkg);

                // If legacy resolution succeeded, use it
                if (legacyResolve) {
                  // Check for any valid values in the resolved package
                  const validValues = Object.values(legacyResolve).filter(x => x);
                  // If there are no valid values, attempt legacy resolution again
                  if (validValues.length <= 0) {
                    legacyResolve = legacyImportResolve(pkg);
                  }

                  // Get the first valid value from the resolved package
                  resolvedPath = getFirstValidValue(legacyResolve);
                }
                // If both resolutions failed, revert to the relative path
              } else {
                resolvedPath = relativePath;
              }

              // If there is a resolved path, remove any leading "./"
              if (resolvedPath && typeof resolvedPath === "string") {
                subpath = resolvedPath.replace(/^(\.\/)/, "/");
              }

              // If it's a directory and a subpath with a package.json, prepend the directory to the subpath
              if (directory && isSubpathPackageJson) {
                subpath = `${directory}${subpath}`;
              }

              sideEffects = pkg.sideEffects;
              newPkg = pkg;
            } catch (e) {
              console.warn(e)
            }

            const deps = Object.assign({}, 
              oldPkg.devDependencies, 
              oldPkg.dependencies, 
              oldPkg.peerDependencies
            );
            const peerDeps = newPkg.peerDependencies ?? {};

            let peerDepsKeys = Object.keys(peerDeps);
            for (const depKey of peerDepsKeys) {
              peerDeps[depKey] = deps[depKey] ?? peerDeps[depKey];
            }

            let pkg = Object.assign({}, newPkg, peerDepsKeys.length > 0 ? { peerDependencies: peerDeps } : null)

            const { url } = getCDNUrl(`${name}${version}${subpath}`, origin);
            const filePath = await fetchAndCacheContent(url, argPath, sideEffects, pkg);

            return {
              path: filePath,
              namespace: 'cdn',
              sideEffects,
              pluginData: {
                sideEffects,
                pkg,
              }
            }
          }

          // If path is a relative or absolute path (like './component' or '/utils'),
          // resolve it relative to the current file's path.

          // If the path is relative and the importer is in node_modules, convert it to a URL and fetch and cache the content
          if (isRelative(args.path) && isNodeModule(args.importer)) {
            // Resolve the path to a full URL on the CDN (we really only want pathname)
            const url = new URL(path.replace(/^\/node_modules/, ""), origin);
            const filePath = await fetchAndCacheContent(url, join(args.resolveDir, argPath), sideEffects, args.pluginData?.pkg);

            return { 
              path: filePath, 
              namespace: 'cdn',
              sideEffects: sideEffects,
              pluginData: args.pluginData
            }
          }
        })

        // Once a URL has been resolved, this block loads the actual content of the file from the CDN,
        // using the virtual file system we set up earlier.
        build.onLoad({ filter: /.*/, namespace: 'cdn' }, async (args) => {
          return {
            contents: virtualFS.get(args.path),  // Content of the file from our virtual file system.
            loader: inferLoader(args.path),  // Use the loader inferred from the file extension.
            resolveDir: dirname(args.path),  // The directory of the file for resolving relative paths.
            pluginData: args.pluginData
          };
        });
      },
    }
  ]
});
console.groupEnd()
