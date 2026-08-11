import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ACPClient } from "../acp.ts";

test("runs the generic ACP lifecycle against a fake agent", async () => {
  const fixture = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));
  const updates: any[] = [];
  const client = new ACPClient({
    profile: {
      id: "fake",
      name: "Fake",
      command: process.execPath,
      args: [fixture],
    },
    cwd: join(fixture, ".."),
    onNotification: (notification) => updates.push(notification),
  });

  await client.start();
  assert.equal(client.supportsSessionList, true);
  const session = await client.newSession(process.cwd());
  assert.equal(session.sessionId, "fake-session");
  const result = await client.prompt(session.sessionId, "hello", { turn: "1" });
  assert.equal(result.stopReason, "end_turn");
  assert.equal(updates[0]?.method, "session/update");
  assert.equal((await client.list(process.cwd()))[0]?.sessionId, "fake-session");
  await client.closeSession(session.sessionId);
  await client.shutdown();
});

test("cancels prompt turns with the stable session/cancel notification", async () => {
  const fixture = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));
  const trace = join(await mkdtemp(join(tmpdir(), "pi-acp-cancel-")), "trace.jsonl");
  const client = new ACPClient({
    profile: {
      id: "fake",
      name: "Fake",
      command: process.execPath,
      args: [fixture],
      env: { PI_ACP_FAKE_TRACE: trace },
    },
    cwd: join(fixture, ".."),
    onPermission: async () => new Promise(() => {}),
  });
  await client.start();
  const session = await client.newSession(process.cwd());
  const controller = new AbortController();
  const prompt = client.prompt(session.sessionId, "cancel me", { turn: "cancel" }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(prompt, { name: "AbortError" });
  const frames = await readFile(trace, "utf8");
  await client.shutdown();
  const messages = frames.trim().split("\n").map((line) => JSON.parse(line));
  const permissionIndex = messages.findIndex((message) => message.id === "permission-1" && message.result?.outcome?.outcome === "cancelled");
  const cancelIndex = messages.findIndex((message) => message.method === "session/cancel");
  assert.ok(permissionIndex >= 0, "pending permission must receive a cancelled outcome");
  assert.ok(cancelIndex > permissionIndex, "permission cancellation must precede session/cancel");
});
