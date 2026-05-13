/**
 * Tests for the registry repository-URL resolver.
 */

import { describe, it } from "vitest";
import { resolveRegistryRepoUrl } from "./repo-url-resolver.ts";
import type { UpstreamServer } from "./upstream-client.ts";

function makeServer(
  overrides: Partial<UpstreamServer> & Pick<UpstreamServer, "name">,
): UpstreamServer {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    version: "1.0.0",
    ...overrides,
  };
}

describe("resolveRegistryRepoUrl", () => {
  it("returns the explicit repository.url verbatim, even when the name would infer a different URL", ({
    expect,
  }) => {
    const server = makeServer({
      name: "io.github.owner/repo",
      repository: { url: "https://github.com/different-owner/different-repo" },
    });
    expect(resolveRegistryRepoUrl(server)).toBe(
      "https://github.com/different-owner/different-repo",
    );
  });

  it("infers https://github.com/OWNER/REPO from an io.github.OWNER/REPO name when repository is unset", ({
    expect,
  }) => {
    const server = makeServer({ name: "io.github.MatanYemini/bitbucket-mcp" });
    expect(resolveRegistryRepoUrl(server)).toBe("https://github.com/MatanYemini/bitbucket-mcp");
  });

  it("returns null when repository is unset and the name does not match the io.github convention", ({
    expect,
  }) => {
    expect(resolveRegistryRepoUrl(makeServer({ name: "com.acme.foo" }))).toBeNull();
    expect(resolveRegistryRepoUrl(makeServer({ name: "something-mcp" }))).toBeNull();
  });

  it("returns null for io.github names with extra path segments beyond OWNER/REPO", ({
    expect,
  }) => {
    expect(resolveRegistryRepoUrl(makeServer({ name: "io.github.owner/repo/extra" }))).toBeNull();
  });
});
