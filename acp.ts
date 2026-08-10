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
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private frameBuffer = "";
  private closed = false;
  private promptTail: Promise<void> = Promise.resolve();
  private initializeResult: any = undefined;

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
    child.on("error", (error) => {
      this.closed = true;
      this.failPending(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("exit", (code, signal) => {
      this.closed = true;
      this.failPending(new Error(`ACP agent exited (${code ?? "signal " + signal})`));
    });
    this.initializeResult = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "pi-acp-client", version: "0.1.0" },
    });
  }

  get supportsSessionList(): boolean {
    return Boolean(this.initializeResult?.agentCapabilities?.sessionCapabilities?.list);
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

  async request(method: string, params?: unknown, signal?: AbortSignal): Promise<any> {
    if (!this.process || this.closed) throw new Error("ACP agent is not running");
    const id = this.nextID++;
    const request = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n";
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => {
        this.pending.delete(id);
        this.write({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
        reject(abortError());
      };
      this.pending.set(id, {
        resolve: (value) => { signal?.removeEventListener("abort", onAbort); resolve(value); },
        reject: (error) => { signal?.removeEventListener("abort", onAbort); reject(error); },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.process?.stdin.write(request);
    });
  }

  async newSession(cwd: string): Promise<{ sessionId: string; [key: string]: any }> {
    return this.request("session/new", { cwd, mcpServers: [] });
  }

  async resume(sessionId: string, cwd: string): Promise<void> {
    await this.request("session/resume", { sessionId, cwd, mcpServers: [] });
  }

  async list(cwd?: string): Promise<any[]> {
    if (!this.supportsSessionList) throw new Error("ACP agent does not advertise session/list");
    const result = await this.request("session/list", cwd ? { cwd } : {});
    return Array.isArray(result?.sessions) ? result.sessions : [];
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request("session/close", { sessionId });
  }

  async prompt(sessionId: string, text: string, metadata: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    let release!: () => void;
    const previous = this.promptTail;
    this.promptTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
        mcpServers: [],
        _meta: metadata,
      }, signal);
    } finally {
      release();
    }
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
        this.closed = true;
        this.failPending(new Error("ACP agent emitted malformed JSON"));
        this.process?.kill();
        return;
      }
      if (typeof message.method === "string") {
        if (message.method === "session/request_permission" && typeof message.id === "number") {
          void this.answerPermission(message);
        } else {
          this.options.onNotification?.({ method: message.method, params: message.params });
        }
      } else if (typeof message.id === "number") {
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? "ACP request failed"));
        else waiter.resolve(message.result);
      }
    }
  }

  private async answerPermission(message: any): Promise<void> {
    let outcome: any;
    try {
      outcome = this.options.onPermission
        ? await this.options.onPermission(message.params)
        : { outcome: { outcome: "cancelled" } };
    } catch {
      outcome = { outcome: { outcome: "cancelled" } };
    }
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

function abortError(): Error {
  const error = new Error("The ACP request was aborted");
  error.name = "AbortError";
  return error;
}
