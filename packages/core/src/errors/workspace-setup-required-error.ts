/**
 * Thrown when a runtime entry point (chat, signal trigger) is reached for a
 * workspace whose `workspace_config` has unfilled values or whose provider-only
 * credential refs lack a Link default. Lets route handlers and chat callers use
 * `instanceof` to map the gate trip to a 409/setup-required HTTP response or
 * a chat-side surface, without string matching on error messages.
 */
export class WorkspaceSetupRequiredError extends Error {
  override readonly name = "WorkspaceSetupRequiredError";

  constructor(public readonly workspaceId: string) {
    super(`Workspace ${workspaceId} requires setup before agents can run.`);
  }
}
