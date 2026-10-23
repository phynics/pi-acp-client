import readline from "node:readline";
import { appendFileSync } from "node:fs";

const input = readline.createInterface({ input: process.stdin });
const trace = (message) => appendFileSync(process.env.PI_ACP_LIFECYCLE_TRACE, `${JSON.stringify(message)}\n`);
for await (const line of input) {
  const request = JSON.parse(line);
  trace(request);
  if (request.method === "initialize") {
    reply(request, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } });
  } else if (request.method === "session/new") {
    reply(request, { sessionId: `session-${process.env.PI_ACP_AGENT_NAME}-${process.pid}` });
  } else if (request.method === "session/resume" || request.method === "session/close" || request.method === "shutdown") {
    reply(request, {});
    if (request.method === "shutdown") setTimeout(() => process.exit(0), 10);
  } else if (request.method === "session/prompt") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: "duplicate-permission", method: "session/request_permission", params: {
      sessionId: request.params.sessionId,
      toolCall: { title: "Fixture tool" },
      options: [
        { optionId: "allow_always", name: "Allow", kind: "allow_always" },
        { optionId: "allow_once", name: "Allow", kind: "allow_once" },
      ],
    } })}\n`);
    globalThis.pendingPrompt = request;
  } else if (request.id === "duplicate-permission" && globalThis.pendingPrompt) {
    trace({ selectedPermission: request.result?.outcome?.optionId });
    const pending = globalThis.pendingPrompt;
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: pending.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lifecycle reply" } },
    } })}\n`);
    reply(pending, { stopReason: "end_turn", text: "lifecycle reply" });
    globalThis.pendingPrompt = undefined;
  }
}

function reply(request, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
