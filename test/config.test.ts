import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.ts";

test("loads versioned profiles and project default without executable project config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-acp-client-"));
  const configPath = join(directory, "profiles.json");
  await writeFile(configPath, JSON.stringify({ version: 1, profiles: [{ id: "example", name: "Example", command: "example-acp" }] }));
  const previous = process.env.PI_ACP_CONFIG;
  process.env.PI_ACP_CONFIG = configPath;
  try {
    const config = await loadConfig(directory);
    assert.equal(config.profiles[0].id, "example");
  } finally {
    if (previous === undefined) delete process.env.PI_ACP_CONFIG;
    else process.env.PI_ACP_CONFIG = previous;
  }
});
