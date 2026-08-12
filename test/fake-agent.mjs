import readline from "node:readline";
import { appendFileSync } from "node:fs";

const input = readline.createInterface({ input: process.stdin });
const keepAlive = setInterval(() => {}, 1_000);
let pendingPrompt;
let authenticated = false;
for await (const line of input) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (process.env.PI_ACP_FAKE_TRACE) {
    appendFileSync(process.env.PI_ACP_FAKE_TRACE, JSON.stringify(request) + "\n");
  }
  if (request.method === "initialize") {
    const authentication = process.env.PI_ACP_FAKE_AUTH ? {
      authMethods: [{ id: "fake-login", name: "Fake login" }],
    } : {};
    const sessionCapabilities = process.env.PI_ACP_FAKE_NO_OPTIONAL_SESSION_CAPS
      ? { list: {} }
      : { list: {}, resume: {}, close: {} };
    reply(request, {
      protocolVersion: Number(process.env.PI_ACP_FAKE_PROTOCOL_VERSION ?? "1"),
      agentCapabilities: { sessionCapabilities },
      ...authentication,
    });
  } else if (request.method === "authenticate") {
    if (!process.env.PI_ACP_FAKE_AUTH || request.params?.methodId !== "fake-login") {
      replyError(request, -32602, "unsupported authentication method");
    } else if (process.env.PI_ACP_FAKE_AUTH_FAILURE) {
      replyError(request, -32000, "authentication failed");
    } else {
      authenticated = true;
      reply(request, {});
    }
  } else if (request.method === "session/new") {
    if (process.env.PI_ACP_FAKE_AUTH && !authenticated) {
      replyError(request, -32000, "authentication required");
    } else {
      reply(request, { sessionId: "fake-session" });
    }
  } else if (request.method === "session/resume" || request.method === "session/close") {
    reply(request, {});
  } else if (request.method === "session/list") {
    reply(request, { sessions: [{ sessionId: "fake-session", cwd: request.params?.cwd ?? process.cwd() }] });
  } else if (request.method === "session/prompt") {
    pendingPrompt = request;
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: "permission-1",
      method: "session/request_permission",
      params: {
        sessionId: request.params.sessionId,
        toolCall: { toolCallId: "fake-tool", title: "Fake tool", status: "pending" },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "deny", name: "Reject once", kind: "reject_once" },
        ],
      },
    }) + "\n");
  } else if (request.method === "wait") {
    // Intentionally left pending so the client-side request cancellation path can be tested.
  } else if (request.id === "permission-1" && pendingPrompt) {
    if (pendingPrompt.params?.prompt?.[0]?.text === "cancel me"
        && request.result?.outcome?.outcome === "cancelled") continue;
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: pendingPrompt.params.sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "fake-tool", title: "Fake tool", status: "completed" },
      },
    }) + "\n");
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: pendingPrompt.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fake reply" } },
      },
    }) + "\n");
    reply(pendingPrompt, { stopReason: "end_turn", text: "fake reply" });
    pendingPrompt = undefined;
  } else if (request.method === "session/cancel" && pendingPrompt) {
    reply(pendingPrompt, { stopReason: "cancelled" });
    pendingPrompt = undefined;
  } else if (request.method === "shutdown") {
    reply(request, {});
    setTimeout(() => { clearInterval(keepAlive); process.exit(0); }, 10);
  }
}

function reply(request, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}

function replyError(request, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code, message } }) + "\n");
}
