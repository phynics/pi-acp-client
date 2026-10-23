import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const versions = process.argv.slice(2).length ? process.argv.slice(2) : ["0.84.1", "1.0.0", "1.4.0"];
const root = resolve(import.meta.dirname, "..");
const packageData = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const directory = await mkdtemp(join(tmpdir(), "pi-acp-compat-"));

try {
  for (const path of ["index.ts", "acp.ts", "config.ts", "test", "scripts", "README.md", "LICENSE", "tsconfig.json"]) {
    await cp(join(root, path), join(directory, path), { recursive: true });
  }
  packageData.devDependencies["@earendil-works/pi-coding-agent"] = versions[0];
  await import("node:fs/promises").then(({ writeFile }) => writeFile(join(directory, "package.json"), JSON.stringify(packageData, null, 2)));
  run("npm", ["install", "--ignore-scripts", "--no-save", "--package-lock=false"]);
  for (const version of versions) {
    console.log(`\n=== Pi ${version} ===`);
    run("npm", ["install", "--ignore-scripts", "--no-save", "--package-lock=false", `@earendil-works/pi-coding-agent@${version}`]);
    run("npm", ["test"]);
    run("npm", ["run", "check"]);
    run("npm", ["run", "smoke:loader"]);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: directory, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}
