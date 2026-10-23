import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import piACPClient from "../index.ts";

const fixture = join(import.meta.dirname, "lifecycle-agent.mjs");

test("ACP lifecycle binds prompts to the selected profile and keeps command output private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-acp-lifecycle-"));
  const configPath = join(directory, "profiles.json");
  const tracePath = join(directory, "trace.jsonl");
  await writeFile(configPath, JSON.stringify({ version: 1, defaultProfile: "a", profiles: [
    { id: "a", name: "Agent A", command: process.execPath, args: [fixture], env: { PI_ACP_AGENT_NAME: "a", SECRET_PROFILE_VALUE: "profile-secret" } },
    { id: "b", name: "Agent B", command: process.execPath, args: [fixture], env: { PI_ACP_AGENT_NAME: "b", SECRET_PROFILE_VALUE: "profile-secret" } },
  ] }));
  const previousConfig = process.env.PI_ACP_CONFIG;
  const previousTrace = process.env.PI_ACP_LIFECYCLE_TRACE;
  process.env.PI_ACP_CONFIG = configPath;
  process.env.PI_ACP_LIFECYCLE_TRACE = tracePath;
  let first: ReturnType<typeof createHarness> | undefined;
  let second: ReturnType<typeof createHarness> | undefined;
  let replacement: ReturnType<typeof createHarness> | undefined;
  try {
    first = createHarness();
    await first.start({ reason: "startup", model: { provider: "acp", id: "acp/a" }, entries: [] });
    assert.deepEqual(first.activeTools, []);
    await first.events.get("model_select")?.({ model: { provider: "native", id: "native/model" } }, first.context);
    assert.deepEqual(first.activeTools, ["read", "bash"], "native selection must restore Pi tools");
    await first.events.get("model_select")?.({ model: { provider: "acp", id: "acp/a" } }, first.context);
    assert.deepEqual(first.activeTools, [], "selecting ACP must suspend Pi tools");

    const mismatch = await collect(first.provider.streamSimple({ provider: "acp", id: "acp/b", api: "acp-v1" }, { messages: [{ role: "user", content: "wrong agent" }] }, {}));
    assert.ok(mismatch.some((event) => event.type === "error" && /bound to profile a/.test(event.error.errorMessage)));

    const prompt = await collect(first.provider.streamSimple({ provider: "acp", id: "acp/a", api: "acp-v1" }, { messages: [{ role: "user", content: "hello" }] }, {}));
    assert.ok(prompt.some((event) => event.type === "done"));
    const firstCommands = first.commands;
    await firstCommands.get("acp-status")?.("", first.context);
    await firstCommands.get("acp-profiles")?.("", first.context);
    const output = first.notifications.join("\n");
    assert.match(output, /Agent A/);
    assert.doesNotMatch(output, /profile-secret|SECRET_PROFILE_VALUE|lifecycle-agent\.mjs/);

    const selection = await firstCommands.get("acp-use")?.("b", first.context);
    assert.equal(selection, undefined);
    assert.equal(first.newSessionOptions.length, 1);
    const chosenEntries: any[] = [];
    await first.newSessionOptions[0].setup({ appendCustomEntry(type: string, data: unknown) { chosenEntries.push({ type: "custom", customType: type, data }); } });
    assert.deepEqual(chosenEntries[0], { type: "custom", customType: "acp-profile-selection", data: { profileID: "b" } });

    await first.shutdown();
    second = createHarness();
    await second.start({ reason: "new", model: { provider: "acp", id: "acp/a" }, entries: chosenEntries });
    assert.deepEqual(second.modelSelections, ["acp/b"]);
    assert.ok(second.notifications.some((message) => message.includes("Agent B ready")));
    const beforeNewCommand = (await readFile(tracePath, "utf8")).trim().split("\n").filter((line) => JSON.parse(line).method === "session/new").length;
    await second.commands.get("acp-new")?.("", second.context);
    assert.equal((await readFile(tracePath, "utf8")).trim().split("\n").filter((line) => JSON.parse(line).method === "session/new").length, beforeNewCommand,
      "/acp-new must defer ACP session creation until the replacement runtime starts");
    const replacementEntries: any[] = [];
    await second.newSessionOptions.at(-1).setup({ appendCustomEntry(type: string, data: unknown) { replacementEntries.push({ type: "custom", customType: type, data }); } });
    await second.shutdown();
    replacement = createHarness();
    await replacement.start({ reason: "new", model: { provider: "acp", id: "acp/a" }, entries: replacementEntries });
    assert.equal(replacement.context.model.id, "acp/b", "/acp-use must activate the actual registered acp/b model");
    const bPrompt = await collect(replacement.provider.streamSimple({ provider: "acp", id: "acp/b", api: "acp-v1" }, { messages: [{ role: "user", content: "replacement B" }] }, {}));
    assert.ok(bPrompt.some((event) => event.type === "done"), "new session must prompt the selected non-resumable agent");
    const wrongAgent = await collect(replacement.provider.streamSimple({ provider: "acp", id: "acp/a", api: "acp-v1" }, { messages: [{ role: "user", content: "wrong agent" }] }, {}));
    assert.ok(wrongAgent.some((event) => event.type === "error" && /bound to profile b/.test(event.error.errorMessage)));
    const frames = (await readFile(tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(frames.some((frame) => frame.method === "session/prompt" && frame.params?.sessionId.startsWith("session-b-")));
    assert.ok(frames.some((frame) => frame.selectedPermission === "allow_once"), "second duplicate-labeled option must preserve its option ID");
    assert.ok(frames.some((frame) => frame.method === "session/new" && frame.params?.cwd));
  } finally {
    await replacement?.shutdown().catch(() => {});
    await second?.shutdown().catch(() => {});
    await first?.shutdown().catch(() => {});
    await writeFile(configPath, "{}").catch(() => {});
    if (previousConfig === undefined) delete process.env.PI_ACP_CONFIG;
    else process.env.PI_ACP_CONFIG = previousConfig;
    if (previousTrace === undefined) delete process.env.PI_ACP_LIFECYCLE_TRACE;
    else process.env.PI_ACP_LIFECYCLE_TRACE = previousTrace;
  }
});

