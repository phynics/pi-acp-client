import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import piACPClient from "../index.ts";
import { loadProfileConfig } from "../config.ts";

async function withConfig(config: unknown, run: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-acp-discovery-"));
  const configPath = join(directory, "profiles.json");
  await writeFile(configPath, JSON.stringify(config));
  const previous = process.env.PI_ACP_CONFIG;
  process.env.PI_ACP_CONFIG = configPath;
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env.PI_ACP_CONFIG;
    else process.env.PI_ACP_CONFIG = previous;
  }
}

test("async factory awaits validated dynamic discovery before registering models", async () => {
  const bundle = JSON.stringify({ version: 1, profiles: [{ id: "async", name: "Async", command: "agent" }] });
  await withConfig({ version: 1, profiles: [], sources: [{
    command: process.execPath,
    args: ["-e", `setTimeout(() => process.stdout.write(${JSON.stringify(bundle)}), 30)`],
  }] }, async () => {
    let provider: any;
    await piACPClient({
      registerProvider(_id: string, value: any) { provider = value; },
      registerCommand() {}, on() {}, getActiveTools() { return []; }, setActiveTools() {},
    } as any);
    assert.deepEqual(provider.models.map((model: any) => [model.id, model.name]), [["acp/async", "ACP: Async"]]);
    assert.deepEqual((await loadProfileConfig()).profiles.map((profile) => profile.id), ["async"]);
  });
});

test("dynamic source timeout and failure reject discovery", async () => {
  await withConfig({ version: 1, profiles: [], sources: [{
    command: process.execPath, args: ["-e", "setTimeout(() => {}, 30_000)"],
  }] }, async () => {
    const started = Date.now();
    await assert.rejects(loadProfileConfig(), /ACP profile source failed/);
    assert.ok(Date.now() - started < 5_000, "timed out source should be terminated promptly");
  });

  await withConfig({ version: 1, profiles: [], sources: [{
    command: process.execPath, args: ["-e", "process.stderr.write('source broke'); process.exit(2)"],
  }] }, async () => {
    await assert.rejects(loadProfileConfig(), /ACP profile source failed: source broke/);
  });
});
