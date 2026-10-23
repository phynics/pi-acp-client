import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ACPClient, type ACPPromptContent, type ACPProfile } from "./acp.ts";
import { bindingFromEntries, canonicalCWD, loadConfig, loadProfileConfig, selectedProfileFromEntries, type ACPBinding } from "./config.ts";

type EventStream = AsyncIterableIterator<any> & { push(value: any): void; end(): void };

export default async function piACPClient(pi: ExtensionAPI): Promise<void> {
  const discoveredProfiles = await loadProfileConfig();
  let client: ACPClient | undefined;
  let profile: ACPProfile | undefined;
  let binding: ACPBinding | undefined;
  let providerActive = false;
  let toolsBeforeACP: string[] | undefined;
  let activeSessionManager: any;
  let liveText = "";
  let activeTextDelta: ((text: string) => void) | undefined;
  let providerTail: Promise<void> = Promise.resolve();
  let livePanel: string[] = [];
  let activeUI: any;
  let explicitProfileSelection = false;

  const notify = (ctx: any, message: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(`[acp] ${message}`, level);
  const currentCWD = () => canonicalCWD();
  const renderPanel = () => activeUI?.setWidget(
    "pi-acp-client-live",
    livePanel.length ? livePanel.slice(-12) : undefined,
    { placement: "belowEditor" },
  );
  const setPanel = (...lines: string[]) => { livePanel = lines; renderPanel(); };
  const appendPanel = (line: string) => { livePanel.push(line); renderPanel(); };
  const clearPanel = () => { livePanel = []; renderPanel(); };
  const activateACP = (ctx: any) => {
    if (providerActive) return;
    toolsBeforeACP = pi.getActiveTools();
    pi.setActiveTools([]);
    providerActive = true;
    ctx.ui.setStatus("pi-acp-client", "ACP owns context and tools");
    notify(ctx, "ACP agent owns context and tool execution");
  };
  const deactivateACP = (ctx?: any) => {
    if (!providerActive) return;
    if (toolsBeforeACP) pi.setActiveTools(toolsBeforeACP);
    toolsBeforeACP = undefined;
    providerActive = false;
    clearPanel();
    activeUI?.setStatus("pi-acp-client", undefined);
    if (ctx) notify(ctx, "ACP mode disabled");
  };

  const models = discoveredProfiles.profiles.map(({ id, name }) => ({ id, name }));

  pi.registerProvider("acp", {
    name: "ACP",
    baseUrl: "acp://stdio",
    apiKey: "local",
    api: "acp-v1",
    models: models.map((model) => ({
      id: `acp/${model.id}`,
      name: `ACP: ${model.name}`,
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
        let release!: () => void;
        const previous = providerTail;
        providerTail = new Promise<void>((resolve) => { release = resolve; });
        try {
          await previous;
          if (options?.signal?.aborted) throw abortError();
          liveText = "";
          setPanel("ACP prompt running…");
          if (!client || !binding || !profile) throw new Error("ACP session is not ready");
          const requestedModelID = typeof model?.id === "string" ? model.id.replace(/^acp\//, "") : undefined;
          if (model?.provider !== "acp" || requestedModelID !== profile.id || binding.profileID !== profile.id) {
            throw new Error(`ACP session is bound to profile ${profile.id}; select that model or use /acp-use <profile> to start a new session`);
          }
          const block = { type: "text", text: "" };
          output.content = [block];
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          activeTextDelta = (delta: string) => {
            liveText += delta;
            block.text = liveText;
            stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
          };
          const message = latestPrompt(context.messages ?? []);
          const piSessionID = activeSessionManager?.getSessionId?.();
          const userEntryID = activeSessionManager?.getLeafId?.();
          if (typeof piSessionID !== "string" || !piSessionID || typeof userEntryID !== "string" || !userEntryID) {
            throw new Error("Pi session identity is unavailable; cannot derive a stable ACP turn ID");
          }
          const turnID = `pi:${piSessionID}:${userEntryID}`;
          const result = await client.prompt(binding.acpSessionID, message, {
            "dev.phynics.pi-acp-client/clientTurnID": turnID,
          }, options?.signal);
          if (!liveText) activeTextDelta(typeof result?.text === "string" ? result.text : "(empty reply)");
          output.stopReason = "stop";
          stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: output });
          stream.push({ type: "done", reason: "stop", message: output });
        } catch (error) {
          output.stopReason = options?.signal?.aborted ? "aborted" : "error";
          output.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: "error", reason: output.stopReason, error: output });
        } finally {
          activeTextDelta = undefined;
          clearPanel();
          release();
          stream.end();
        }
      })();
      return stream;
    },
  } as any);

  pi.on("model_select", async (event: any, ctx: any) => {
    const selecting = event.model?.provider === "acp";
    if (selecting) activateACP(ctx);
    else deactivateACP(ctx);
  });

  pi.on("session_before_compact", async (_event: any, ctx: any) => {
    if (!providerActive && !binding) return;
    notify(ctx, "Compaction is disabled while ACP owns session state", "warning");
    return { cancel: true };
  });
  pi.on("session_before_fork", async (_event: any, ctx: any) => {
    if (!providerActive && !binding) return;
    notify(ctx, "Fork/clone is disabled while ACP owns session state", "warning");
    return { cancel: true };
  });
  pi.on("session_before_tree", async (_event: any, ctx: any) => {
    if (!providerActive && !binding) return;
    notify(ctx, "Tree navigation is disabled while ACP owns session state", "warning");
    return { cancel: true };
  });

  pi.on("session_start", async (event: any, ctx: any) => {
    activeUI = ctx.ui;
    activeSessionManager = ctx.sessionManager;
    const config = await loadConfig(currentCWD(), discoveredProfiles);
    const selectedEntry = selectedProfileFromEntries(ctx.sessionManager.getEntries());
    explicitProfileSelection = selectedEntry !== undefined;
    const selectedModel = !selectedEntry && ctx.model?.provider === "acp" && typeof ctx.model.id === "string"
      ? ctx.model.id.replace(/^acp\//, "")
      : undefined;
    const requestedProfileID = selectedModel ?? selectedEntry ?? config.defaultProfile;
    profile = requestedProfileID
      ? config.profiles.find((candidate) => candidate.id === requestedProfileID)
      : config.profiles[0];
    if (requestedProfileID && !profile) throw new Error(`unknown ACP profile: ${requestedProfileID}`);
    if (!profile) throw new Error("No ACP profile configured");
    if (explicitProfileSelection) {
      const selectedModel = ctx.modelRegistry?.find?.("acp", `acp/${profile.id}`);
      if (!selectedModel || !(await pi.setModel(selectedModel))) {
        throw new Error(`Could not activate ACP model acp/${profile.id} for the selected profile`);
      }
    }
    liveText = "";
    client = new ACPClient({
      profile,
      cwd: currentCWD(),
      onNotification: (notification) => {
        if (notification.method !== "session/update") return;
        const update = notification.params?.update;
        const kind = update?.sessionUpdate;
        const text = update?.content?.text;
        if (kind === "agent_message_chunk" && typeof text === "string") {
          activeTextDelta?.(text);
          return;
        }
        if (kind === "tool_call" || kind === "tool_call_update") {
          const title = update?.title ?? update?.name ?? update?.toolCallId ?? "tool";
          const status = update?.status ?? update?.content?.status ?? "running";
          appendPanel(`Tool: ${title} — ${status}`);
          return;
        }
        if (kind === "plan") appendPanel("ACP plan updated");
      },
      onPermission: async (params) => {
        const options = Array.isArray(params?.options) ? params.options : [];
        const tool = params?.toolCall?.title ?? params?.toolCall?.name ?? params?.toolCall?.toolCallId ?? "tool action";
        setPanel(`Permission requested: ${tool}`);
        const eligible = options.filter((option: any) => typeof option?.optionId === "string");
        const labels = eligible.map((option: any, index: number) => `${option.name ?? option.optionId} (${option.kind ?? "option"}/${option.optionId}) [${index + 1}]`);
        const choice = labels.length ? await ctx.ui.select(`ACP permission: ${tool}`, labels) : undefined;
        const index = choice === undefined ? -1 : labels.indexOf(choice);
        if (index < 0) {
          appendPanel("Permission denied");
          return { outcome: { outcome: "cancelled" } };
        }
        appendPanel(`Permission: ${choice}`);
        return { outcome: { outcome: "selected", optionId: eligible[index].optionId } };
      },
      onAuthenticate: async (methods) => {
        const labels = methods.map((method) => method.name ?? method.id);
        const choice = await ctx.ui.select("ACP authentication method", labels);
        const index = choice === undefined ? -1 : labels.indexOf(choice);
        return index < 0 ? undefined : methods[index].id;
      },
    });
    await client.start();
    const saved = bindingFromEntries(ctx.sessionManager.getEntries());
    if (saved) {
      if (saved.profileID !== profile.id) throw new Error("ACP profile changed; start a new Pi session with /acp-use");
      if (saved.canonicalCWD !== currentCWD()) throw new Error("ACP working directory changed; start a new Pi session");
      if (!client.supportsSessionResume) throw new Error("ACP agent does not advertise session/resume; start a new Pi session");
      binding = saved;
      await client.resume(saved.acpSessionID, saved.canonicalCWD);
    } else if (event.reason === "new" || event.reason === "startup") {
      const session = await client.newSession(currentCWD());
      binding = { bindingVersion: 1, profileID: profile.id, acpSessionID: session.sessionId, canonicalCWD: currentCWD() };
      pi.appendEntry("acp-binding", binding);
    } else {
      throw new Error("ACP resume is missing its persisted session binding");
    }
    if (ctx.model?.provider === "acp") activateACP(ctx);
    notify(ctx, `ACP profile ${profile.name} ready`);
  });

  pi.on("session_shutdown", async () => {
    await client?.shutdown();
    deactivateACP();
    client = undefined;
    profile = undefined;
    binding = undefined;
    activeUI = undefined;
    activeSessionManager = undefined;
  });

  pi.registerCommand("acp-status", {
    description: "Show the active ACP profile and session",
    handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify({ profile: profile && profileSummary(profile), binding, running: client?.isRunning ?? false }, null, 2)),
  });
  pi.registerCommand("acp-profiles", {
    description: "List configured ACP profiles",
    handler: async (_args: string, ctx: any) => {
      const config = await loadConfig(currentCWD());
      notify(ctx, JSON.stringify({ defaultProfile: config.defaultProfile, profiles: config.profiles.map(profileSummary) }, null, 2));
    },
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
      const selectedProfileID = profile.id;
      const selectedProfileName = profile.name;
      const switched = await ctx.newSession({
        setup: async (sessionManager: any) => { sessionManager.appendCustomEntry("acp-profile-selection", { profileID: selectedProfileID }); },
        withSession: async (nextCtx: any) => notify(nextCtx, `New ACP session started for ${selectedProfileName}`),
      });
      if (switched.cancelled) notify(ctx, "New Pi session was cancelled; current ACP session is unchanged", "warning");
    },
  });
  pi.registerCommand("acp-use", {
    description: "Select an ACP profile for a new Pi session",
    handler: async (args: string, ctx: any) => {
      const requested = args.trim();
      const config = await loadConfig(currentCWD());
      const selected = config.profiles.find((candidate) => candidate.id === requested);
      if (!selected) {
        notify(ctx, `Unknown ACP profile: ${requested || "(empty)"}`, "error");
        return;
      }
      const switched = await ctx.newSession({
        setup: async (sessionManager: any) => {
          sessionManager.appendCustomEntry("acp-profile-selection", { profileID: selected.id });
        },
        withSession: async (nextCtx: any) => notify(nextCtx, `ACP profile ${selected.name} ready in a new session`),
      });
      if (switched.cancelled) notify(ctx, "ACP profile change was cancelled; current binding is unchanged", "warning");
    },
  });
}

