/**
 * Integration tests for POST /create (requires_setup flag).
 *
 * Tests the create endpoint sets requires_setup when credentials can't resolve.
 */

import { createStubPlatformModels } from "@atlas/llm";
import type { WorkspaceManager } from "@atlas/workspace";
import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";

// Mock storage (FilesystemWorkspaceCreationAdapter used in create)
const mockWriteWorkspaceFiles = vi.hoisted(() =>
  vi
    .fn<(path: string, yaml: string, opts?: unknown) => Promise<void>>()
    .mockResolvedValue(undefined),
);
vi.mock("@atlas/storage", () => ({
  FilesystemWorkspaceCreationAdapter: class {
    createWorkspaceDirectory = vi.fn().mockResolvedValue("/tmp/test-ws");
    writeWorkspaceFiles = mockWriteWorkspaceFiles;
  },
}));

// Mock credential resolver
const mockResolveCredentialsByProvider = vi.hoisted(() => vi.fn());
const mockFetchLinkCredential = vi.hoisted(() => vi.fn());
vi.mock("@atlas/core/mcp-registry/credential-resolver", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@atlas/core/mcp-registry/credential-resolver")>();
  return {
    ...original,
    resolveCredentialsByProvider: mockResolveCredentialsByProvider,
    fetchLinkCredential: mockFetchLinkCredential,
  };
});

// Mock getCurrentUser
vi.mock("../me/adapter.ts", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ ok: true, data: { id: "user-1" } }),
}));

// Mock writeFile used to update workspace config
const mockWriteFile = vi.hoisted(() =>
  vi.fn<(path: string, data: string | Uint8Array) => Promise<void>>().mockResolvedValue(undefined),
);
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, writeFile: mockWriteFile };
});

/** Minimal workspace config with a single MCP server that has a provider-only credential ref. */
function configWithProvider(provider: string) {
  return {
    version: "1.0",
    workspace: { name: "Test Workspace" },
    tools: {
      mcp: {
        servers: {
          myserver: {
            transport: { type: "stdio", command: "npx", args: ["-y", "some-server"] },
            env: { TOKEN: { from: "link", provider, key: "access_token" } },
          },
        },
      },
    },
  };
}

/** Config with two providers. */
function configWithTwoProviders(providerA: string, providerB: string) {
  return {
    version: "1.0",
    workspace: { name: "Test Workspace" },
    tools: {
      mcp: {
        servers: {
          serverA: {
            transport: { type: "stdio", command: "npx", args: ["-y", "server-a"] },
            env: { TOKEN_A: { from: "link", provider: providerA, key: "access_token" } },
          },
          serverB: {
            transport: { type: "stdio", command: "npx", args: ["-y", "server-b"] },
            env: { TOKEN_B: { from: "link", provider: providerB, key: "access_token" } },
          },
        },
      },
    },
  };
}

/** Config with no credential refs. */
function configWithNoCredentials() {
  return {
    version: "1.0",
    workspace: { name: "Test Workspace" },
    tools: {
      mcp: {
        servers: {
          myserver: { transport: { type: "stdio", command: "npx", args: ["-y", "some-server"] } },
        },
      },
    },
  };
}

/** Config with one unfilled `workspace_config` entry. */
function configWithUnfilledWorkspaceConfig() {
  return {
    version: "1.0",
    workspace: { name: "Test Workspace" },
    workspace_config: { api_key: { description: "API key", value: null } },
  };
}

/** Config with all `workspace_config` entries filled. */
function configWithFilledWorkspaceConfig() {
  return {
    version: "1.0",
    workspace: { name: "Test Workspace" },
    workspace_config: { api_key: { description: "API key", value: "secret-1" } },
  };
}

type JsonBody = Record<string, unknown>;

function createTestApp() {
  const updateWorkspaceStatus = vi.fn().mockResolvedValue(undefined);
  const registerWorkspace = vi
    .fn()
    .mockImplementation((_path: string, opts?: { name?: string }) => {
      const ws = {
        id: "ws-new-id",
        name: opts?.name ?? "Test Workspace",
        path: "/tmp/test-ws",
        configPath: "/tmp/test-ws/workspace.yml",
        status: "inactive" as const,
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        metadata: {},
      };
      return Promise.resolve({ workspace: ws, created: true });
    });

  // The default workspace config baseline mounts narrative stores from the
  // `user` workspace; the route validator (`workspaceList.has`) refuses
  // creation if a referenced workspace is unknown. Resolve `user` here so
  // tests don't trip the `unknown_mount_workspace` hard_fail.
  const find = vi.fn().mockImplementation(({ id }: { id: string }) => {
    if (id === "user") {
      return Promise.resolve({
        id: "user",
        name: "Personal",
        path: "/tmp/user-ws",
        configPath: "/tmp/user-ws/workspace.yml",
        status: "inactive" as const,
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        metadata: {},
      });
    }
    return Promise.resolve(null);
  });
  const getWorkspaceConfig = vi.fn();
  const handleWorkspaceConfigChange = vi.fn().mockResolvedValue(undefined);

  const mockWorkspaceManager = {
    find,
    getWorkspaceConfig,
    list: vi.fn().mockResolvedValue([]),
    registerWorkspace,
    deleteWorkspace: vi.fn(),
    updateWorkspaceStatus,
    handleWorkspaceConfigChange,
  } as unknown as WorkspaceManager;

  const mockContext: AppContext = {
    runtimes: new Map(),
    startTime: Date.now(),
    sseClients: new Map(),
    sseStreams: new Map(),
    getWorkspaceManager: () => mockWorkspaceManager,
    getOrCreateWorkspaceRuntime: vi.fn(),
    resetIdleTimeout: vi.fn(),
    getWorkspaceRuntime: vi.fn(),
    destroyWorkspaceRuntime: vi.fn(),
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    evictChatSdkInstance: vi.fn(),
    daemon: { getWorkspaceManager: () => mockWorkspaceManager } as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
    chatTurnRegistry: {} as AppContext["chatTurnRegistry"],
    sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
    sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
    exposeKernel: false,
    platformModels: createStubPlatformModels(),
  };

  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    await next();
  });

  return {
    app,
    registerWorkspace,
    updateWorkspaceStatus,
    find,
    getWorkspaceConfig,
    handleWorkspaceConfigChange,
  };
}

