import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import piACPClient from "../index.ts";

test("ACP provider disables Pi tools and blocks transcript-splitting operations", async () => {
  const events = new Map<string, (event: any, context: any) => Promise<any>>();
  let activeTools = ["read", "bash"];
  const notifications: string[] = [];
  const pi = {
    registerProvider() {},
    registerCommand() {},
    on(name: string, handler: (event: any, context: any) => Promise<any>) { events.set(name, handler); },
    getActiveTools() { return activeTools; },
    setActiveTools(tools: string[]) { activeTools = tools; },
  } as any;
  const context = {
    ui: {
      notify(message: string) { notifications.push(message); },
      setStatus() {},
      setWidget() {},
    },
  };
  piACPClient(pi);

  await events.get("model_select")?.({ model: { provider: "acp" } }, context);
  assert.deepEqual(activeTools, []);
  assert.deepEqual(await events.get("session_before_compact")?.({}, context), { cancel: true });
  assert.deepEqual(await events.get("session_before_fork")?.({}, context), { cancel: true });
  assert.deepEqual(await events.get("session_before_tree")?.({}, context), { cancel: true });
  assert.ok(notifications.some((message) => message.includes("ACP agent owns context and tool execution")));

  await events.get("model_select")?.({ model: { provider: "openai" } }, context);
  assert.deepEqual(activeTools, ["read", "bash"]);
});

test("dynamic profile sources replace static model registrations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-acp-provider-"));
  const configPath = join(directory, "profiles.json");
  const source = JSON.stringify({
    version: 1,
    profiles: [{ id: "same", name: "Dynamic", command: "dynamic-acp", args: [], env: {} }],
  });
  await writeFile(configPath, JSON.stringify({
    version: 1,
    profiles: [{ id: "same", name: "Static", command: "static-acp", args: [], env: {} }],
    sources: [{ command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(source)})`] }],
  }));
  const previous = process.env.PI_ACP_CONFIG;
  process.env.PI_ACP_CONFIG = configPath;
  let provider: any;
  try {
    piACPClient({
      registerProvider(_id: string, value: any) { provider = value; },
      registerCommand() {},
      on() {},
      getActiveTools() { return []; },
      setActiveTools() {},
    } as any);
  } finally {
    if (previous === undefined) delete process.env.PI_ACP_CONFIG;
    else process.env.PI_ACP_CONFIG = previous;
  }
  assert.deepEqual(provider.models.map((model: any) => [model.id, model.name]), [
    ["acp/same", "ACP: Dynamic"],
  ]);
});
