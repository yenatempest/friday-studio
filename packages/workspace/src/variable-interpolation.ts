/**
 * Workspace variable interpolation.
 *
 * Resolves `{{double_brace}}` placeholders in parsed workspace config objects
 * at config-load time. The daemon knows the workspace path, can derive the
 * repo root, and knows its own URL — so these values are injected before any
 * FSM engine or agent prompt sees the config.
 *
 * Uses `{{double_brace}}` syntax to distinguish from the `{singleBrace}`
 * convention used in agent prompt text as documentation placeholders that
 * agents resolve themselves at runtime. Only `{{...}}` is machine-resolved.
 */

import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "@atlas/logger";
import { z } from "zod";

/**
 * Well-known workspace variables resolved by the daemon at config-load time.
 */
export const WorkspaceVariablesSchema = z.object({
  repo_root: z.string(),
  workspace_path: z.string(),
  workspace_id: z.string(),
  platform_url: z.string().default("http://localhost:8080"),
});

export type WorkspaceVariables = z.infer<typeof WorkspaceVariablesSchema>;

/**
 * Pattern matching `{{key}}` or `{{ns.subkey}}` — captures the (possibly dotted)
 * key name. One level of dotted nesting is supported, scoped to the
 * `workspace_config.<key>` namespace produced by `buildWorkspaceConfigBag`.
 */
const PLACEHOLDER_RE = /\{\{([a-z_]+(?:\.[a-z_]+)?)\}\}/g;

const WORKSPACE_CONFIG_PREFIX = "workspace_config.";

/**
 * Per-entry filled values from `workspace.yml`'s `workspace_config:` block,
 * coerced to string. Keys are bare config keys (no `workspace_config.` prefix).
 * Built by `buildWorkspaceConfigBag` from the parsed config.
 */
export type WorkspaceConfigBag = Record<string, string>;

/**
 * Recursively walk a parsed config object and replace `{{key}}` and
 * `{{workspace_config.<key>}}` placeholders in every string value.
 *
 * - Non-string values (numbers, booleans, null) are returned as-is.
 * - Unknown placeholders are left untouched (a warning is logged).
 * - The function is pure modulo logging — it returns a new object tree.
 */
export function interpolateConfig<T>(
  value: T,
  variables: WorkspaceVariables,
  configBag?: WorkspaceConfigBag,
): T {
  if (typeof value === "string") {
    return interpolateString(value, variables, configBag) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateConfig(item, variables, configBag)) as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolateConfig(v, variables, configBag);
    }
    return result as T;
  }
  return value;
}

function interpolateString(
  str: string,
  variables: WorkspaceVariables,
  configBag: WorkspaceConfigBag | undefined,
): string {
  const knownKeys = new Set(Object.keys(variables));
  return str.replace(PLACEHOLDER_RE, (match, key: string) => {
    if (key.startsWith(WORKSPACE_CONFIG_PREFIX)) {
      const subKey = key.slice(WORKSPACE_CONFIG_PREFIX.length);
      const resolved = configBag?.[subKey];
      if (resolved !== undefined) {
        return resolved;
      }
      logger.warn("Unfilled workspace_config placeholder, leaving as-is", {
        placeholder: match,
        key: subKey,
      });
      return match;
    }
    if (knownKeys.has(key)) {
      return variables[key as keyof WorkspaceVariables];
    }
    logger.warn("Unknown workspace variable placeholder, leaving as-is", {
      placeholder: match,
      key,
    });
    return match;
  });
}

function coerceConfigValue(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Build the `workspace_config` namespace bag from a parsed `WorkspaceConfig`.
 * Includes only entries whose `value` is non-null and non-undefined — unfilled
 * entries stay literal at substitution time so the existing warning fires
 * and the setup gate keeps the workspace from running.
 */
export function buildWorkspaceConfigBag(parsed: {
  workspace_config?: Record<string, { value?: unknown } | undefined>;
}): WorkspaceConfigBag {
  const entries = parsed.workspace_config ?? {};
  const bag: WorkspaceConfigBag = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (entry && entry.value !== undefined && entry.value !== null) {
      bag[key] = coerceConfigValue(entry.value);
    }
  }
  return bag;
}

/**
 * Walk up the filesystem from `startPath` until we find a `.git` entry
 * (directory or worktree file), then return that ancestor as the repo root.
 *
 * Returns `null` if no `.git` ancestor is found.
 *
 * Extracted from `workspaces/system/jobs/decompose-plan/job.ts` for reuse.
 */
// Sync stat check wrapped in async API for caller ergonomics
// deno-lint-ignore require-await
export async function findRepoRoot(startPath: string): Promise<string | null> {
  let dir = dirname(startPath);
  while (true) {
    const gitEntry = join(dir, ".git");
    try {
      statSync(gitEntry);
      return dir;
    } catch {
      // Not found at this level — walk up.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Build the `WorkspaceVariables` record from daemon-known values.
 *
 * @param workspacePath Absolute path to the workspace directory on disk.
 * @param workspaceId   The workspace's stable identifier.
 * @param daemonUrl     The daemon's base URL (defaults to http://localhost:8080).
 * @returns Parsed `WorkspaceVariables` or `null` if repo_root cannot be derived.
 */
export async function resolveWorkspaceVariables(
  workspacePath: string,
  workspaceId: string,
  daemonUrl?: string,
): Promise<WorkspaceVariables | null> {
  const repoRoot = await findRepoRoot(workspacePath);
  if (!repoRoot) {
    logger.warn("Could not derive repo_root for workspace variable interpolation", {
      workspacePath,
    });
    return null;
  }

  return WorkspaceVariablesSchema.parse({
    repo_root: repoRoot,
    workspace_path: workspacePath,
    workspace_id: workspaceId,
    platform_url: daemonUrl ?? "http://localhost:8080",
  });
}
