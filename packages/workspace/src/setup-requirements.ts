import type { WorkspaceConfig } from "@atlas/config";

export type ConfigKeyRequirement = {
  key: string;
  description?: string;
};

export type CredentialOption = {
  id: string;
  label: string;
  displayName: string | null;
  userIdentifier: string | null;
  isDefault: boolean;
};

export type CredentialRequirement = {
  provider: string;
  label?: string;
  options: CredentialOption[];
};

export type SetupRequirements = {
  configKeys?: ConfigKeyRequirement[];
  credentials?: CredentialRequirement[];
};

export type SetupStatus = {
  requires_setup: boolean;
  setup_requirements?: SetupRequirements;
};

/**
 * Derive a workspace's Setup Status from its parsed config.
 *
 * A `workspace_config` entry is unfilled iff `value === undefined || value === null`.
 * Any other value — including `""`, `0`, `false`, `[]`, `{}` — counts as filled
 * (a deliberate user choice for the entry's declared schema).
 *
 * Pure: no I/O, no Link calls. Credential Requirements are added in a later task.
 */
export function resolveWorkspaceSetupRequirements(config: WorkspaceConfig): SetupStatus {
  const configKeys: ConfigKeyRequirement[] = [];

  for (const [key, entry] of Object.entries(config.workspace_config ?? {})) {
    if (entry.value === undefined || entry.value === null) {
      const requirement: ConfigKeyRequirement = { key };
      if (entry.description !== undefined) {
        requirement.description = entry.description;
      }
      configKeys.push(requirement);
    }
  }

  if (configKeys.length === 0) {
    return { requires_setup: false };
  }

  return {
    requires_setup: true,
    setup_requirements: { configKeys },
  };
}
