import { redirect } from "@sveltejs/kit";
import { getDaemonClient } from "$lib/daemon-client";
import type { LayoutLoad } from "./$types";

/**
 * First-segment denylist for setup-required workspaces. Mirrors AC #21 / design § 9.
 * Note: design doc says `signals` (plural); the on-disk route directory is
 * `signal/[signalId]`, so the denylist matches the actual URL segment.
 */
const OPERATIONAL_SEGMENTS = new Set([
  "chat",
  "agents",
  "jobs",
  "sessions",
  "skills",
  "mcp",
  "signal",
  "edit",
]);

/**
 * Platform-level navigation guard. While `requires_setup === true`, deep links
 * to operational subroutes are bounced to `/platform/{workspaceId}/setup`.
 * The workspace overview, the setup page itself, and any management routes
 * (e.g. delete via API) remain reachable. Failures fetching the config don't
 * block navigation — the page-level loaders surface those errors.
 */
export const load: LayoutLoad = async ({ params, url }) => {
  const workspaceId = params.workspaceId;
  if (!workspaceId) return {};

  const segments = url.pathname.split("/").filter(Boolean);
  const subroute = segments[2];
  if (!subroute || !OPERATIONAL_SEGMENTS.has(subroute)) return {};

  const client = getDaemonClient();
  const res = await client.workspace[":workspaceId"].config.$get({
    param: { workspaceId },
  });
  if (!res.ok) return {};

  const body = await res.json();
  if (body.requires_setup === true) {
    redirect(307, `/platform/${encodeURIComponent(workspaceId)}/setup`);
  }

  return {};
};
