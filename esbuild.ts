import esbuild from "esbuild-wasm";
import { fileURLToPath } from "node:url";
import { join, extname, dirname } from "node:path";

import { resolve, exports, legacy, imports } from "resolve.exports";
import { parse as parsePackageName } from "parse-package-name";

import { getCDNUrl, isBareImport, getCDNStyle, inferLoader } from "./utils.js";
import { determineExtension, getRequest } from "./fetch-and-cache.js";

const dir = dirname(fileURLToPath(import.meta.url));

const config: esbuild.BuildOptions = {
  target: ["esnext"],
  format: "esm",
  bundle: true,
  minify: false,
  treeShaking: false,
  platform: "browser",
  color: true,
  globalName: "BundledCode",
  logLevel: "info",
  sourcemap: false,

  metafile: true,
  loader: {
    ".png": "file",
    ".jpeg": "file",
    ".ttf": "file",
    ".svg": "text",
    ".html": "text",
    ".scss": "css",
  },
  define: {
    __NODE__: `false`,
    "process.env.NODE_ENV": `"production"`,
  },
}
await esbuild.initialize({});


console.group("esbuild-wasm - no plugins")
await esbuild.build({
  ...config,
  entryPoints: [join(dir, "./src/index.ts")],
  outfile: "dist/no-plugin-bundle.js",
});
console.groupEnd()


const RESOLVED_URLs = new Map<string, string>()
const FAILED_PKGJSON_URLs = new Set<string>()

const FileSystem = new Map<string, string>()
const decoder = new TextDecoder()
const encoder = new TextEncoder()

