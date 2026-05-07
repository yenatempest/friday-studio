import { WorkspaceConfigSchema } from "@atlas/config";
import { describe, expect, it, vi } from "vitest";
import {
  type CredentialOption,
  hasUnfilledConfigKeys,
  resolveConfigOnlySetupRequirements,
  type ResolveDeps,
  resolveWorkspaceSetupRequirements,
} from "../setup-requirements.ts";

const baseConfig = { version: "1.0", workspace: { name: "test-workspace" } } as const;

function parse(input: Record<string, unknown>) {
  return WorkspaceConfigSchema.parse({ ...baseConfig, ...input });
}

function noCredentialDeps(): ResolveDeps {
  return {
    getDefaultByProvider: vi.fn(async () => null),
    listByProvider: vi.fn(async () => []),
    userId: "user-1",
  };
}

function mcpServerWithEnv(env: Record<string, unknown>) {
  return {
    tools: {
      mcp: { servers: { "test-server": { transport: { type: "stdio", command: "echo" }, env } } },
    },
  };
}

describe("hasUnfilledConfigKeys", () => {
  it("returns false when workspace_config is absent", () => {
    expect(hasUnfilledConfigKeys(parse({}))).toBe(false);
  });

  it("returns false when every entry is filled", () => {
    const config = parse({ workspace_config: { email: { value: "x@y.z" } } });
    expect(hasUnfilledConfigKeys(config)).toBe(false);
  });

  it("returns true when any entry has no value field", () => {
    const config = parse({ workspace_config: { email: {} } });
    expect(hasUnfilledConfigKeys(config)).toBe(true);
  });

  it("returns true when any entry has value: null", () => {
    const config = parse({ workspace_config: { email: { value: null } } });
    expect(hasUnfilledConfigKeys(config)).toBe(true);
  });

  it.each<[label: string, value: unknown]>([
    ["empty string", ""],
    ["zero", 0],
    ["false", false],
    ["empty array", []],
    ["empty object", {}],
  ])("treats value: %s as filled", (_label, value) => {
    const config = parse({ workspace_config: { k: { value } } });
    expect(hasUnfilledConfigKeys(config)).toBe(false);
  });
});

describe("resolveConfigOnlySetupRequirements", () => {
  it("returns requires_setup: false when no workspace_config block is present", () => {
    expect(resolveConfigOnlySetupRequirements(parse({}))).toEqual({ requires_setup: false });
  });

  it("returns requires_setup: false when every entry has a non-null value", () => {
    const config = parse({
      workspace_config: { api_key: { description: "API key", value: "secret" } },
    });
    expect(resolveConfigOnlySetupRequirements(config)).toEqual({ requires_setup: false });
  });

  it("returns requires_setup: true with matching configKeys when an entry is unfilled", () => {
    const config = parse({
      workspace_config: {
        api_key: { description: "API key", value: null },
        region: { value: "us-east-1" },
      },
    });
    expect(resolveConfigOnlySetupRequirements(config)).toEqual({
      requires_setup: true,
      setup_requirements: { configKeys: [{ key: "api_key", description: "API key" }] },
    });
  });

  it("treats undefined value the same as null", () => {
    const config = parse({ workspace_config: { api_key: { description: "API key" } } });
    expect(resolveConfigOnlySetupRequirements(config)).toEqual({
      requires_setup: true,
      setup_requirements: { configKeys: [{ key: "api_key", description: "API key" }] },
    });
  });
});

