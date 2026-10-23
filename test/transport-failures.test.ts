import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ACPClient } from "../acp.ts";

const fixture = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));

function client(env: Record<string, string> = {}) {
  return new ACPClient({
    profile: { id: "fake", name: "Fake", command: process.execPath, args: [fixture], env },
    cwd: join(fixture, ".."),
  });
}

test("a broken child stdin rejects requests without an unhandled stream error", async () => {
  const agent = client();
  await agent.start();
  const pending = agent.request("wait");
  const error = Object.assign(new Error("simulated EPIPE from child stdin"), { code: "EPIPE" });
  (agent as any).process.stdin.destroy(error);
  await assert.rejects(pending, /simulated EPIPE/);
  assert.equal(agent.isRunning, false);
  await agent.shutdown();
});

test("shutdown closes stdin and escalates when an agent ignores EOF", async () => {
  const trace = join(await mkdtemp(join(tmpdir(), "pi-acp-hanging-")), "trace.jsonl");
  const agent = client({ PI_ACP_FAKE_HANG_ON_EOF: "1", PI_ACP_FAKE_TRACE: trace });
  await agent.start();
  const pending = agent.request("wait");
  const rejected = assert.rejects(pending, /shutting down/);
  const started = Date.now();
  await agent.shutdown();
  await rejected;
  assert.ok(Date.now() - started < 2_000, "shutdown must be bounded");
  assert.equal(agent.isRunning, false);
  const frames = (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(frames.some((frame) => frame.method === "__stdin_eof"));
  assert.equal(frames.some((frame) => frame.method === "shutdown"), false);
});

test("session/list rejects repeated pagination cursors", async () => {
  const agent = client({ PI_ACP_FAKE_REPEAT_CURSOR: "1" });
  await agent.start();
  await assert.rejects(agent.list(), /repeated cursor/);
  await agent.shutdown();
});

test("session/list fetches subsequent pages", async () => {
  const agent = client({ PI_ACP_FAKE_PAGINATE: "1" });
  await agent.start();
  assert.deepEqual(await agent.list(), [{ sessionId: "page-one" }, { sessionId: "page-two" }]);
  await agent.shutdown();
});

test("incoming unsupported requests receive JSON-RPC method-not-found", async () => {
  const trace = join(await mkdtemp(join(tmpdir(), "pi-acp-unsupported-")), "trace.jsonl");
  const agent = client({ PI_ACP_FAKE_UNSUPPORTED_REQUEST: "1", PI_ACP_FAKE_TRACE: trace });
  await agent.start();
  await agent.request("trigger-unsupported");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const frames = (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  // The fake process records client-bound frames too.
  assert.ok(frames.some((frame) => frame.id === "unsupported-1" && frame.error?.code === -32601));
  await agent.shutdown();
});
