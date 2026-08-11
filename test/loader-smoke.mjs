import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = dirname(testDirectory);
const stateDirectory = await mkdtemp(join(tmpdir(), "pi-acp-loader-"));
const configPath = join(stateDirectory, "profiles.json");
const tracePath = join(stateDirectory, "fake-agent.jsonl");
const stdoutPath = join(stateDirectory, "pi.stdout");
const stderrPath = join(stateDirectory, "pi.stderr");
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
const stdoutFD = openSync(stdoutPath, "w");
const stderrFD = openSync(stderrPath, "w");
const child = spawn(pi, [
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
  detached: true,
  stdio: ["ignore", stdoutFD, stderrFD],
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: join(stateDirectory, "pi-state"),
    PI_ACP_CONFIG: configPath,
    PI_ACP_FAKE_TRACE: tracePath,
    PI_OFFLINE: "1",
  },
});
const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    reject(new Error("Pi ACP loader smoke timed out"));
  }, 20_000);
  child.once("error", (error) => { clearTimeout(timeout); reject(error); });
  child.once("close", (status, signal) => { clearTimeout(timeout); resolve({ status, signal }); });
});
closeSync(stdoutFD);
closeSync(stderrFD);
const standardOutput = await readFile(stdoutPath, "utf8");
const standardError = await readFile(stderrPath, "utf8");

if (result.status !== 0) throw new Error(standardError || `Pi exited with status ${result.status}`);
if (!standardOutput.includes("fake reply")) throw new Error(`Unexpected Pi output: ${standardOutput}`);
const frames = (await readFile(tracePath, "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const initialize = frames.find((frame) => frame.method === "initialize");
if (initialize?.params?.protocolVersion !== 1) throw new Error("Pi did not initialize ACP v1");
const created = frames.find((frame) => frame.method === "session/new");
if (!Array.isArray(created?.params?.mcpServers) || created.params.mcpServers.length !== 0) {
  throw new Error("Pi did not create the ACP session with empty mcpServers");
}
const prompt = frames.find((frame) => frame.method === "session/prompt");
const turnID = prompt?.params?._meta?.["dev.phynics.pi-acp-client/clientTurnID"];
if (typeof turnID !== "string" || !turnID.startsWith("pi:") || /^pi:session:turn-/.test(turnID)) {
  throw new Error(`Pi did not derive a stable session/entry turn ID: ${String(turnID)}`);
}
const permission = frames.find((frame) => frame.id === "permission-1" && frame.result);
if (permission?.result?.outcome?.outcome !== "cancelled") {
  throw new Error("Headless Pi did not deterministically deny the ACP permission request");
}
if (!frames.some((frame) => frame.method === "shutdown")) throw new Error("Pi did not shut down the ACP child cleanly");
process.stdout.write("Pi ACP loader smoke passed\n");
