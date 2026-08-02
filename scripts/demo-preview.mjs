import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const previewPackages = [
  "https://pkg.pr.new/wrangler@14982",
  "https://pkg.pr.new/@cloudflare/vite-plugin@14982",
];

function run(label, args) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(npm, args, { cwd: root, stdio: "inherit" });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function printVersions(label) {
  console.log(`\n${label}:`);
  for (const name of ["wrangler", "@cloudflare/vite-plugin"]) {
    const manifest = JSON.parse(
      readFileSync(join(root, "node_modules", name, "package.json"), "utf8"),
    );
    const previewDependency = Object.values(manifest.dependencies ?? {}).find(
      (value) => typeof value === "string" && value.includes("pkg.pr.new"),
    );
    const previewCommit = previewDependency?.match(/@([0-9a-f]+)$/)?.[1];
    const provenance = previewCommit ? ` (pkg.pr.new commit ${previewCommit})` : "";
    console.log(`  ${name} ${manifest.version}${provenance}`);
  }
}

run("Install pinned stable releases", ["ci"]);
printVersions("Stable packages");
run("Reproduce CanvasKit failures with stable releases", ["run", "repro"]);
run("Validate the stable baseline", ["run", "validate:baseline"]);

run("Install PR #14982 preview packages", [
  "install",
  "--no-save",
  "--package-lock=false",
  ...previewPackages,
]);
printVersions("PR preview packages");
run("Validate PR preview builds", ["run", "validate"]);

console.log("\nStable releases reproduced the CanvasKit __dirname failure.");
console.log("PR #14982 previews defined __dirname for the same Worker source.");
console.log("Run `npm ci` to restore node_modules to the pinned stable releases.");
