import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectBroken = process.argv.includes("--expect-broken");
const viteOutput = path.join(root, "dist-validation-vite");
const wranglerOutput = path.join(root, "dist-validation-wrangler");
const fixtureModuleMarkers = [
  {
    marker: "CJS_VALIDATION_SENTINEL",
    type: "commonjs",
    requires: ['require("path")', 'require("./child.js")', 'require("./cycle-a.js")'],
  },
  {
    marker: "CJS_VALIDATION_CHILD",
    type: "commonjs",
    requires: ['require("./data.json")'],
  },
  {
    marker: "CJS_VALIDATION_CYCLE_A",
    type: "commonjs",
    requires: ['require("./cycle-b.js")'],
  },
  {
    marker: "CJS_VALIDATION_CYCLE_B",
    type: "commonjs",
    requires: ['require("./cycle-a.js")'],
  },
  { marker: "CJS_VALIDATION_DATA", type: "json", requires: [] },
];
const expectedResponse = {
  defaultCall: "default-call",
  sentinel: "CJS_VALIDATION_SENTINEL",
  named: "named-export",
  namedImport: "named-export",
  dirname: "cjs-validation-fixture",
  filename: "index.js",
  child: "relative-require",
  cycle: "a:b:a",
  builtin: "commonjs/fixture",
};

const delay = (milliseconds, unref = false) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    if (unref) timer.unref();
  });

async function getAvailablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  const closed = once(server, "close");
  server.close();
  await closed;
  if (!port) throw new Error("Could not allocate a local port.");
  return port;
}

async function runCommand(name, args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const result = await Promise.race([
    once(child, "exit"),
    delay(60_000, true).then(() => null),
  ]);
  if (!result) {
    await stop(child);
    throw new Error(`${name} timed out after 60 seconds.`);
  }
  const [code, signal] = result;
  if (code !== 0) {
    throw new Error(
      `${name} exited with ${signal ?? `code ${code}`}\n\n${output}`,
    );
  }
  console.log(`${name}: built`);
}

async function waitForResponse(child, url, accept = () => true) {
  const deadline = Date.now() + 30_000;
  let lastResponse;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Server exited before accepting requests.");
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(1_000, deadline - Date.now())),
      });
      lastResponse = { status: response.status, body: await response.text() };
      if (accept(lastResponse)) return lastResponse;
    } catch {
      // The server may still be starting.
    }
    await delay(250);
  }
  throw new Error(
    lastResponse
      ? `Server never returned the expected response at ${url}. Last response was HTTP ${lastResponse.status}:\n${lastResponse.body}`
      : `Server did not accept requests at ${url}.`,
  );
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    delay(3_000, true).then(() => false),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(3_000, true)]);
  }
}

async function validateServer(name, args, url) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  try {
    let result;
    try {
      result = await waitForResponse(child, url, (response) =>
        expectBroken ? response.status === 500 : response.status === 200,
      );
    } catch (error) {
      if (
        expectBroken &&
        /ReferenceError: (?:__dirname|require) is not defined/.test(output)
      ) {
        console.log(`${name}: broken startup behavior detected`);
        return;
      }
      throw error;
    }
    if (expectBroken) {
      if (
        result.status !== 500 ||
        !/ReferenceError: (?:__dirname|require) is not defined/.test(result.body)
      ) {
        throw new Error(
          `Expected the current __dirname failure, received HTTP ${result.status}:\n${result.body}`,
        );
      }
      console.log(`${name}: broken behavior detected`);
      return;
    }

    let actual;
    try {
      actual = JSON.parse(result.body);
    } catch {
      throw new Error(`Expected JSON, received HTTP ${result.status}:\n${result.body}`);
    }
    if (result.status !== 200 || JSON.stringify(actual) !== JSON.stringify(expectedResponse)) {
      throw new Error(
        `Expected HTTP 200 with ${JSON.stringify(expectedResponse)}.\n` +
          `Received HTTP ${result.status}:\n${result.body}`,
      );
    }
    console.log(`${name}: CommonJS semantics passed`);
  } catch (error) {
    throw new Error(`${name} failed\n${error.message}\n\nServer output:\n${output}`);
  } finally {
    await stop(child);
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(entryPath)));
    else files.push(entryPath);
  }
  return files;
}

async function findViteConfig() {
  const files = await listFiles(viteOutput);
  const configPath = files.find((file) => path.basename(file) === "wrangler.json");
  if (!configPath) throw new Error("Vite did not emit a generated wrangler.json.");
  return configPath;
}

