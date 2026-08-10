import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = dirname(testDirectory);
const stateDirectory = await mkdtemp(join(tmpdir(), "pi-acp-loader-"));
const configPath = join(stateDirectory, "profiles.json");
await writeFile(configPath, JSON.stringify({
  version: 1,
  defaultProfile: "fake",
  profiles: [{
    id: "fake",
    name: "Fake Agent",
    command: process.execPath,
    args: [join(testDirectory, "fake-agent.mjs")],
    env: {},
  }],
}));

const pi = join(packageDirectory, "node_modules", ".bin", "pi");
const result = spawnSync(pi, [
  "--extension", join(packageDirectory, "index.ts"),
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--no-session",
  "--provider", "acp",
  "--model", "acp/fake",
  "-p", "hello",
], {
  cwd: packageDirectory,
  encoding: "utf8",
  timeout: 20_000,
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: join(stateDirectory, "pi-state"),
    PI_ACP_CONFIG: configPath,
    PI_OFFLINE: "1",
  },
});

if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || `Pi exited with status ${result.status}`);
if (!result.stdout.includes("fake reply")) throw new Error(`Unexpected Pi output: ${result.stdout}`);
process.stdout.write("Pi ACP loader smoke passed\n");