function profileSummary(profile: ACPProfile): { id: string; name: string } {
  return { id: profile.id, name: profile.name };
}

function createStream(): EventStream {
  const queue: any[] = [];
  const waiters: Array<(result: IteratorResult<any>) => void> = [];
  let ended = false;
  return {
    push(value) { const waiter = waiters.shift(); waiter ? waiter({ value, done: false }) : queue.push(value); },
    end() { ended = true; while (waiters.length) waiters.shift()?.({ value: undefined, done: true }); },
    next(): Promise<IteratorResult<any>> { if (queue.length) return Promise.resolve({ value: queue.shift(), done: false }); if (ended) return Promise.resolve({ value: undefined, done: true }); return new Promise<IteratorResult<any>>((resolve) => waiters.push(resolve)); },
    [Symbol.asyncIterator]() { return this; },
  } as EventStream;
}

function latestPrompt(messages: any[]): string | ACPPromptContent[] {
  const message = [...messages].reverse().find((candidate) => candidate.role === "user");
  if (!message) throw new Error("ACP requires a user message");
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) throw new Error("ACP user content must be text or an array of content blocks");
  for (const [index, part] of message.content.entries()) {
    if (part?.type === "text" && typeof part.text === "string") continue;
    if (part?.type === "resource_link" && typeof part.uri === "string") continue;
    throw new Error(`ACP prompt content block ${index} has unsupported type: ${String(part?.type)}`);
  }
  return message.content as ACPPromptContent[];
}

function assistantOutput(model: any): any {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function abortError(): Error {
  const error = new Error("The ACP request was aborted");
  error.name = "AbortError";
  return error;
}
