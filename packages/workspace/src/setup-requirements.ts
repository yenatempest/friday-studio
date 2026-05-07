import type { WorkspaceConfig } from "@atlas/config";
import { extractCredentials } from "@atlas/config/mutations";

export type ConfigKeyRequirement = { key: string; description?: string };

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

export type SetupStatus = { requires_setup: boolean; setup_requirements?: SetupRequirements };

export type OverridableRef = { path: string; provider: string; resolvedId: string };

export type ResolvedSetupStatus = SetupStatus & { overridableRefs: OverridableRef[] };

export type ResolveDeps = {
  getDefaultByProvider: (provider: string, userId: string) => Promise<{ id: string } | null>;
  listByProvider: (provider: string, userId: string) => Promise<CredentialOption[]>;
  userId: string;
};

function collectConfigKeyRequirements(config: WorkspaceConfig): ConfigKeyRequirement[] {
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
  return configKeys;
}

/**
 * Synchronous config-only predicate: true iff the workspace has any unfilled
 * `workspace_config` entry.
 *
 * Why split from `resolveWorkspaceSetupRequirements`: config keys can be
 * checked from the parsed YAML alone, but credential requirements need a Link
 * client. Callers that have no Link in scope (e.g. the workspace manager
 * deferring cron / fs-watch registration) use this. Credential-only
 * setup-required workspaces are caught downstream by the runtime gate.
 */
export function hasUnfilledConfigKeys(config: WorkspaceConfig): boolean {
  return collectConfigKeyRequirements(config).length > 0;
}

/**
 * Sync slice — config-keys only. No Link required. For routes that compute
 * setup state pre-Session (`/create`, `/import-bundle`).
 */
export function resolveConfigOnlySetupRequirements(config: WorkspaceConfig): SetupStatus {
  const configKeys = collectConfigKeyRequirements(config);
  if (configKeys.length === 0) return { requires_setup: false };
  return { requires_setup: true, setup_requirements: { configKeys } };
}

/**
 * Derive a workspace's Setup Status from its parsed config.
 *
 * Config Requirements: a `workspace_config` entry is unfilled iff
 * `value === undefined || value === null`. Any other value — including
 * `""`, `0`, `false`, `[]`, `{}` — counts as a deliberate user choice.
 *
 * Credential Requirements: a provider-only link ref is a Requirement when
 * `getDefaultByProvider` returns null for that user. Pre-pinned `id` refs
 * never produce Requirements. Refs whose default resolves are surfaced via
 * `overridableRefs` so the UI can offer opt-in pinning without blocking.
 *
 * Hard errors (unknown providers, expired credentials, deleted pinned ids)
 * are not detected here; they bubble out of the Link client at runtime.
 */
export async function resolveWorkspaceSetupRequirements(
  config: WorkspaceConfig,
  deps: ResolveDeps,
): Promise<ResolvedSetupStatus> {
  const configKeys = collectConfigKeyRequirements(config);

  const usages = extractCredentials(config);
  const providerOnlyRefs = usages.filter(
    (u): u is typeof u & { provider: string } =>
      u.credentialId === undefined && u.provider !== undefined,
  );

  const providers = [...new Set(providerOnlyRefs.map((u) => u.provider))];

  const credentials: CredentialRequirement[] = [];
  const overridableRefs: OverridableRef[] = [];

  for (const provider of providers) {
    const defaultCred = await deps.getDefaultByProvider(provider, deps.userId);

    if (defaultCred === null) {
      const options = await deps.listByProvider(provider, deps.userId);
      credentials.push({ provider, label: provider, options });
      continue;
    }

    for (const ref of providerOnlyRefs) {
      if (ref.provider === provider) {
        overridableRefs.push({ path: ref.path, provider, resolvedId: defaultCred.id });
      }
    }
  }

  const setupRequirements: SetupRequirements = {};
  if (configKeys.length > 0) setupRequirements.configKeys = configKeys;
  if (credentials.length > 0) setupRequirements.credentials = credentials;

  const requires_setup = configKeys.length > 0 || credentials.length > 0;

  if (!requires_setup) {
    return { requires_setup: false, overridableRefs };
  }

  return { requires_setup: true, setup_requirements: setupRequirements, overridableRefs };
}
