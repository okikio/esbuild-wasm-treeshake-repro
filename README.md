# esbuild-wasm-treeshake-repro
esbuild-wasm treeshake reproduction. esbuild isn't able to treeshake quite as well when using plugins https://github.com/evanw/esbuild/issues/3129

> This is a very simplified repro with a bunch of edge cases intentionally not being covered
> This stuff can get really complicated, so a simple but practical example should be able to display everything I'm talking about

## Setup Deno

You'll need to install https://deno.land

```sh
curl -fsSL https://deno.land/x/install/install.sh | sh &&
export DENO_INSTALL="/home/node/.deno" &&
export PATH="$DENO_INSTALL/bin:$PATH"
```

Or

```sh
npm run install-deno
```

> `Node.js` doesn't like the high amount of concurrent requests and tends to give 502 errors `Deno` doesn't seem to have this issue, so I'm going with `Deno`

## Running Repro

Just run `npm start`