import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ACPProfile } from "./acp.ts";

export type ACPConfig = {
  version: 1;
  defaultProfile?: string;
  profiles: ACPProfile[];
  sources?: Array<{ command: string; args?: string[]; env?: Record<string, string> }>;
};

export type ACPBinding = {
  bindingVersion: 1;
  profileID: string;
  acpSessionID: string;
  canonicalCWD: string;
};

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export async function loadConfig(cwd = process.cwd()): Promise<ACPConfig> {
  const globalPath = process.env.PI_ACP_CONFIG ?? join(homedir(), ".pi", "agent", "acp-profiles.json");
  const global = await readJSON(globalPath, { version: 1, profiles: [] });
  validateConfig(global);
  const project = await readJSON(join(cwd, ".pi", "acp.json"), { version: 1 });
  const profiles = new Map(global.profiles.map((profile) => [profile.id, profile]));
  const sourceProfileIDs = new Set<string>();
  for (const source of global.sources ?? []) {
    const result = await runSource(source.command, source.args ?? [], source.env ?? {}, cwd);
    validateConfig(result);
    for (const profile of result.profiles) {
      if (sourceProfileIDs.has(profile.id)) throw new Error(`duplicate ACP profile id from dynamic sources: ${profile.id}`);
      sourceProfileIDs.add(profile.id);
      profiles.set(profile.id, profile);
    }
  }
  return {
    version: 1,
    defaultProfile: process.env.PI_ACP_PROFILE ?? project.defaultProfile ?? global.defaultProfile,
    profiles: [...profiles.values()],
  };
}

export function bindingFromEntries(entries: readonly any[]): ACPBinding | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry?.customType !== "acp-binding") continue;
    const value = entry.data;
    if (value?.bindingVersion === 1 && typeof value.profileID === "string"
        && typeof value.acpSessionID === "string" && typeof value.canonicalCWD === "string") return value;
  }
  return undefined;
}

export function selectedProfileFromEntries(entries: readonly any[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry?.customType !== "acp-profile-selection") continue;
    if (typeof entry.data?.profileID === "string") return entry.data.profileID;
  }
  return undefined;
}

function validateConfig(value: any): asserts value is ACPConfig {
  if (value?.version !== 1 || !Array.isArray(value.profiles)) throw new Error("ACP config must have version 1 and profiles");
  for (const profile of value.profiles) {
    if (!PROFILE_PATTERN.test(profile?.id ?? "") || typeof profile.name !== "string" || typeof profile.command !== "string") {
      throw new Error("ACP profile ids must match [a-z0-9][a-z0-9._-]* and profiles need name/command");
    }
    if (profile.args !== undefined && (!Array.isArray(profile.args) || profile.args.some((arg: unknown) => typeof arg !== "string"))) {
      throw new Error(`invalid args for ACP profile ${profile.id}`);
    }
  }
}

async function readJSON(path: string, fallback: any): Promise<any> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`could not read ACP config ${path}: ${error?.message ?? error}`);
  }
}

async function runSource(command: string, args: string[], env: Record<string, string>, cwd: string): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env: { ...process.env, ...env }, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`ACP profile source failed: ${stderr.trim() || error.message}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error(`ACP profile source returned invalid JSON: ${command}`)); }
    });
  });
}
