# CanvasKit `__dirname` reproduction with workerd's new module registry

This repository shows that importing `canvaskit-wasm` into a Cloudflare Worker
fails with both the Cloudflare Vite plugin and Wrangler's built-in bundler:

```text
ReferenceError: __dirname is not defined
    at CanvasKitInit (.../canvaskit-wasm/bin/canvaskit.js:157:45)
```

The Worker enables `nodejs_compat` and `new_module_registry`. The new registry
does provide `__dirname` to runtime CommonJS modules, but neither build tool
sends CanvasKit to workerd as CommonJS. They transform or bundle it into an ES
module, where `__dirname` is correctly undefined.

## Reproduce

You need Node.js 22.12.0 or later.

```sh
npm ci
npm run repro
```

The script tests Vite, Wrangler, and a no-bundle CommonJS control against the
same pinned Wrangler and workerd versions. Expected output:

```text
Vite: reproduced with HTTP 500
Wrangler: reproduced with HTTP 500
workerd CommonJS control: __dirname is /bundle
Vite and Wrangler reproduced the failure; the runtime CommonJS control passed.
```

The repository pins `canvaskit-wasm` 0.41.1, `@cloudflare/vite-plugin` 1.50.0,
Vite 8.2.0, Wrangler 4.118.0, and workerd 1.20260730.1. It uses compatibility
date `2026-08-02` with `nodejs_compat` and `new_module_registry`.

## Try the proposed fix

