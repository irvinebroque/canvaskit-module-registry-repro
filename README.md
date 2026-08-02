# CanvasKit `__dirname` reproduction with workerd's new module registry

This repository shows that `__dirname` remains undefined when you import
`canvaskit-wasm` into a Cloudflare Worker, even when you enable workerd's
`new_module_registry` compatibility flag.

The reproduction covers both build paths commonly used for Workers:

- Vite with `@cloudflare/vite-plugin`
- Wrangler's built-in bundler

Both paths fail with:

```text
ReferenceError: __dirname is not defined
    at CanvasKitInit (.../canvaskit-wasm/bin/canvaskit.js:157:45)
```

In short, `new_module_registry` makes `__dirname` available to runtime CommonJS
modules. It does not rewrite bundled dependency code or add `__dirname` to ES
modules. Vite and Wrangler therefore expose the same failure.

This is not evidence that the module registry's CommonJS support is broken.
Neither tool registers CanvasKit as a runtime CommonJS module, so workerd has no
CommonJS boundary at which to create the `__dirname` binding.

## What happens

CommonJS and ECMAScript modules (ESM) run with different local variables.
Node.js gives every CommonJS module its own `__dirname`; ESM does not receive
one. A bundler combines and transforms source files before sending them to the
runtime.

In this reproduction, neither build tool registers CanvasKit as a runtime
CommonJS module. Wrangler and Vite production embed it in ES-module output.
Vite development transforms it and evaluates it through Vite's module runner.

| Path | What workerd receives | Result |
| --- | --- | --- |
| Vite development | CanvasKit code evaluated by Vite's module runner | `__dirname` is undefined |
| Vite production | CanvasKit code inside an ES module | `__dirname` is undefined |
| Wrangler | CanvasKit code inside an esbuild wrapper inside an ES module | `__dirname` is undefined |
| CommonJS control | `control/module.cjs` as a separate CommonJS module | `__dirname === "/bundle"` |

For production and Wrangler, the uploaded module list acts as a type manifest.
Once a build tool folds CanvasKit into an ES module, the manifest no longer
contains a separate CommonJS entry where workerd could provide `__dirname`.
Vite development reaches the same failure by evaluating transformed code
instead of registering CanvasKit with workerd as CommonJS.

## Versions

This repository pins the versions used to reproduce the problem:

| Package | Version |
| --- | ---: |
| `canvaskit-wasm` | `0.41.1` |
| `@cloudflare/vite-plugin` | `1.50.0` |
| `vite` | `8.2.0` |
| `wrangler` | `4.118.0` |
| `workerd` | `1.20260730.1` |

The Worker uses compatibility date `2026-08-02` and enables both
`nodejs_compat` and `new_module_registry` in `wrangler.jsonc`. The automated
Wrangler runs pass `--no-latest`; without it, Wrangler development defaults to
today's compatibility date and overrides the date in `wrangler.jsonc`.

## Automated reproduction

You need Node.js 22.12.0 or later.

```sh
npm ci
npm run repro
```

The script starts each development server, sends one request, verifies the
result, and stops the server. It also runs a no-bundle CommonJS control to prove
that the same workerd version defines `__dirname` when Wrangler registers a file
as a runtime CommonJS module. Successful output looks like:

```text
Vite: reproduced with HTTP 500
Wrangler: reproduced with HTTP 500
workerd CommonJS control: __dirname is /bundle
Vite and Wrangler reproduced the failure; the runtime CommonJS control passed.
```

## Manual reproduction with Vite

Start the Cloudflare Vite development server:

```sh
npm run dev:vite
```

Send a request from another terminal:

```sh
curl --include http://127.0.0.1:5173/
```

The Worker returns HTTP 500 with `ReferenceError: __dirname is not defined`.

You can also build and preview Vite's production output:

```sh
npm run build:vite
npx vite preview
```

The preview returns the same HTTP 500. The generated
`dist/canvaskit_module_registry_repro/index.js` file retains CanvasKit's
`__dirname` reference.

## Manual reproduction with Wrangler

Start Wrangler directly, without the Vite plugin:

