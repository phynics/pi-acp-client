import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalCWD, loadConfig } from "../config.ts";

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

test("canonicalizes symlinked working directories for durable session bindings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-acp-cwd-"));
  const workspace = join(directory, "workspace");
  const alias = join(directory, "alias");
  await mkdir(workspace);
  await symlink(workspace, alias, "dir");
  assert.equal(canonicalCWD(alias), workspace);
});
