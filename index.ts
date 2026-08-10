import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ACPClient, type ACPProfile } from "./acp.ts";
import { bindingFromEntries, loadConfig, type ACPBinding } from "./config.ts";

type EventStream = AsyncIterable<any> & { push(value: any): void; end(): void };

export default function piACPClient(pi: ExtensionAPI): void {
  let client: ACPClient | undefined;
  let profile: ACPProfile | undefined;
  let binding: ACPBinding | undefined;
  let providerActive = false;
  let turnCounter = 0;
  let liveText = "";

  const notify = (ctx: any, message: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(`[acp] ${message}`, level);
  const currentCWD = () => process.cwd();

  const models = staticProfiles();

  pi.registerProvider("acp", {
    name: "ACP",
    baseUrl: "acp://stdio",
    apiKey: "local",
    api: "acp-v1",
    models: (models.length ? models : [{ id: "default", name: "ACP Default" }]).map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    })),
    streamSimple: (model: any, context: any, options: any) => {
      const stream = createStream();
      const output = assistantOutput(model);
      stream.push({ type: "start", partial: output });
      void (async () => {
        try {
          if (!client || !binding || !profile) throw new Error("ACP session is not ready");
          const message = latestText(context.messages ?? []);
          const turnID = `pi:${context.sessionManager?.getSessionId?.() ?? "session"}:${context.sessionManager?.getLeafId?.() ?? `turn-${++turnCounter}`}`;
          const result = await client.prompt(binding.acpSessionID, message, {
            "dev.phynics.pi-acp-client/clientTurnID": turnID,
          }, options?.signal);
          const text = liveText || (typeof result?.text === "string" ? result.text : "(empty reply)");
          output.content = [{ type: "text", text }];
          output.stopReason = "stop";
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
          stream.push({ type: "done", reason: "stop", message: output });
        } catch (error) {
          output.stopReason = options?.signal?.aborted ? "aborted" : "error";
          output.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: "error", reason: output.stopReason, error: output });
        } finally {
          stream.end();
        }
      })();
      return stream;
    },
  } as any);

  pi.on("model_select", async (event: any, ctx: any) => {
    const selecting = event.model?.provider === "acp";
    if (selecting && !providerActive) {
      pi.setActiveTools([]);
      providerActive = true;
      notify(ctx, "ACP agent owns context and tool execution");
    } else if (!selecting && providerActive) {
      providerActive = false;
      notify(ctx, "ACP mode disabled");
    }
  });

  pi.on("session_before_compact", async (_event: any, ctx: any) => {
    if (!providerActive) return;
    notify(ctx, "Compaction is disabled while ACP owns session state", "warning");
    return { cancel: true };
  });
  pi.on("session_before_fork", async (_event: any, ctx: any) => {
    if (!providerActive) return;
    notify(ctx, "Fork/clone is disabled while ACP owns session state", "warning");
    return { cancel: true };
  });
  pi.on("session_before_tree", async (_event: any, ctx: any) => {
    if (!providerActive) return;
    notify(ctx, "Tree navigation is disabled while ACP owns session state", "warning");
    return { cancel: true };
  });

  pi.on("session_start", async (event: any, ctx: any) => {
    const config = await loadConfig(currentCWD());
    const selectedModel = ctx.model?.provider === "acp" ? ctx.model.id : undefined;
    profile = config.profiles.find((candidate) => candidate.id === selectedModel)
      ?? config.profiles.find((candidate) => candidate.id === config.defaultProfile)
      ?? config.profiles[0];
    if (!profile) throw new Error("No ACP profile configured");
    liveText = "";
    client = new ACPClient({
      profile,
      cwd: currentCWD(),
      onNotification: (notification) => {
        const text = notification.params?.update?.content?.text;
        if (notification.method === "session/update" && typeof text === "string") liveText += text;
      },
    });
    await client.start();
    const saved = bindingFromEntries(ctx.sessionManager.getEntries());
    if (event.reason !== "new" && saved && saved.profileID === profile.id && saved.canonicalCWD === currentCWD()) {
      binding = saved;
      await client.resume(saved.acpSessionID, saved.canonicalCWD);
    } else {
      const session = await client.newSession(currentCWD());
      binding = { bindingVersion: 1, profileID: profile.id, acpSessionID: session.sessionId, canonicalCWD: currentCWD() };
      pi.appendEntry("acp-binding", binding);
    }
    notify(ctx, `ACP profile ${profile.name} ready`);
  });

  pi.on("session_shutdown", async () => {
    await client?.shutdown();
    client = undefined;
    profile = undefined;
    binding = undefined;
    providerActive = false;
  });

  pi.registerCommand("acp-status", {
    description: "Show the active ACP profile and session",
    handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify({ profile, binding, running: client?.isRunning ?? false }, null, 2)),
  });
  pi.registerCommand("acp-profiles", {
    description: "List configured ACP profiles",
    handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(await loadConfig(currentCWD()), null, 2)),
  });
  pi.registerCommand("acp-sessions", {
    description: "List sessions known by the selected ACP agent",
    handler: async (_args: string, ctx: any) => {
      try { notify(ctx, JSON.stringify(await client?.list(currentCWD()) ?? [], null, 2)); }
      catch (error) { notify(ctx, error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.registerCommand("acp-new", {
    description: "Create a new ACP session",
    handler: async (_args: string, ctx: any) => {
      if (!client || !profile) return notify(ctx, "ACP is not ready", "error");
      const session = await client.newSession(currentCWD());
      binding = { bindingVersion: 1, profileID: profile.id, acpSessionID: session.sessionId, canonicalCWD: currentCWD() };
      pi.appendEntry("acp-binding", binding);
      notify(ctx, "Created a new ACP session");
    },
  });
  pi.registerCommand("acp-use", {
    description: "Select an ACP profile for a new Pi session",
    handler: async (args: string, ctx: any) => notify(ctx, `Profile changes require a new Pi session: ${args.trim() || "choose from /acp-profiles"}`, "warning"),
  });
}

function createStream(): EventStream {
  const queue: any[] = [];
  const waiters: Array<(result: IteratorResult<any>) => void> = [];
  let ended = false;
  return {
    push(value) { const waiter = waiters.shift(); waiter ? waiter({ value, done: false }) : queue.push(value); },
    end() { ended = true; while (waiters.length) waiters.shift()?.({ value: undefined, done: true }); },
    next() { if (queue.length) return Promise.resolve({ value: queue.shift(), done: false }); if (ended) return Promise.resolve({ value: undefined, done: true }); return new Promise((resolve) => waiters.push(resolve)); },
    [Symbol.asyncIterator]() { return this; },
  } as EventStream;
}

function latestText(messages: any[]): string {
  const message = [...messages].reverse().find((candidate) => candidate.role === "user");
  if (!message) throw new Error("ACP requires a user message");
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content) || message.content.some((part) => part?.type !== "text")) throw new Error("ACP v1 supports text input only");
  return message.content.map((part) => part.text ?? "").join("");
}

function assistantOutput(model: any): any {
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0 }, stopReason: "pending", timestamp: Date.now() };
}

function staticProfiles(): Array<{ id: string; name: string }> {
  const path = process.env.PI_ACP_CONFIG ?? join(homedir(), ".pi", "agent", "acp-profiles.json");
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(value?.profiles)) return [];
    const profiles = [...value.profiles];
    for (const source of Array.isArray(value.sources) ? value.sources : []) {
      try {
        const output = execFileSync(source.command, source.args ?? [], {
          cwd: process.cwd(),
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          env: { ...process.env, ...(source.env ?? {}) },
        });
        const bundle = JSON.parse(output);
        if (Array.isArray(bundle?.profiles)) profiles.push(...bundle.profiles);
      } catch {
        // Profile discovery is refreshed asynchronously during session_start.
      }
    }
    return profiles
      .filter((profile: any) => typeof profile?.id === "string" && typeof profile?.name === "string")
      .map((profile: any) => ({ id: profile.id, name: profile.name }));
  } catch {
    return [];
  }
}
