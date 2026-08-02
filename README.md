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

This is not evidence that the module registry's CommonJS support is broken. The
build tools bundle CanvasKit into an ES module before workerd sees it, so there
is no runtime CommonJS module boundary at which workerd could create the
CommonJS-only `__dirname` binding.

## Expected and actual behavior

You might expect the new module registry's CommonJS support to provide
`__dirname` to CanvasKit. Instead, CanvasKit runs inside an ES-module boundary
created by the build tool, and the request fails before CanvasKit loads its
WebAssembly module.

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

## Why the new module registry does not define `__dirname`

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

That support does not apply to this reproduction because CanvasKit does not
reach workerd as a separate CommonJS module:

1. `canvaskit-wasm` publishes `bin/canvaskit.js` as the entry for both its
   `import` and `require` export conditions.
2. Vite and Wrangler process that file before workerd evaluates the Worker.
3. Each tool transforms CanvasKit for CommonJS interop and passes the result to
   workerd as part of an ES-module graph. Neither tool uploads CanvasKit as a
   `commonJsModule` runtime module.
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

This repository validates both sides of that boundary:

| Input received by workerd | Result |
| --- | --- |
| CanvasKit embedded by Vite in an ES-module output | `__dirname` is undefined |
| CanvasKit embedded by Wrangler in an esbuild CommonJS shim inside an ES-module output | `__dirname` is undefined |
| `control/module.cjs` uploaded separately as CommonJS | `__dirname === "/bundle"` |

The control uses `wrangler.control.jsonc` with `no_bundle: true` and a
`CommonJS` module rule. It runs against the same pinned Wrangler and workerd as
the failing cases. This demonstrates that the flag and runtime implementation
work; the distinction is the module type supplied by the build tool.

## What should change?

There are two valid solution directions, depending on the intended scope.

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

To use the new module registry as intended, the build tool must preserve
CommonJS dependencies that require runtime CommonJS semantics as separate
runtime modules instead of embedding their bodies in an ES-module chunk. A
complete implementation needs to:

1. Resolve npm package exports and the dependency graph at build time.
2. Classify each preserved file as ESM, CommonJS, JSON, Wasm, or another
   supported runtime module type.
3. Give each emitted file a stable virtual bundle name and rewrite its import
   and `require()` specifiers to names that exist in the uploaded graph.
4. Upload CommonJS source as `commonJsModule`. CanvasKit only needs its default
   export. General named imports additionally need generated ESM facades or a
   transport path for workerd's existing `namedExports` metadata.
5. Use the same graph and module classifications in development, preview, and
   deployment.

The build tool must still perform npm resolution. workerd resolves names among
the modules registered in the Worker bundle; it is not given a host
`node_modules` directory and should not independently repeat npm's package
resolution algorithm.

This does not inherently require another user opt-in. `new_module_registry` is
already an explicit compatibility flag, and Wrangler and the Vite plugin can
use that flag as the signal to construct a mixed runtime module graph
automatically.

The most semantically faithful automatic policy would preserve every reachable
CommonJS module when the flag is enabled. A less disruptive policy could
preserve only modules that use free CommonJS wrapper bindings such as
`__dirname` or `__filename`, or use `require()` in ways that cannot be
represented safely by the normal bundle. Either policy can make the `__dirname`
binding itself work without asking users to list affected packages.

There are limits to what can work automatically. Static imports, static
`require()` calls, and literal module-relative asset paths can be discovered and
uploaded. Arbitrary computed `require()` calls and filesystem paths cannot
always be known at build time. Tooling can include an affected package's full
published file set as a compatibility fallback, but that increases upload size
and can still encounter unsupported Node APIs. An escape hatch may therefore be
useful, but it should not be required for ordinary statically discoverable
packages.

### Wrangler changes

Wrangler already has most of the final transport machinery. Its `CommonJS`
rules, `find_additional_modules`, `base_dir`, and `preserve_file_names` options
can discover and upload matching files from a staged source tree, as the
control demonstrates. They do not make a bare npm import such as
`canvaskit-wasm` become a separate runtime module. The default bundled path
instead asks esbuild for an ESM bundle, and esbuild embeds CanvasKit in an
internal CommonJS interoperability wrapper.