describe("resolveWorkspaceSetupRequirements", () => {
  describe("Config Requirements", () => {
    it("returns requires_setup: false when there are no Requirements", async () => {
      const status = await resolveWorkspaceSetupRequirements(parse({}), noCredentialDeps());
      expect(status).toEqual({ requires_setup: false, overridableRefs: [] });
    });

    it("emits a configKey requirement for an unfilled entry", async () => {
      const config = parse({ workspace_config: { email: { description: "Recipient" } } });
      const status = await resolveWorkspaceSetupRequirements(config, noCredentialDeps());
      expect(status.requires_setup).toBe(true);
      expect(status.setup_requirements?.configKeys).toEqual([
        { key: "email", description: "Recipient" },
      ]);
    });

    it("treats value: null as unfilled", async () => {
      const config = parse({ workspace_config: { email: { value: null } } });
      const status = await resolveWorkspaceSetupRequirements(config, noCredentialDeps());
      expect(status.setup_requirements?.configKeys).toEqual([{ key: "email" }]);
    });

    it.each<[label: string, value: unknown]>([
      ["empty string", ""],
      ["zero", 0],
      ["false", false],
      ["empty array", []],
      ["empty object", {}],
    ])("treats value: %s as filled", async (_label, value) => {
      const config = parse({ workspace_config: { k: { value } } });
      const status = await resolveWorkspaceSetupRequirements(config, noCredentialDeps());
      expect(status).toEqual({ requires_setup: false, overridableRefs: [] });
    });

    it("preserves declaration order across mixed filled/unfilled entries", async () => {
      const config = parse({
        workspace_config: {
          alpha: { value: "filled" },
          bravo: { description: "second" },
          charlie: { value: 0 },
          delta: { value: null, description: "fourth" },
          echo: { value: false },
        },
      });
      const status = await resolveWorkspaceSetupRequirements(config, noCredentialDeps());
      expect(status.setup_requirements?.configKeys).toEqual([
        { key: "bravo", description: "second" },
        { key: "delta", description: "fourth" },
      ]);
    });

    it("omits description when the entry has none", async () => {
      const config = parse({ workspace_config: { bare: { value: null } } });
      const status = await resolveWorkspaceSetupRequirements(config, noCredentialDeps());
      const requirement = status.setup_requirements?.configKeys?.[0];
      expect(requirement).toEqual({ key: "bare" });
      expect(requirement && "description" in requirement).toBe(false);
    });
  });

  describe("Credential Requirements", () => {
    it("zero credentials, no default → Requirement with options: []", async () => {
      const config = parse(
        mcpServerWithEnv({ GITHUB_TOKEN: { from: "link", provider: "github", key: "token" } }),
      );
      const deps: ResolveDeps = {
        getDefaultByProvider: vi.fn(async () => null),
        listByProvider: vi.fn(async () => []),
        userId: "user-1",
      };

      const status = await resolveWorkspaceSetupRequirements(config, deps);

      expect(status.requires_setup).toBe(true);
      expect(status.setup_requirements?.credentials).toEqual([
        { provider: "github", label: "github", options: [] },
      ]);
      expect(status.overridableRefs).toEqual([]);
      expect(deps.getDefaultByProvider).toHaveBeenCalledTimes(1);
      expect(deps.listByProvider).toHaveBeenCalledTimes(1);
    });

    it("multiple credentials, no default → Requirement surfaces all options with isDefault: false", async () => {
      const config = parse(
        mcpServerWithEnv({ SLACK_TOKEN: { from: "link", provider: "slack", key: "token" } }),
      );
      const options: CredentialOption[] = [
        {
          id: "cred_a",
          label: "slack",
          displayName: "Work",
          userIdentifier: "alice@work",
          isDefault: false,
        },
        {
          id: "cred_b",
          label: "slack",
          displayName: "Personal",
          userIdentifier: "alice@home",
          isDefault: false,
        },
      ];
      const deps: ResolveDeps = {
        getDefaultByProvider: vi.fn(async () => null),
        listByProvider: vi.fn(async () => options),
        userId: "user-1",
      };

      const status = await resolveWorkspaceSetupRequirements(config, deps);

      expect(status.setup_requirements?.credentials).toEqual([
        { provider: "slack", label: "slack", options },
      ]);
      expect(status.overridableRefs).toEqual([]);
    });

    it("single credential auto-default → no Requirement, ref appears in overridableRefs", async () => {
      const config = parse(
        mcpServerWithEnv({
          GMAIL_TOKEN: { from: "link", provider: "google-gmail", key: "access_token" },
        }),
      );
      const deps: ResolveDeps = {
        getDefaultByProvider: vi.fn(async () => ({ id: "cred_default" })),
        listByProvider: vi.fn(async () => []),
        userId: "user-1",
      };

      const status = await resolveWorkspaceSetupRequirements(config, deps);

      expect(status.requires_setup).toBe(false);
      expect(status.setup_requirements).toBeUndefined();
      expect(status.overridableRefs).toEqual([
        {
          path: "mcp:test-server:GMAIL_TOKEN",
          provider: "google-gmail",
          resolvedId: "cred_default",
        },
      ]);
      expect(deps.listByProvider).not.toHaveBeenCalled();
    });

    it("pre-pinned id ref → no Requirement, no overridableRefs entry, no Link calls for that provider", async () => {
      const config = parse(
        mcpServerWithEnv({
          GH_TOKEN: { from: "link", id: "cred_pinned", provider: "github", key: "token" },
        }),
      );
      const deps: ResolveDeps = {
        getDefaultByProvider: vi.fn(async () => null),
        listByProvider: vi.fn(async () => []),
        userId: "user-1",
      };

      const status = await resolveWorkspaceSetupRequirements(config, deps);

      expect(status.requires_setup).toBe(false);
      expect(status.overridableRefs).toEqual([]);
      expect(deps.getDefaultByProvider).not.toHaveBeenCalled();
      expect(deps.listByProvider).not.toHaveBeenCalled();
    });

    it("dedupes per provider: two refs for the same provider issue one default lookup", async () => {
      const config = parse({
        tools: {
          mcp: {
            servers: {
              "server-a": {
                transport: { type: "stdio", command: "echo" },
                env: { TOK_A: { from: "link", provider: "slack", key: "token" } },
              },
              "server-b": {
                transport: { type: "stdio", command: "echo" },
                env: { TOK_B: { from: "link", provider: "slack", key: "token" } },
              },
            },
          },
        },
      });
      const deps: ResolveDeps = {
        getDefaultByProvider: vi.fn(async () => null),
        listByProvider: vi.fn(async () => []),
        userId: "user-1",
      };

      const status = await resolveWorkspaceSetupRequirements(config, deps);

      expect(status.setup_requirements?.credentials).toEqual([
        { provider: "slack", label: "slack", options: [] },
      ]);
      expect(deps.getDefaultByProvider).toHaveBeenCalledTimes(1);
      expect(deps.listByProvider).toHaveBeenCalledTimes(1);
    });

    it("dedupes per provider: two refs with default → both surface in overridableRefs, one default lookup", async () => {
      const config = parse({
        tools: {
          mcp: {
            servers: {
              "server-a": {
                transport: { type: "stdio", command: "echo" },
                env: { TOK_A: { from: "link", provider: "slack", key: "token" } },
              },
              "server-b": {
                transport: { type: "stdio", command: "echo" },
                env: { TOK_B: { from: "link", provider: "slack", key: "token" } },
              },
            },
          },
        },
      });
      const deps: ResolveDeps = {
        getDefaultByProvider: vi.fn(async () => ({ id: "cred_default" })),
        listByProvider: vi.fn(async () => []),
        userId: "user-1",
      };

      const status = await resolveWorkspaceSetupRequirements(config, deps);

      expect(status.requires_setup).toBe(false);
      expect(status.overridableRefs).toEqual([
        { path: "mcp:server-a:TOK_A", provider: "slack", resolvedId: "cred_default" },
        { path: "mcp:server-b:TOK_B", provider: "slack", resolvedId: "cred_default" },
      ]);
      expect(deps.getDefaultByProvider).toHaveBeenCalledTimes(1);
    });
  });

  describe("Combined Requirements", () => {
    it("surfaces both Config and Credential Requirements together", async () => {
      const config = parse({
        ...mcpServerWithEnv({ GITHUB_TOKEN: { from: "link", provider: "github", key: "token" } }),
        workspace_config: { email: { description: "Recipient" } },
      });
      const deps: ResolveDeps = {
        getDefaultByProvider: vi.fn(async () => null),
        listByProvider: vi.fn(async () => []),
        userId: "user-1",
      };

      const status = await resolveWorkspaceSetupRequirements(config, deps);

      expect(status.requires_setup).toBe(true);
      expect(status.setup_requirements?.configKeys).toEqual([
        { key: "email", description: "Recipient" },
      ]);
      expect(status.setup_requirements?.credentials).toEqual([
        { provider: "github", label: "github", options: [] },
      ]);
    });
  });
});
