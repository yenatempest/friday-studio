/**
 * Mutations for the `workspace_config` block.
 *
 * Setup Completion writes user-supplied values into `workspace_config[key].value`
 * via a single `applyMutation` call.
 */

import { produce } from "immer";
import type { WorkspaceConfig } from "../workspace.ts";
import { type MutationResult, validationError } from "./types.ts";

/**
 * Sets `workspace_config[key].value` for each key in `values`.
 *
 * Returns a validation error if the config has no `workspace_config` block —
 * the route is only meant to be hit when setup detection has populated it.
 * Unknown keys (present in `values` but not declared in YAML) also produce
 * a validation error to avoid silently writing values that no Config
 * Requirement points at.
 */
export function setWorkspaceConfigValues(
  config: WorkspaceConfig,
  values: Record<string, string>,
): MutationResult<WorkspaceConfig> {
  const declared = config.workspace_config;
  if (!declared) {
    return {
      ok: false,
      error: validationError("Workspace has no workspace_config block; nothing to set."),
    };
  }

  const unknownKeys = Object.keys(values).filter((k) => !(k in declared));
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      error: validationError(`Unknown workspace_config key(s): ${unknownKeys.join(", ")}`),
    };
  }

  const next = produce(config, (draft) => {
    const block = draft.workspace_config;
    if (!block) return;
    for (const [key, value] of Object.entries(values)) {
      const entry = block[key];
      if (entry) {
        entry.value = value;
      }
    }
  });

  return { ok: true, value: next };
}