```sh
npm run dev:wrangler
```

Send a request from another terminal:

```sh
curl --include http://127.0.0.1:8787/
```

The Worker returns the same HTTP 500 and `ReferenceError`.

You can inspect Wrangler's generated bundle without deploying it:

```sh
npm run build:wrangler
```

The output in `dist-wrangler/index.js` still contains CanvasKit's reference to
`__dirname`.

## Detailed failure path

`__dirname` is not a JavaScript global, and Node.js does not define it in ES
modules. Node.js creates `__dirname` as a local value inside the wrapper that it
uses to evaluate each CommonJS module.

workerd follows the same model. The new module registry supports `__dirname`
for source files that reach the runtime as CommonJS modules. In the pinned
workerd release, its
[`CommonJsModuleContext`](https://github.com/cloudflare/workerd/blob/v1.20260730.1/src/workerd/api/commonjs.h)
provides `module`, `exports`, `require`, `__filename`, and `__dirname`. The
runtime's [new module registry fixture](https://github.com/cloudflare/workerd/blob/v1.20260730.1/src/workerd/api/tests/new-module-registry-test.wd-test)
registers source as `commonJsModule`, and its
[test](https://github.com/cloudflare/workerd/blob/v1.20260730.1/src/workerd/api/tests/new-module-registry-test.js#L97-L113)
confirms that it receives `__dirname === "/bundle"`.

CanvasKit does not reach workerd as a separate CommonJS module:

1. `canvaskit-wasm` publishes `bin/canvaskit.js` as the entry for both its
   `import` and `require` export conditions.
2. Vite and Wrangler process that file before workerd evaluates the Worker.
3. Wrangler and Vite production embed CanvasKit in ES-module output. Vite
   development evaluates transformed CanvasKit code through its module runner.
   None of these paths registers CanvasKit as a `commonJsModule`.
4. CanvasKit detects the Node-compatible `process` that `nodejs_compat`
   provides, enters its Node code path, and evaluates
   `__dirname + "/"`.
5. The surrounding Worker module is an ES module, so it has no CommonJS wrapper
   and no local `__dirname` binding.

The module registry only knows the type of each module in the uploaded Worker
bundle. It cannot recover a CommonJS boundary that a build tool removed, and it
does not make CommonJS wrapper variables global. Defining `__dirname` globally
would also differ from Node.js ES-module behavior.

## Is workerd's behavior correct?

Yes, for the module graph that it receives.

The runtime's [Worker module schema](https://github.com/cloudflare/workerd/blob/v1.20260730.1/src/workerd/server/workerd.capnp)
requires each uploaded JavaScript module to be identified as either `esModule`
or `commonJsModule`. The new registry creates a `CommonJsModuleContext` only for
the latter. Defining CommonJS wrapper values in an `esModule` would be unlike
Node.js and could give unrelated ES modules an ambiguous `__dirname`.

The control uses `wrangler.control.jsonc` with `no_bundle: true` and a
`CommonJS` module rule. It runs against the same pinned Wrangler and workerd as
the failing cases. The flag and runtime implementation work when the build tool
supplies the correct module type.

## What should change?

Wrangler and the Cloudflare Vite plugin should preserve npm CommonJS boundaries
automatically. Packages such as CanvasKit should not need Worker-specific source
changes, and developers should not need to stage package files, write module
rules, or list affected packages.

While the new registry is experimental, `new_module_registry` can be the only
switch. Once the registry becomes the default, this behavior can require no
configuration. If changing bundling under the compatibility flag is too broad
for an initial rollout, the fallback should be one high-level Wrangler or Vite
option that enables automatic CommonJS preservation for the whole dependency
graph. It should not expose the low-level upload rules or require a package
allowlist.

### Shared Workers SDK module graph

Wrangler and the Vite plugin need a shared npm module-graph implementation with
adapters for esbuild and Vite. For every statically reachable dependency, it
should:

1. Resolve npm export conditions separately for `import` and `require()`.
2. Classify each file as ESM, CommonJS, JSON, Wasm, text, or data.
3. Preserve every reachable CommonJS file as a runtime `commonJsModule`, rather
   than embedding it in an ES-module chunk.
4. Preserve package-relative paths where possible and rewrite static specifiers
   when needed so every edge points to an uploaded module.
5. Resolve or rewrite static `require.resolve()` calls during the build because
   workerd's CommonJS context does not currently expose `require.resolve`.
6. Generate small ESM wrappers when ESM code uses statically detected CommonJS
   named exports. Default imports can target `commonJsModule` directly.
7. Emit the same typed graph in development, preview, and deployment.

workerd supports JSON modules, but the pinned Workers SDK
[`CfModule` type](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.118.0/packages/workers-utils/src/worker.ts)
has no JSON transport type and
[Vite preview currently maps JSON Build Output to data](https://github.com/cloudflare/workers-sdk/blob/%40cloudflare%2Fvite-plugin%401.50.0/packages/vite-plugin-cloudflare/src/miniflare-options.ts).
The shared graph therefore also needs either end-to-end JSON transport support
or generated JavaScript wrappers for JSON dependencies.

Preserving all reachable CommonJS files is more reliable than scanning only for
`__dirname`. A scan can miss generated code, transitive CommonJS modules,
cycles, and other CommonJS behavior. Once the tool must build the dependency
closure, preserving that closure gives workerd the module boundaries it was
designed to execute.

workerd should continue to resolve names inside the uploaded graph. npm export
resolution belongs in Workers SDK, where it can use the same conditions,
aliases, and package layout as the build tool.

### Wrangler changes

Wrangler's existing module rules and additional-module collector prove that it
can upload a file as CommonJS. The control uses those internals only to validate
workerd. They are not the proposed developer workflow.

Today, Wrangler's [`bundleWorker()`](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.118.0/packages/wrangler/src/deployment-bundle/bundle.ts)
asks esbuild for ESM output, so esbuild embeds CanvasKit in an internal CommonJS
wrapper. Wrangler should instead run the shared npm graph when
`new_module_registry` is enabled, keep discovered CommonJS files out of the ESM
bundle, and add them automatically to its existing `CfModule[]` upload list.
That [list already supports the `commonjs` type](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.118.0/packages/workers-utils/src/worker.ts).

The same graph builder must drive `wrangler dev`, `wrangler deploy`, dry runs,
and remote development. Developers should still write only the normal import:

```js
import CanvasKitInit from "canvaskit-wasm";
```

No `no_bundle`, `find_additional_modules`, `base_dir`, `rules`, or
`preserve_file_names` setting should be required.

For ESM named imports from CommonJS, generated ESM wrappers are the least
invasive first implementation. workerd has `namedExports` metadata, but the
pinned Workers SDK upload type does not currently carry it. CanvasKit uses only
a default import.

### Cloudflare Vite plugin changes

The Vite plugin currently keeps Worker dependencies inside Vite's transform
pipeline. In production it generates a no-bundle Wrangler configuration that
[classifies emitted `.js` and `.mjs` files as `ESModule`](https://github.com/cloudflare/workers-sdk/blob/%40cloudflare%2Fvite-plugin%401.50.0/packages/vite-plugin-cloudflare/src/plugins/output-config.ts).
Its [additional-module support](https://github.com/cloudflare/workers-sdk/blob/%40cloudflare%2Fvite-plugin%401.50.0/packages/vite-plugin-cloudflare/src/plugins/additional-modules.ts)
covers compiled Wasm, data, and text, but not CommonJS.

Vite development and production need different adapters over the same graph:

1. In development, classify CommonJS before dependency optimization converts
   it to ESM. Vite's module runner should reference a canonical bundle URL, and
   Miniflare's existing V2 module-fallback service should return the source as
   `commonJsModule`. The
   [Vitest pool fallback](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.118.0/packages/vitest-pool-workers/src/pool/module-fallback.ts)
   already contains npm resolution, CommonJS classification, named-export
   detection, and ESM-wrapper logic that can serve as a blueprint. That logic
   uses the older fallback protocol and must be adapted to
   [Miniflare's V2 POST request format](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.118.0/packages/miniflare/src/plugins/core/module-fallback.ts)
   and canonical `/bundle` module names.
2. In production, emit preserved CommonJS files as `.cjs`, emit ESM wrappers
   for ESM consumers, and record each file's real type in the generated
   Wrangler configuration or Build Output manifest.
3. In preview, run the built typed graph rather than the development fallback,
   so preview matches deployment.
4. Restart the development runtime when a preserved module changes.

The plugin should activate this path from `new_module_registry`, not from a
Vite-specific package list. Developers should not need to configure
`optimizeDeps`, `ssr.noExternal`, or module rules.

### Limits of automatic discovery

Static imports, literal dynamic imports, and static `require()` calls can be
included automatically. Imported assets and files matched by known module types
can also be included. Computed `require()` calls, computed filesystem paths,
runtime plugin discovery, and optional dependencies cannot always be determined
from a production build. Native addons are unsupported by workerd and should
produce a build error.

For an opaque `__dirname`-based file lookup, tooling can conservatively include
the package's published files and warn about the upload cost. If it still cannot
construct a deployment-equivalent graph, it should report the unsupported edge
instead of allowing development to succeed with a module that deployment omits.
Advanced include or exclude controls may help with these cases, but they should
not be part of the ordinary path.

### Required workerd changes

None are required to fix this `__dirname` failure once Wrangler or Vite sends
CanvasKit as `commonJsModule`. workerd already supplies the correct CommonJS
context, resolves registered CommonJS dependencies, handles circular
dependencies, and supports declared named exports.

The V2 module-fallback service is useful for Vite development, but production
still needs a complete uploaded graph. npm resolution and ESM wrappers can be
implemented in Workers SDK without changing workerd. Future workerd support for
named-export inference could remove some generated wrappers, but it is not
required for CanvasKit's default import.

Preserving CanvasKit as CommonJS fixes only this first exception. CanvasKit's
default Node path next expects to locate and read `canvaskit.wasm` as a file.
The pinned workerd does [expose uploaded modules read-only under `/bundle`](https://github.com/cloudflare/workerd/blob/v1.20260730.1/src/workerd/io/worker-fs.h),
so CanvasKit could read the bytes if the build also emitted the Wasm at the
expected adjacent path. Reading the bytes is not sufficient: normal Workers
[disallow dynamic Wasm compilation](https://github.com/cloudflare/workerd/blob/v1.20260730.1/src/workerd/jsg/setup.c%2B%2B#L579-L584),
which CanvasKit's default
`WebAssembly.instantiate(bytes, imports)` path requires. The application,
CanvasKit, or build integration must import the Wasm as a precompiled
`WebAssembly.Module` and provide CanvasKit's `instantiateWasm` hook. This is a
separate CanvasKit integration issue.

## CanvasKit code path

CanvasKit first identifies the environment as Node-compatible:

```js
var isNode =
  typeof process === "object" &&
  typeof process.versions === "object" &&
  typeof process.versions.node === "string";
```

It later uses `__dirname` in that branch:

```js
if (isNode) {
  scriptDirectory = __dirname + "/";
}
```

Enabling `nodejs_compat` makes the first check true, but it does not turn an ES
module into a CommonJS module. The second statement therefore throws.

## Scope and status

This repository stops at the first CanvasKit startup failure. It does not test
the later WebAssembly integration described above.

workerd still [marks `new_module_registry` as experimental](https://github.com/cloudflare/workerd/blob/v1.20260730.1/src/workerd/io/compatibility-date.capnp).
This repository uses it in local development to test its behavior. It does not
claim that Cloudflare supports the flag for production Workers.

## Repository layout

```text
.
|-- control/                # Runtime CommonJS control module and Worker
|-- scripts/repro.mjs       # Runs and verifies both reproduction paths
|-- src/index.js            # Minimal Worker that calls CanvasKitInit()
|-- vite.config.js          # Cloudflare Vite plugin configuration
|-- wrangler.control.jsonc  # No-bundle CommonJS control configuration
`-- wrangler.jsonc          # Shared Worker compatibility configuration
```