async function mountRoutes(app: Hono<AppVariables>) {
  const { workspacesRoutes } = await import("./index.ts");
  app.route("/", workspacesRoutes);
  return app;
}

describe("POST /create — credentials and skipEnvValidation", () => {
  beforeEach(() => {
    vi.resetModules();
    mockResolveCredentialsByProvider.mockReset();
    mockFetchLinkCredential.mockReset();
    mockWriteFile.mockReset().mockResolvedValue(undefined);
  });

  test("skips env validation when credentials cannot be resolved", {
    timeout: 15_000,
  }, async () => {
    const { app, registerWorkspace, updateWorkspaceStatus } = createTestApp();
    await mountRoutes(app);

    const { CredentialNotFoundError } = await import(
      "@atlas/core/mcp-registry/credential-resolver"
    );
    mockResolveCredentialsByProvider.mockRejectedValue(new CredentialNotFoundError("github"));

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithProvider("github") }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);

    // Env validation skipped because credentials are unresolved
    expect(registerWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ skipEnvValidation: true }),
    );

    // No metadata.requires_setup write — derived flag now lives in the response
    expect(updateWorkspaceStatus).not.toHaveBeenCalled();
  });

  test("runs env validation when all credentials resolve", async () => {
    const { app, registerWorkspace, updateWorkspaceStatus } = createTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockResolvedValue([{ id: "cred-1", label: "My GitHub" }]);

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithProvider("github") }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);

    expect(registerWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ skipEnvValidation: false }),
    );

    expect(updateWorkspaceStatus).not.toHaveBeenCalled();
  });

  test("runs env validation when no credentials are needed", async () => {
    const { app, updateWorkspaceStatus } = createTestApp();
    await mountRoutes(app);

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithNoCredentials() }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);

    expect(updateWorkspaceStatus).not.toHaveBeenCalled();
  });

  test("partial resolution: skips env validation, returns resolvedCredentials", async () => {
    const { app, registerWorkspace, updateWorkspaceStatus } = createTestApp();
    await mountRoutes(app);

    const { CredentialNotFoundError } = await import(
      "@atlas/core/mcp-registry/credential-resolver"
    );

    // github resolves, slack does not
    mockResolveCredentialsByProvider
      .mockResolvedValueOnce([{ id: "cred-gh", label: "My GitHub" }])
      .mockRejectedValueOnce(new CredentialNotFoundError("slack"));

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithTwoProviders("github", "slack") }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);

    expect(registerWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ skipEnvValidation: true }),
    );

    expect(updateWorkspaceStatus).not.toHaveBeenCalled();

    expect(body.resolvedCredentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "github", credentialId: "cred-gh" }),
      ]),
    );
  });
});

describe("POST /create — setupRequired in response", () => {
  beforeEach(() => {
    vi.resetModules();
    mockResolveCredentialsByProvider.mockReset();
    mockFetchLinkCredential.mockReset();
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockWriteWorkspaceFiles.mockReset().mockResolvedValue(undefined);
  });

  test("returns setupRequired: true with matching configKeys when an entry is unfilled", async () => {
    const { app } = createTestApp();
    await mountRoutes(app);

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithUnfilledWorkspaceConfig() }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.setupRequired).toBe(true);
    expect(body.setup_requirements).toMatchObject({
      configKeys: [{ key: "api_key", description: "API key" }],
    });
  });

  test("returns setupRequired: false with no setup_requirements when all entries are filled", async () => {
    const { app } = createTestApp();
    await mountRoutes(app);

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithFilledWorkspaceConfig() }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.setupRequired).toBe(false);
    expect(body.setup_requirements).toBeUndefined();
  });

  test("returns setupRequired: false when no workspace_config block is present", async () => {
    const { app } = createTestApp();
    await mountRoutes(app);

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithNoCredentials() }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.setupRequired).toBe(false);
    expect(body.setup_requirements).toBeUndefined();
  });

  test("preserves single-credential auto-pin: pinned id lands in YAML", async () => {
    const { app } = createTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockResolvedValue([{ id: "cred-1", label: "My GitHub" }]);

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithProvider("github") }),
    });

    expect(response.status).toBe(201);

    expect(mockWriteWorkspaceFiles).toHaveBeenCalledTimes(1);
    const yamlPayload = mockWriteWorkspaceFiles.mock.calls[0]?.[1];
    expect(typeof yamlPayload).toBe("string");
    expect(yamlPayload).toContain("id: cred-1");
    expect(yamlPayload).toContain("provider: github");
  });
});
