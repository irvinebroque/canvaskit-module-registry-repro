import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedError = /__dirname is not defined[\s\S]*canvaskit-wasm/;
const expectedControl = JSON.stringify({
  dirname: "/bundle",
  filename: "module.cjs",
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

const [vitePort, wranglerPort, controlPort, wranglerInspectorPort, controlInspectorPort] =
  await Promise.all(Array.from({ length: 5 }, getAvailablePort));
const persistRoot = await mkdtemp(path.join(tmpdir(), "canvaskit-dirname-repro-"));

const cases = [
  {
    name: "Vite",
    args: [
      "node_modules/vite/bin/vite.js",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(vitePort),
      "--strictPort",
    ],
    url: `http://127.0.0.1:${vitePort}/`,
  },
  {
    name: "Wrangler",
    args: [
      "node_modules/wrangler/bin/wrangler.js",
      "dev",
      "--config",
      "wrangler.jsonc",
      "--port",
      String(wranglerPort),
      "--inspector-port",
      String(wranglerInspectorPort),
      "--persist-to",
      path.join(persistRoot, "wrangler"),
      "--no-latest",
    ],
    url: `http://127.0.0.1:${wranglerPort}/`,
  },
  {
    name: "workerd CommonJS control",
    args: [
      "node_modules/wrangler/bin/wrangler.js",
      "dev",
      "--config",
      "wrangler.control.jsonc",
      "--port",
      String(controlPort),
      "--inspector-port",
      String(controlInspectorPort),
      "--persist-to",
      path.join(persistRoot, "control"),
      "--no-latest",
    ],
    url: `http://127.0.0.1:${controlPort}/`,
    expectedStatus: 200,
    expectedBody: expectedControl,
  },
];

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForResponse(child, url) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Server exited with ${child.signalCode ?? `code ${child.exitCode}`} before accepting requests.`,
      );
    }

    try {
      const timeout = Math.min(1_000, deadline - Date.now());
      const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      return { status: response.status, body: await response.text() };
    } catch {
      await delay(250);
    }
  }

  throw new Error(`Server did not accept requests at ${url} within 30 seconds.`);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    const killed = once(child, "exit");
    child.kill("SIGKILL");
    await killed;
  }
}

for (const testCase of cases) {
  let output = "";
  const child = spawn(process.execPath, testCase.args, {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  try {
    const result = await waitForResponse(child, testCase.url);
    const expectedStatus = testCase.expectedStatus ?? 500;
    const bodyMatches = testCase.expectedBody
      ? result.body === testCase.expectedBody
      : expectedError.test(result.body);

    if (result.status !== expectedStatus || !bodyMatches) {
      throw new Error(
        `Expected HTTP ${expectedStatus}${
          testCase.expectedBody
            ? ` with body ${testCase.expectedBody}`
            : ' containing "__dirname is not defined"'
        }.\n` +
          `Received HTTP ${result.status}:\n${result.body}`,
      );
    }
    console.log(
      testCase.expectedBody
        ? `${testCase.name}: __dirname is /bundle`
        : `${testCase.name}: reproduced with HTTP 500`,
    );
  } catch (error) {
    console.error(`${testCase.name}: reproduction failed`);
    console.error(error);
    console.error("\nServer output:\n" + output);
    process.exitCode = 1;
  } finally {
    await stop(child);
  }
}

await rm(persistRoot, { recursive: true, force: true });

if (process.exitCode === undefined) {
  console.log(
    "Vite and Wrangler reproduced the failure; the runtime CommonJS control passed.",
  );
}
