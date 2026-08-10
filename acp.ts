import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type ACPProfile = {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type ACPNotification = {
  method: string;
  params?: any;
};

export type ACPClientOptions = {
  profile: ACPProfile;
  cwd: string;
  onNotification?: (notification: ACPNotification) => void;
  onPermission?: (params: any) => Promise<any>;
};

/** Minimal stable ACP v1 client. Gnostic-specific behavior is deliberately
 * limited to opaque `_meta` forwarding and is not part of this class. */
export class ACPClient {
  private readonly options: ACPClientOptions;
  private process?: ChildProcessWithoutNullStreams;
  private nextID = 1;
  private nextSequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private frameBuffer = "";
  private closed = false;

  constructor(options: ACPClientOptions) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this.process !== undefined && !this.closed;
  }

  async start(): Promise<void> {
    if (this.process) return;
    const environment = { ...process.env, ...(this.options.profile.env ?? {}) } as Record<string, string>;
    const child = spawn(this.options.profile.command, this.options.profile.args ?? [], {
      cwd: this.options.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.on("data", () => { /* stderr is intentionally not ACP data */ });
    child.on("error", (error) => this.failPending(error instanceof Error ? error : new Error(String(error))));
    child.on("exit", (code, signal) => {
      this.closed = true;
      this.failPending(new Error(`ACP agent exited (${code ?? "signal " + signal})`));
    });
    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "pi-acp-client", version: "0.1.0" },
    });
  }

  async shutdown(): Promise<void> {
    if (!this.process) return;
    try {
      if (!this.closed) await this.request("shutdown", {});
    } catch {
      // A crashed agent is already shut down from the client's perspective.
    }
    this.closed = true;
    this.process.stdin.end();
    this.process.kill();
    this.process = undefined;
  }

  async request(method: string, params?: unknown): Promise<any> {
    if (!this.process || this.closed) throw new Error("ACP agent is not running");
    const id = this.nextID++;
    const request = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n";
    this.process.stdin.write(request);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async newSession(cwd: string): Promise<{ sessionId: string; [key: string]: any }> {
    return this.request("session/new", { cwd, mcpServers: [] });
  }

  async resume(sessionId: string, cwd: string): Promise<void> {
    await this.request("session/resume", { sessionId, cwd, mcpServers: [] });
  }

  async list(cwd?: string): Promise<any[]> {
    const result = await this.request("session/list", cwd ? { cwd } : {});
    return Array.isArray(result?.sessions) ? result.sessions : [];
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request("session/close", { sessionId });
  }

  async prompt(sessionId: string, text: string, metadata: Record<string, unknown>): Promise<any> {
    return this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
      mcpServers: [],
      _meta: metadata,
    });
  }

  private consume(chunk: string): void {
    this.frameBuffer += chunk;
    while (true) {
      const index = this.frameBuffer.indexOf("\n");
      if (index < 0) return;
      const line = this.frameBuffer.slice(0, index);
      this.frameBuffer = this.frameBuffer.slice(index + 1);
      if (!line.trim()) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.id === "number") {
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? "ACP request failed"));
        else waiter.resolve(message.result);
      } else if (typeof message.method === "string") {
        this.nextSequence += 1;
        if (message.method === "session/request_permission") {
          void this.answerPermission(message);
        } else {
          this.options.onNotification?.({ method: message.method, params: message.params });
        }
      }
    }
  }

  private async answerPermission(message: any): Promise<void> {
    const outcome = this.options.onPermission
      ? await this.options.onPermission(message.params)
      : { outcome: { outcome: "cancelled" } };
    this.write({ jsonrpc: "2.0", id: message.id, result: outcome });
  }

  private write(message: unknown): void {
    if (!this.process || this.closed) return;
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }

  private failPending(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