console.group("esbuild-wasm - w/ plugins")
await esbuild.build({
  ...config,
  entryPoints: [join(dir, "./src/index.ts")],
  outfile: "dist/with-plugin-bundle.js",
  plugins: [
    {
      name: "cdn",
      setup(build) {      
        build.onResolve({ filter: /.*/ }, async (args) => {
          // Support a different default CDN + allow for custom CDN url schemes
          const { path: argPath, origin } = getCDNUrl(args.path);
  
          if (isBareImport(args.path)) {
            if (RESOLVED_URLs.has(argPath)) return { path: RESOLVED_URLs.get(argPath), namespace: 'cdn' }
  
            // npm standard CDNs, e.g. unpkg, skypack, esm.sh, etc...
            const NPM_CDN = getCDNStyle(origin) == "npm";
  
            // Heavily based off of https://github.com/egoist/play-esbuild/blob/main/src/lib/esbuild.ts
            const parsed = parsePackageName(argPath);
            let subpath = parsed.path;
  
            let pkg = args.pluginData?.pkg ?? { };
            let oldPkg = pkg;
  
            // Are there an dependecies???? Well Goood.
            const depsExists = "dependencies" in pkg || "devDependencies" in pkg || "peerDependencies" in pkg;
            if (depsExists && !/\S+@\S+/.test(argPath)) {
              const {
                devDependencies = {},
                dependencies = {},
                peerDependencies = {}
              } = pkg;
  
              const deps = Object.assign({}, devDependencies, peerDependencies, dependencies);
              const keys = Object.keys(deps);
  
              if (keys.includes(argPath))
                parsed.version = deps[argPath];
            }
  
            let finalSubpath = subpath;
  
            // If the CDN supports package.json and some other npm stuff, it counts as an npm CDN
            if (NPM_CDN) {
              try {
                const ext = extname(subpath);
                const isDir = ext.length === 0;
                const dir = isDir ? subpath : "";
  
                const pkgVariants = [
                  isDir ? {
                    path: `${parsed.name}@${parsed.version}${subpath}/package.json`,
                    isDir: true
                  } : null,
                  { path: `${parsed.name}@${parsed.version}/package.json` }
                ].filter(x => x !== null);
  
                let isDirPkgJSON = false;
                const pkgVariantsLen = pkgVariants.length;
                for (let i = 0; i < pkgVariantsLen; i++) {
                  const pkgMetadata = pkgVariants[i]!;
                  const { url } = getCDNUrl(pkgMetadata.path, origin);
                  const { href } = url;
  
                  try {
                    if (FAILED_PKGJSON_URLs.has(href) && i < pkgVariantsLen - 1) {
                      continue;
                    }
  
                    // Strongly cache package.json files
                    const res = await getRequest(url, true);
                    if (!res.ok) throw new Error(await res.text());
  
                    pkg = await res.json();
                    isDirPkgJSON = pkgMetadata.isDir ?? false;
  
                    const pkgPath = "/node_modules" + new URL(res.url).pathname;
                    if (!RESOLVED_URLs.has(url.href)) {
                      try {
                        // setFileSystem({
                        //   [pkgPath]: JSON.stringify(pkg)
                        // })
                        FileSystem.set(pkgPath, JSON.stringify(pkg))
                        RESOLVED_URLs.set(url.href, pkgPath)
                      } catch (_e) { }
                    }
                    break;
                  } catch (e) {
                    FAILED_PKGJSON_URLs.add(href);
  
                    // If after checking all the different file extensions none of them are valid
                    // Throw the first fetch error encountered, as that is generally the most accurate error
                    if (i >= pkgVariantsLen - 1)
                      throw e;
                  }
                }
  
                const relativePath = subpath.replace(/^\//, "./");
  
                let modernResolve: ReturnType<typeof resolve> | void;
                let legacyResolve: ReturnType<typeof legacy> | void;
  
                let resolvedPath: string | void = subpath;
  
                try {
                  // Resolving imports & exports from the package.json
                  // If an import starts with "#" then it"s a subpath-import, and should be treated as so
                  modernResolve = resolve(pkg, relativePath, { browser: true, conditions: ["module"] }) ||
                    resolve(pkg, relativePath, { unsafe: true, conditions: ["deno", "worker", "production"] }) ||
                    resolve(pkg, relativePath, { require: true });
  
                  if (modernResolve) {
                    resolvedPath = Array.isArray(modernResolve) ? modernResolve[0] : modernResolve;
                  }
                  // deno-lint-ignore no-empty
                } catch (e) { }
  
                if (!modernResolve) {
                  // If the subpath has a package.json, and the modern resolve didn"t work for it
                  // we can safely use legacy resolve, 
                  // else, if the subpath doesn"t have a package.json, then the subpath is literal, 
                  // and we should just use the subpath as it is
                  if (isDirPkgJSON) {
                    try {
                      // Resolving using main, module, etc... from package.json
                      legacyResolve = legacy(pkg, { browser: true }) ||
                        legacy(pkg, { fields: ["unpkg", "bin"] });
  
                      if (legacyResolve) {
                        // Some packages have `browser` fields in their package.json which have some values set to false
                        // e.g. typescript - > https://unpkg.com/browse/typescript@4.9.5/package.json
                        if (typeof legacyResolve === "object") {
                          const values = Object.values(legacyResolve);
                          const validValues = values.filter(x => x);
                          if (validValues.length <= 0) {
                            legacyResolve = legacy(pkg);
                          }
                        }
  
                        if (Array.isArray(legacyResolve)) {
                          resolvedPath = legacyResolve[0];
                        } else if (typeof legacyResolve === "object") {
                          const legacyResults = legacyResolve;
                          const allKeys = Object.keys(legacyResolve);
                          const nonCJSKeys = allKeys.filter(key => {
                            return !/\.cjs$/.exec(key) && !/src\//.exec(key) && legacyResults[key];
                          });
                          const keysToUse = nonCJSKeys.length > 0 ? nonCJSKeys : allKeys;
                          resolvedPath = legacyResolve[keysToUse[0]] as string;
                        } else {
                          resolvedPath = legacyResolve;
                        }
                      }
                    } catch (e) { }
                  } else resolvedPath = relativePath;
                }
  
                if (resolvedPath && typeof resolvedPath === "string") {
                  finalSubpath = resolvedPath.replace(/^(\.\/)/, "/");
                }
  
                if (dir && isDirPkgJSON) {
                  finalSubpath = `${dir}${finalSubpath}`;
                }
              } catch (e) {
                console.log([`You may want to change CDNs. The current CDN ${!/unpkg\.com/.test(origin) ? `"${origin}" doesn"t` : `path "${origin}${argPath}" may not`} support package.json files.\nThere is a chance the CDN you"re using doesn"t support looking through the package.json of packages. bundlejs will switch to inaccurate guesses for package versions. For package.json support you may wish to use https://unpkg.com or other CDN"s that support package.json.`], "warning");
                console.warn(e);
              }
            }
  
            // If the CDN is npm based then it should add the parsed version to the URL
            // e.g. https://unpkg.com/spring-easing@v1.0.0/
            const version = NPM_CDN ? "@" + (pkg.version || parsed.version) : "";
            const name = `${parsed.name}${version}${finalSubpath}`;
            const { url } = getCDNUrl(name, origin);
  
            const deps = Object.assign({}, oldPkg.devDependencies, oldPkg.dependencies, oldPkg.peerDependencies);
            const peerDeps = pkg.peerDependencies ?? {};
            const peerDepsKeys = Object.keys(peerDeps);
            for (const depKey of peerDepsKeys) {
              peerDeps[depKey] = deps[depKey] ?? peerDeps[depKey];
            }
  
            // Some typescript files don"t have file extensions but you can"t fetch a file without their file extension
            // so bundle tries to solve for that
            let content: Uint8Array | undefined, urlStr: string, ext: string;
            ({ content, url: urlStr, ext } = await determineExtension(url.toString(), false));
  
            const filePath = NPM_CDN ? "/node_modules" + new URL(urlStr).pathname : "/node_modules/" + name + ext;
            if (content) {
              try {
                const priorArt = RESOLVED_URLs.has(argPath);
                if (!priorArt) {
                  // setFileSystem({
                  //   [filePath]: decode(content)
                  // })
                  FileSystem.set(filePath, decoder.decode(content))
                  RESOLVED_URLs.set(argPath, filePath)
                }
  
                return { path: filePath, namespace: 'cdn' }
              } catch (_e) { }
            }
          } else if (args.path[0] === "." && /^\/node_modules/.test(args.importer)) {
            const path = join(args.resolveDir, argPath);
            if (RESOLVED_URLs.has(path)) return { path: RESOLVED_URLs.get(path), namespace: 'cdn' }
            const url = new URL(path.replace(/^\/node_modules/, ""), origin);
  
            // Some typescript files don"t have file extensions but you can"t fetch a file without their file extension
            // so bundle tries to solve for that
            let content: Uint8Array | undefined, urlStr: string;
            ({ content, url: urlStr } = await determineExtension(url.href, false));
  
            const filePath = "/node_modules" + new URL(urlStr).pathname;
            if (content) {
              try {
                const priorArt = RESOLVED_URLs.has(path);
                if (!priorArt) {
                  // setFileSystem({
                  //   [filePath]: decode(content)
                  // })
                  FileSystem.set(filePath, decoder.decode(content))
                  RESOLVED_URLs.set(path, filePath)
                } 
  
                return { path: filePath, namespace: 'cdn' }
              } catch (_e) { }
            }
          }
  
          return undefined
        })
  
        // When a URL is loaded, we want to actually download the content
        // from the internet. This has just enough logic to be able to
        // handle the example import from https://cdn.esm.sh/ but in reality this
        // would probably need to be more complex.
        build.onLoad({ filter: /.*/, namespace: 'cdn' }, async (args) => {
            return {
              contents: FileSystem.get(args.path),
              loader: inferLoader(args.path),
              resolveDir: dirname(args.path),
            };
        });

      },
    }
  ]
});
console.groupEnd()