function createHarness() {
  const events = new Map<string, (event: any, context: any) => Promise<any>>();
  const commands = new Map<string, (args: string, context: any) => Promise<any>>();
  const notifications: string[] = [];
  const modelSelections: string[] = [];
  const newSessionOptions: any[] = [];
  let activeTools = ["read", "bash"];
  let provider: any;
  let context: any;
  const models = [{ id: "acp/a", name: "ACP: Agent A" }, { id: "acp/b", name: "ACP: Agent B" }].map((model) => ({ ...model, provider: "acp", api: "acp-v1" }));
  const pi: any = {
    registerProvider(_id: string, value: any) { provider = value; },
    registerCommand(name: string, value: any) { commands.set(name, value.handler); },
    on(name: string, handler: any) { events.set(name, handler); },
    getActiveTools() { return activeTools; },
    setActiveTools(tools: string[]) { activeTools = tools; },
    appendEntry(type: string, data: unknown) { context.sessionManager.entries.push({ type: "custom", customType: type, data }); },
    async setModel(model: any) { modelSelections.push(model.id); context.model = model; return true; },
  };
  context = {
    model: undefined,
    ui: {
      notify(message: string) { notifications.push(message); },
      setStatus() {}, setWidget() {},
      async select(_title: string, options: string[]) { return options.find((label) => label.includes("allow_once/allow_once")) ?? options[0]; },
    },
    modelRegistry: { find(providerID: string, id: string) { return providerID === "acp" ? models.find((model) => model.id === id) : undefined; } },
    sessionManager: { entries: [], getEntries() { return this.entries; }, getSessionId() { return "pi-session"; }, getLeafId() { return "user-entry"; } },
    newSession(options: any) { newSessionOptions.push(options); return Promise.resolve({ cancelled: false }); },
  };
  return {
    get activeTools() { return activeTools; },
    get events() { return events; },
    get provider() { return provider; }, get commands() { return commands; }, get notifications() { return notifications; },
    get modelSelections() { return modelSelections; }, get newSessionOptions() { return newSessionOptions; }, get context() { return context; },
    async start({ reason, model, entries }: any) {
      await piACPClient(pi);
      context.model = model;
      context.sessionManager.entries = entries;
      await events.get("session_start")?.({ reason }, context);
    },
    async shutdown() { await events.get("session_shutdown")?.({}, context); },
  };
}

async function collect(stream: AsyncIterable<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
