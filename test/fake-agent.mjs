import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
const keepAlive = setInterval(() => {}, 1_000);
for await (const line of input) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    reply(request, {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { list: {} } },
    });
  } else if (request.method === "session/new") {
    reply(request, { sessionId: "fake-session" });
  } else if (request.method === "session/resume" || request.method === "session/close") {
    reply(request, {});
  } else if (request.method === "session/list") {
    reply(request, { sessions: [{ sessionId: "fake-session", cwd: request.params?.cwd ?? process.cwd() }] });
  } else if (request.method === "session/prompt") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: request.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fake reply" } },
      },
    }) + "\n");
    reply(request, { stopReason: "end_turn", text: "fake reply" });
  } else if (request.method === "shutdown") {
    reply(request, {});
    setTimeout(() => { clearInterval(keepAlive); process.exit(0); }, 10);
  }
}

function reply(request, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