PR [cloudflare/workers-sdk#14982](https://github.com/cloudflare/workers-sdk/pull/14982)
proposes a fix for this issue in Wrangler and the Cloudflare Vite plugin. You
can try its preview builds with:

```sh
npm run demo:preview
```

The command uses the same checkout, configuration, and Worker source for both
runs. It:

1. Installs the stable versions pinned in `package-lock.json`.
2. Reproduces `__dirname is not defined` with Wrangler and the Vite plugin.
3. Installs both previews from PR #14982 without modifying the package files.
4. Exercises Wrangler artifact and development modes plus Vite artifact,
   development, and preview modes.
5. Confirms the fixture sees `__dirname = "cjs-validation-fixture"` and
   `__filename = "index.js"`, and that the unchanged CanvasKit Worker gets past
   its `__dirname` access.

The equivalent manual preview install is:

```sh
npm ci
npm run repro
npm run validate:baseline
npm install --no-save --package-lock=false \
  https://pkg.pr.new/wrangler@14982 \
  https://pkg.pr.new/@cloudflare/vite-plugin@14982
npm run validate
```

The demo leaves the previews in `node_modules` for inspection. Run `npm ci` to
restore the pinned stable releases.

## Validate proposed fixes

The repository also contains an npm CommonJS fixture that uses `__dirname`,
`__filename`, relative `require()`, JSON, a Node built-in, a cycle, and default
and named ESM imports. The fixture has its own Worker configuration so it does
not interfere with the CanvasKit reproduction.

Confirm that the pinned releases exhibit the broken baseline:

```sh
npm run validate:baseline
```

To test a Workers SDK change, build and install the proposed Wrangler and
`@cloudflare/vite-plugin` packages into this repository, then run:

```sh
npm run validate
```

The command validates:

1. Wrangler's dry-run output keeps the fixture outside the entry ES module.
2. Vite's production output keeps the fixture separate and emits a `CommonJS`
   module rule.
3. Wrangler development, Vite development, and Vite preview preserve CommonJS
   runtime semantics.
4. Both tools get CanvasKit past its `__dirname` failure. Its later dynamic-Wasm
   failure is allowed because that is outside this reproduction's scope.

`npm run validate` is expected to fail with the pinned releases. The definitive
Wrangler unit test should additionally inspect the deployment multipart form and
assert that the preserved source uses the `application/javascript` CommonJS MIME
type; dry-run output does not retain that upload metadata.

## Why it fails

`__dirname` is local to Node.js CommonJS wrappers; it is not a JavaScript global
and is not defined in ES modules. CanvasKit detects the Node-compatible
`process` provided by `nodejs_compat`, enters its Node path, and evaluates
`__dirname + "/"`.

| Path | What workerd receives | Result |
| --- | --- | --- |
| Vite development | CanvasKit evaluated through Vite's module runner | `__dirname` is undefined |
| Vite production | CanvasKit embedded in an ES module | `__dirname` is undefined |
| Wrangler | CanvasKit in an esbuild wrapper inside an ES module | `__dirname` is undefined |
| CommonJS control | `control/module.cjs` registered as CommonJS | `__dirname === "/bundle"` |

The uploaded module list is a type manifest. Once a build tool folds CanvasKit
into an ES module, workerd has no CommonJS boundary at which to create the
`__dirname` binding. The registry cannot recover a boundary removed during the
build, nor should it expose CommonJS wrapper variables as ES-module globals.

The control confirms that workerd's behavior is correct for the modules it
receives: `wrangler.control.jsonc` uses `no_bundle` and a `CommonJS` module rule,
and the same runtime supplies that module with `__dirname === "/bundle"`.

## What should change

Wrangler and the Cloudflare Vite plugin should preserve statically reachable npm
CommonJS modules as runtime `commonJsModule` entries. Packages such as CanvasKit
should not require Worker-specific source changes, package allowlists, or
low-level module rules.

Both tools should:

1. Resolve and classify reachable npm files as ESM, CommonJS, JSON, Wasm,
   text, or data.
2. Keep CommonJS files out of ES-module chunks and preserve package-relative
   paths where possible.
3. Rewrite static module edges and create small ESM wrappers where CommonJS
   named imports require them.
4. Preserve the same module boundaries and types in development, preview, and
   deployment.

Preserving reachable CommonJS boundaries is more reliable than scanning for
`__dirname`: dependencies can also rely on `require`, `module`, `exports`,
cycles, and package-relative paths.

### Wrangler

Wrangler currently asks esbuild for ESM output, which embeds CanvasKit in an
internal CommonJS wrapper inside the Worker ES module. When
`new_module_registry` is enabled, Wrangler should instead:

1. Identify reachable CommonJS files before esbuild bundles them.
2. Keep discovered CommonJS files out of the ESM bundle.
3. Add those files to its existing `CfModule[]` upload list as `commonjs`.

Wrangler must preserve those module boundaries in `wrangler dev`, deployment,
dry runs, and remote development. A normal import should be all the developer
writes:

```js
import CanvasKitInit from "canvaskit-wasm";
```

### Cloudflare Vite plugin

Vite must preserve CommonJS boundaries in each execution mode:

1. In development, classify CommonJS before dependency optimization converts
   it to ESM, then serve it to Miniflare as `commonJsModule` through module
   fallback.
2. In production, emit preserved CommonJS files separately and retain their
   real type in the generated Wrangler configuration or Build Output manifest.
3. In preview, use the same module boundaries and types as the deployed output.

This path should be activated by `new_module_registry`, not Vite-specific
`optimizeDeps`, `ssr.noExternal`, or package-list configuration.

### workerd

No workerd change is required for this failure. It already creates the correct
CommonJS context when tooling registers a module as `commonJsModule`. npm
resolution and module classification remain build-tool responsibilities;
workerd should execute the module types it receives.

## Scope

This reproduction stops at CanvasKit's first startup failure. Preserving its
CommonJS boundary fixes `__dirname`, but CanvasKit next tries to load and
dynamically compile `canvaskit.wasm`. Workers disallow dynamic Wasm compilation,
so a complete integration must import the Wasm as a precompiled
`WebAssembly.Module` and provide CanvasKit's `instantiateWasm` hook. That is a
separate issue from module classification.

`new_module_registry` remains experimental in the pinned workerd release. This
repository tests its local behavior and does not claim production support.
