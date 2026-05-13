/**
 * Resolves the source-repository URL for an upstream MCP registry entry.
 *
 * Explicit `repository.url` wins. Future fallbacks (name-based inference,
 * npm `homepage`, etc.) plug in behind this single entry point so install,
 * update, and search code stay in lockstep without each carrying its own
 * copy of the rule.
 *
 * @module
 */

import type { UpstreamServer } from "./upstream-client.ts";

const IO_GITHUB_NAME = /^io\.github\.([^/]+)\/([^/]+)$/;

/**
 * Returns the source-repository URL for an upstream server, or `null` when
 * none can be determined.
 */
export function resolveRegistryRepoUrl(server: UpstreamServer): string | null {
  if (server.repository?.url) return server.repository.url;
  return inferGitHubUrlFromName(server.name);
}

function inferGitHubUrlFromName(name: string): string | null {
  const match = IO_GITHUB_NAME.exec(name);
  if (!match) return null;
  const [, owner, repo] = match;
  return `https://github.com/${owner}/${repo}`;
}
