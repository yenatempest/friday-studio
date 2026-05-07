import {
  type CredentialSummary,
  resolveCredentialsByProvider,
} from "@atlas/core/mcp-registry/credential-resolver";
import type { ResolveDeps } from "@atlas/workspace";

/**
 * Daemon-side adapter wiring `resolveWorkspaceSetupRequirements`'s `ResolveDeps`
 * onto the existing Link HTTP client. The Link service authenticates the
 * daemon via `FRIDAY_KEY` (or skips auth in `LINK_DEV_MODE`) and resolves the
 * caller's user-scoped credentials from that — so `userId` is informational
 * here and not threaded into the HTTP call. Errors (no credentials, unknown
 * provider) collapse to "no default" / empty list so the gate treats absence
 * of credentials as setup-required rather than failing the whole signal.
 */
export function buildSetupResolveDeps(userId: string): ResolveDeps {
  return {
    userId,
    getDefaultByProvider: async (provider) => {
      try {
        const summaries = await resolveCredentialsByProvider(provider);
        const def = summaries.find((s) => s.isDefault);
        return def ? { id: def.id } : null;
      } catch {
        return null;
      }
    },
    listByProvider: async (provider) => {
      try {
        const summaries = await resolveCredentialsByProvider(provider);
        return summaries.map(toCredentialOption);
      } catch {
        return [];
      }
    },
  };
}

function toCredentialOption(s: CredentialSummary) {
  return {
    id: s.id,
    label: s.label,
    displayName: s.displayName,
    userIdentifier: s.userIdentifier,
    isDefault: s.isDefault,
  };
}