function matchesGlob(value, glob) {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      index++;
      if (glob[index + 1] === "/") {
        index++;
        pattern += "(?:.*/)?";
      } else {
        pattern += ".*";
      }
    } else if (character === "*") {
      pattern += "[^/]*";
    } else if (character === "?") {
      pattern += "[^/]";
    } else {
      pattern += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`).test(value);
}

async function validateArtifacts() {
  const wranglerEntry = path.join(wranglerOutput, "validate.js");
  const viteConfigPath = await findViteConfig();
  const viteConfig = JSON.parse(await readFile(viteConfigPath, "utf8"));
  const viteEntry = path.resolve(path.dirname(viteConfigPath), viteConfig.main);

  const artifactResults = [];
  for (const [name, outputRoot, entry, moduleRoot] of [
    ["Wrangler artifact", wranglerOutput, wranglerEntry, wranglerOutput],
    ["Vite artifact", viteOutput, viteEntry, path.dirname(viteConfigPath)],
  ]) {
    const files = await listFiles(outputRoot);
    const entrySource = await readFile(entry, "utf8");
    const moduleSources = new Map();
    for (const file of files.filter((file) => file !== entry && !file.endsWith(".map"))) {
      moduleSources.set(file, await readFile(file, "utf8"));
    }
    const separateModules = fixtureModuleMarkers.map(({ marker, type, requires }) => {
      const matches = [...moduleSources].filter(([, source]) => source.includes(marker));
      if (matches.length !== 1) return { marker, type, file: undefined };
      const [file, source] = matches[0];
      if (!requires.every((required) => source.includes(required))) {
        return { marker, type, file: undefined };
      }
      if (type === "json") {
        try {
          const parsed = JSON.parse(source);
          if (parsed.artifactMarker !== marker || parsed.value !== "relative-require") {
            return { marker, type, file: undefined };
          }
        } catch {
          return { marker, type, file: undefined };
        }
      }
      return { marker, type, file };
    });
    const indexModule = separateModules.find(
      ({ marker }) => marker === "CJS_VALIDATION_SENTINEL",
    );
    if (indexModule?.file) {
      const indexSource = moduleSources.get(indexModule.file);
      if (
        !indexSource.includes("__dirname") ||
        !indexSource.includes('require("./child.js")') ||
        !indexSource.includes("module.exports = function fixtureDefault")
      ) {
        indexModule.file = undefined;
      }
    }
    const separateCommonJs = separateModules
      .filter(({ type }) => type === "commonjs")
      .map(({ file }) => file);
    const allModulesSeparate =
      separateModules.every(({ file }) => file !== undefined) &&
      new Set(separateModules.map(({ file }) => file)).size === separateModules.length;

    if (expectBroken) {
      if (!entrySource.includes("CJS_VALIDATION_SENTINEL") || allModulesSeparate) {
        throw new Error(`${name} no longer has the expected bundled baseline.`);
      }
      console.log(`${name}: bundled baseline detected`);
    } else {
      if (fixtureModuleMarkers.some(({ marker }) => entrySource.includes(marker))) {
        throw new Error(`${name} still embeds fixture source in the entry module.`);
      }
      if (!allModulesSeparate) {
        const missing = separateModules
          .filter(({ file }) => file === undefined)
          .map(({ marker }) => marker)
          .join(", ");
        throw new Error(`${name} did not preserve every fixture module: ${missing}.`);
      }
      console.log(`${name}: complete separate module graph detected`);
    }
    artifactResults.push({ name, moduleRoot, separateCommonJs });
  }

  const viteArtifact = artifactResults.find(({ name }) => name === "Vite artifact");
  const commonJsRules = viteConfig.rules?.filter((rule) => rule.type === "CommonJS") ?? [];
  const hasCommonJsRule = commonJsRules.length > 0 && viteArtifact?.separateCommonJs.every((file) => {
    if (!file) return false;
    const relativePath = path.relative(viteArtifact.moduleRoot, file).replaceAll("\\", "/");
    return commonJsRules.some((rule) =>
      rule.globs.some((glob) => matchesGlob(relativePath, glob)),
    );
  });
  if (expectBroken ? hasCommonJsRule : !hasCommonJsRule) {
    throw new Error(
      expectBroken
        ? "Vite unexpectedly emitted a CommonJS module rule."
        : "Vite did not emit a CommonJS module rule.",
    );
  }
  console.log(
    expectBroken
      ? "Vite artifact: all-JavaScript-as-ESM baseline detected"
      : "Vite artifact: CommonJS module rule detected",
  );
}

async function validateCanvasKitCanary(name, args, url) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  try {
    const result = await waitForResponse(
      child,
      url,
      (response) => response.status === 200 || response.status === 500,
    );
    if (/__dirname is not defined/.test(result.body + output)) {
      throw new Error(`CanvasKit still failed at __dirname:\n${result.body}`);
    }
    const loaded = result.status === 200 && result.body === "CanvasKit loaded";
    const reachedWasm =
      result.status === 500 &&
      /(?:WebAssembly\.(?:compile|instantiate)|Wasm code generation disallowed|dynamic Wasm compilation)/i.test(
        result.body,
      );
    if (!loaded && !reachedWasm) {
      throw new Error(
        `Expected CanvasKit to load or reach its Wasm failure. Received HTTP ${result.status}:\n${result.body}`,
      );
    }
    console.log(`${name}: passed the CanvasKit __dirname canary`);
  } catch (error) {
    throw new Error(`${name} failed\n${error.message}\n\nServer output:\n${output}`);
  } finally {
    await stop(child);
  }
}

const persistRoot = await mkdtemp(path.join(tmpdir(), "cjs-module-validation-"));

try {
  await rm(viteOutput, { recursive: true, force: true });
  await rm(wranglerOutput, { recursive: true, force: true });
  await runCommand("Wrangler validation build", [
    "node_modules/wrangler/bin/wrangler.js",
    "deploy",
    "--config",
    "wrangler.validation.jsonc",
    "--dry-run",
    "--outdir",
    "dist-validation-wrangler",
  ]);
  await runCommand("Vite validation build", [
    "node_modules/vite/bin/vite.js",
    "build",
    "--config",
    "vite.validation.config.js",
  ]);
  await validateArtifacts();

  const vitePort = await getAvailablePort();
  await validateServer(
    "Vite development",
    [
      "node_modules/vite/bin/vite.js",
      "dev",
      "--config",
      "vite.validation.config.js",
      "--host",
      "127.0.0.1",
      "--port",
      String(vitePort),
      "--strictPort",
    ],
    `http://127.0.0.1:${vitePort}/`,
  );
  const [wranglerPort, wranglerInspectorPort] = await Promise.all([
    getAvailablePort(),
    getAvailablePort(),
  ]);
  await validateServer(
    "Wrangler development",
    [
      "node_modules/wrangler/bin/wrangler.js",
      "dev",
      "--config",
      "wrangler.validation.jsonc",
      "--port",
      String(wranglerPort),
      "--inspector-port",
      String(wranglerInspectorPort),
      "--persist-to",
      path.join(persistRoot, "wrangler"),
      "--no-latest",
    ],
    `http://127.0.0.1:${wranglerPort}/`,
  );
  const previewPort = await getAvailablePort();
  await validateServer(
    "Vite preview",
    [
      "node_modules/vite/bin/vite.js",
      "preview",
      "--config",
      "vite.validation.config.js",
      "--host",
      "127.0.0.1",
      "--port",
      String(previewPort),
      "--strictPort",
    ],
    `http://127.0.0.1:${previewPort}/`,
  );

  if (!expectBroken) {
    const canaryVitePort = await getAvailablePort();
    await validateCanvasKitCanary(
      "Vite development",
      [
        "node_modules/vite/bin/vite.js",
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        String(canaryVitePort),
        "--strictPort",
      ],
      `http://127.0.0.1:${canaryVitePort}/`,
    );
    const [canaryWranglerPort, canaryInspectorPort] = await Promise.all([
      getAvailablePort(),
      getAvailablePort(),
    ]);
    await validateCanvasKitCanary(
      "Wrangler development",
      [
        "node_modules/wrangler/bin/wrangler.js",
        "dev",
        "--config",
        "wrangler.jsonc",
        "--port",
        String(canaryWranglerPort),
        "--inspector-port",
        String(canaryInspectorPort),
        "--persist-to",
        path.join(persistRoot, "canary"),
        "--no-latest",
      ],
      `http://127.0.0.1:${canaryWranglerPort}/`,
    );
  }
} finally {
  await rm(persistRoot, { recursive: true, force: true });
}

console.log(
  expectBroken
    ? "Current Wrangler and Vite failures were detected in every validation path."
    : "Wrangler and Vite preserved CommonJS in all validation paths.",
);
