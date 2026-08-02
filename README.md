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

### Option 1: make this dependency work after bundling

CanvasKit or a build transform could avoid the free CommonJS `__dirname`
reference in Worker-targeted output. Wrangler or Vite could also inject a
module-specific `__dirname` and `__filename` into each bundled CommonJS wrapper.
That can be automatic, but the virtual paths are useful only if any referenced
files are also emitted at matching locations. A Worker-specific CanvasKit
export could instead avoid selecting its Node file-loading path. These are
smaller fixes for CanvasKit or wrapper globals, but they do not make general npm
CommonJS dependencies use workerd's new module registry.

No workerd change would be needed for this option because the output would
remain an ES module and would no longer expect CommonJS wrapper bindings.

### Option 2: preserve CommonJS boundaries for the runtime

To use the new module registry, the build tool must preserve dependencies that
need CommonJS behavior as separate runtime modules instead of embedding them in
an ES-module chunk. This requires the build tool to:

1. Resolve npm package exports and the dependency graph at build time.
2. Classify each preserved file as ESM, CommonJS, JSON, Wasm, or another
   runtime module type supported by workerd.
3. Give each emitted file a stable runtime path. The tool can preserve a layout
   compatible with existing relative specifiers or rewrite specifiers to the
   emitted paths.
4. Upload CommonJS source as `commonJsModule`. CanvasKit only needs its default
   export. Named imports need either a small generated ESM wrapper or a
   transport path for workerd's existing `namedExports` metadata.
5. Use the same graph and module classifications in development, preview, and
   deployment.

The build tool must still perform npm resolution. workerd resolves names among
the modules registered in the Worker bundle; it is not given a host
`node_modules` directory and should not independently repeat npm's package
resolution algorithm.

A proposed UX would not require a second user opt-in. `new_module_registry` is
already an explicit compatibility flag, so Wrangler and the Vite plugin could
use it as the signal to construct a mixed ESM and CommonJS graph automatically.

Preserving every reachable CommonJS module would match CommonJS runtime
semantics most closely. A narrower first implementation could preserve modules
that reference CommonJS wrapper bindings such as `__dirname` or `__filename`,
or that use `require()` in ways the normal bundle cannot represent. Either
policy could avoid asking users to list affected packages.

Static imports and static `require()` calls can be found at build time. Assets
can be included when they are imported or matched by explicit module rules;
arbitrary strings passed to filesystem APIs are not reliable dependency edges.
Computed `require()` calls and computed filesystem paths cannot always be
predicted. A build tool could include every published file from an affected
package as a fallback, at the cost of a larger upload. Optional include and
exclude controls would still be useful when the complete runtime file set
cannot be determined automatically.

### Wrangler changes

Wrangler already has most of the upload machinery. Its `CommonJS` rules,
`find_additional_modules`, `base_dir`, and `preserve_file_names` options can
discover and upload matching files from a staged source tree. The control in
this repository demonstrates the `CommonJS` rule and upload path. These options
do not preserve a package import such as `canvaskit-wasm`. The default path asks
esbuild for an ESM bundle, so esbuild embeds CanvasKit in its own CommonJS
interoperability wrapper.

Wrangler is missing automatic npm-aware preservation. When
`new_module_registry` is enabled, it would resolve package imports and export
conditions, follow dependencies of those packages, assign stable runtime paths,
keep the CommonJS modules out of the esbuild bundle, and pass them to the
existing CommonJS upload path. `wrangler dev` and `wrangler deploy` must produce
the same graph.

The proposed default under the compatibility flag would not require a package
list. Wrangler may still need diagnostics or optional include and exclude
controls for packages with computed dependencies, large file sets, native
addons, or other Node-specific behavior.

Named imports from CommonJS need one additional choice. Wrangler can generate
small ESM wrappers that read properties from the CommonJS default export, or
Workers SDK and the deployment transport can be extended to carry statically
detected names into workerd's existing `namedExports` field. CanvasKit uses a
default import, so this reproduction does not require either change.

Relevant implementation points in the pinned release are Wrangler's
[`bundleWorker()`](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.118.0/packages/wrangler/src/deployment-bundle/bundle.ts),
which uses ESM output for module Workers, and its
[`module-collection`](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.118.0/packages/wrangler/src/deployment-bundle/module-collection.ts),
which already represents separately supplied CommonJS files.

### Cloudflare Vite plugin changes

The Vite plugin currently keeps Worker dependencies inside Vite's transform
pipeline. In production it generates a no-bundle Wrangler configuration that
[classifies emitted `.js` and `.mjs` files as `ESModule`](https://github.com/cloudflare/workers-sdk/blob/%40cloudflare%2Fvite-plugin%401.50.0/packages/vite-plugin-cloudflare/src/plugins/output-config.ts).
Its [additional-module support](https://github.com/cloudflare/workers-sdk/blob/%40cloudflare%2Fvite-plugin%401.50.0/packages/vite-plugin-cloudflare/src/plugins/additional-modules.ts)
covers compiled Wasm, data, and text, but not CommonJS.

The plugin should use the same `new_module_registry` compatibility flag rather
than require a separate Vite package list. It would need to:

1. Exclude automatically preserved CommonJS files from Vite dependency
   optimization and CommonJS-to-ESM conversion.
2. Resolve and emit the classified transitive graph with stable virtual names;
   only its CommonJS files should be emitted as `.cjs`.
3. Add appropriate rules for the emitted module types to the generated
   production Wrangler configuration, including a `CommonJS` rule for `.cjs`
   files instead of classifying them as ESM.
4. Register CommonJS files as `commonJsModule` responses and preserve the other
   classified types through the Workers SDK/Miniflare module graph during
   development instead of evaluating all transformed bodies through Vite's
   module runner.
5. Restart or invalidate the runtime module graph when a preserved file
   changes.
6. Use the same ESM-facade or `namedExports` transport decision as Wrangler
   for packages consumed through named imports.

Vite already resolves and classifies dependencies during optimization and
production builds. It can retain a runtime CommonJS boundary when needed
instead of always converting the module to Vite's ESM execution path.

### Required workerd changes

None are required to fix this `__dirname` failure once Wrangler or Vite sends
CanvasKit as `commonJsModule`. workerd already supplies the correct CommonJS
context, resolves registered CommonJS dependencies, handles circular
dependencies, and supports declared named exports.

workerd could reduce the amount of build-tool work by adding npm package
resolution, CommonJS named-export inference, or richer module-fallback
behavior. None is required to fix this failure.

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