The narrow missing Wrangler feature is automatic npm-aware preservation when
`new_module_registry` is enabled. Wrangler would resolve bare packages and
their export conditions, walk their transitive dependencies, assign stable
bundle names, externalize the CommonJS modules from esbuild, and feed the
resulting files into its existing additional module collection and CommonJS
upload path. This must work identically in `wrangler dev` and
`wrangler deploy`.

This can be the default behavior under the compatibility flag. A separate
package list is not technically necessary. Wrangler may still need diagnostics
or optional include/exclude controls for packages with computed dependencies,
large file sets, native addons, or other Node-specific behavior.

For a general implementation, named imports from CommonJS need one additional
choice. Wrangler can generate ESM facade modules that read properties from the
CommonJS default export, or Workers SDK and the deployment transport can be
extended to carry statically detected names into workerd's existing
`namedExports` field. CanvasKit's default import does not require either change.

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

The plugin should key off the same `new_module_registry` compatibility flag
rather than require a different Vite-only package list. It would need to:

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

As with Wrangler, this can be automatic. Vite already resolves and classifies
dependencies as part of optimization and production builds. The change is to
retain the runtime CommonJS boundary when that classification says it is
required, rather than always converting the module into Vite's ESM execution
path.

### Required workerd changes

None are required to fix this `__dirname` failure once Wrangler or Vite sends
CanvasKit as `commonJsModule`. workerd already supplies the correct CommonJS
context, resolves registered CommonJS dependencies, handles circular
dependencies, and supports declared named exports.

Future workerd features such as npm package resolution, automatic CommonJS
named-export inference, or richer module-fallback behavior could reduce build
tool work, but they are not prerequisites and would change the current division
of responsibility between build tooling and runtime.

Preserving CanvasKit as CommonJS fixes only this first exception. CanvasKit's
default Node path next expects to locate and read `canvaskit.wasm` as a file.
The pinned workerd does [expose uploaded modules read-only under `/bundle`](https://github.com/cloudflare/workerd/blob/v1.20260730.1/src/workerd/io/worker-fs.h),
so CanvasKit could read the bytes if the build also emitted the Wasm at the
expected adjacent path. Reading the bytes is not sufficient: normal Workers
[disallow dynamic Wasm compilation](https://github.com/cloudflare/workerd/blob/v1.20260730.1/src/workerd/jsg/setup.c%2B%2B#L579-L584),
which CanvasKit's default
`WebAssembly.instantiate(bytes, imports)` path requires. The application,
CanvasKit, or build integration must import the Wasm as a precompiled
`WebAssembly.Module` and provide CanvasKit's `instantiateWasm` hook. That is a
separate integration issue, not a missing CommonJS module-registry feature.

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

## Scope

This repository isolates the first CanvasKit startup failure. CanvasKit throws
on `__dirname` before it attempts to load or instantiate its WebAssembly module.
After fixing or patching this failure, its dynamically compiled Wasm path still
needs to be replaced with an `instantiateWasm` hook that uses an imported,
precompiled `WebAssembly.Module`. That separate WebAssembly issue is outside
this reproduction.

workerd still [marks `new_module_registry` as experimental](https://github.com/cloudflare/workerd/blob/v1.20260730.1/src/workerd/io/compatibility-date.capnp).
This repository uses it in local development to test its behavior. It does not
claim that Cloudflare supports the flag for production Workers.

## Repository layout

```text
.
|-- control/           # Runtime CommonJS control module and Worker
|-- scripts/repro.mjs  # Runs and verifies both reproduction paths
|-- src/index.js       # Minimal Worker that calls CanvasKitInit()
|-- vite.config.js     # Cloudflare Vite plugin configuration
|-- wrangler.control.jsonc # No-bundle CommonJS control configuration
`-- wrangler.jsonc     # Shared Worker compatibility configuration
```
