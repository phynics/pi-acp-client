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
