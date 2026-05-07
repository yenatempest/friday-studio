/**
 * Integration tests for POST /:workspaceId/setup.
 *
 * Tests Setup Completion: writing user-supplied workspace_config values and
 * credential `id` pins into workspace.yml via a single applyMutation invocation,
 * plus per-key JSON-Schema validation against `workspace_config[key].schema`.
 *
 * NOTE: applyMutation strips YAML comments via @std/yaml — see task #26.
 * Tests assert structure preservation only.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceConfig } from "@atlas/config";
import { WorkspaceConfigSchema } from "@atlas/config";
import { createStubPlatformModels } from "@atlas/llm";
import type { WorkspaceManager } from "@atlas/workspace";
import { parse, stringify } from "@std/yaml";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";

type JsonBody = Record<string, unknown>;

function baseConfig(): WorkspaceConfig {
  return {
    version: "1.0",
    workspace: { id: "ws-test-id", name: "Test Workspace" },
    workspace_config: {
      api_key: { description: "API key", value: null },
      region: { description: "Region", value: null },
    },
    signals: {
      hourly: {
        provider: "schedule",
        description: "Hourly tick",
        config: { schedule: "0 * * * *", timezone: "UTC" },
      },
    },
  } as WorkspaceConfig;
}

function configWithEmailSchema(): WorkspaceConfig {
  return WorkspaceConfigSchema.parse({
    version: "1.0",
    workspace: { id: "ws-test-id", name: "Test Workspace" },
    workspace_config: {
      contact: {
        description: "Contact email",
        schema: { type: "string", format: "email" },
        value: null,
      },
      // Sibling key with no schema — accepts any string.
      note: { description: "Free-form note", value: null },
    },
    signals: {
      hourly: {
        provider: "schedule",
        description: "Hourly tick",
        config: { schedule: "0 * * * *", timezone: "UTC" },
      },
    },
  });
}

function configWithGithubLinkRef(env: Record<string, unknown>): WorkspaceConfig {
  // Parse through the schema so defaults (e.g. mcp.client_config) are filled
  // in and the result is a fully-typed WorkspaceConfig — no `as` casts.
  return WorkspaceConfigSchema.parse({
    version: "1.0",
    workspace: { id: "ws-test-id", name: "Test Workspace" },
    workspace_config: {
      api_key: { description: "API key", value: null },
      region: { description: "Region", value: null },
    },
    signals: {
      hourly: {
        provider: "schedule",
        description: "Hourly tick",
        config: { schedule: "0 * * * *", timezone: "UTC" },
      },
    },
    tools: {
      mcp: {
        servers: {
          github: {
            transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
            env,
          },
        },
      },
    },
  });
}

function createFixture(options: {
  workspacePath: string;
  workspace?: { id: string; configPath: string; metadata?: Record<string, unknown> } | null;
  config?: WorkspaceConfig | null;
}) {
  const {
    workspacePath,
    workspace = {
      id: "ws-test-id",
      configPath: join(workspacePath, "workspace.yml"),
      metadata: { requires_setup: true },
    },
    config = baseConfig(),
  } = options;

  const find = vi
    .fn()
    .mockResolvedValue(
      workspace
        ? {
            id: workspace.id,
            name: "Test Workspace",
            path: workspacePath,
            configPath: workspace.configPath,
            status: "inactive" as const,
            createdAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            metadata: workspace.metadata ?? {},
          }
        : null,
    );
  const getWorkspaceConfig = vi
    .fn()
    .mockResolvedValue(config ? { atlas: null, workspace: config } : null);
  const handleWorkspaceConfigChange = vi.fn().mockResolvedValue(undefined);

  const mockWorkspaceManager = {
    find,
    getWorkspaceConfig,
    list: vi.fn().mockResolvedValue([]),
    registerWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    updateWorkspaceStatus: vi.fn().mockResolvedValue(undefined),
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

  return { app, find, getWorkspaceConfig, handleWorkspaceConfigChange };
}

async function mountRoutes(app: Hono<AppVariables>) {
  const { workspacesRoutes } = await import("./index.ts");
  app.route("/", workspacesRoutes);
  return app;
}

describe("POST /:workspaceId/setup", () => {
  let testDir: string;

  beforeEach(async () => {
    vi.resetModules();
    testDir = join(
      tmpdir(),
      `atlas-setup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("returns 404 when workspace not found", async () => {
    const { app } = createFixture({ workspacePath: testDir, workspace: null });
    await mountRoutes(app);

    const response = await app.request("/ws-unknown/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceConfigValues: {} }),
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as JsonBody;
    expect(body).toMatchObject({
      success: false,
      error: "not_found",
      entityType: "workspace",
      entityId: "ws-unknown",
    });
  });

  test("returns 400 with missingKeys when a declared key is unsubmitted and unfilled", async () => {
    await writeFile(join(testDir, "workspace.yml"), stringify(baseConfig()));
    const { app } = createFixture({ workspacePath: testDir });
    await mountRoutes(app);

    const response = await app.request("/ws-test-id/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceConfigValues: { api_key: "k" } }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as JsonBody;
    expect(body).toMatchObject({ success: false, error: "validation", missingKeys: ["region"] });
  });

  test("accepts request when an unsubmitted key already has a non-null value in YAML", async () => {
    const initial = baseConfig();
    if (initial.workspace_config?.region) {
      initial.workspace_config.region.value = "us-east-1";
    }
    await writeFile(join(testDir, "workspace.yml"), stringify(initial));
    const { app } = createFixture({ workspacePath: testDir, config: initial });
    await mountRoutes(app);

    const response = await app.request("/ws-test-id/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceConfigValues: { api_key: "k" } }),
    });

    expect(response.status).toBe(200);
  });

  test("writes workspace_config values into workspace.yml on success", async () => {
    await writeFile(join(testDir, "workspace.yml"), stringify(baseConfig()));
    const { app } = createFixture({ workspacePath: testDir });
    await mountRoutes(app);

    const response = await app.request("/ws-test-id/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceConfigValues: { api_key: "secret-1", region: "us-west-2" } }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as JsonBody;
    expect(body).toEqual({ success: true });

    const written = parse(
      await readFile(join(testDir, "workspace.yml"), "utf-8"),
    ) as WorkspaceConfig;
    expect(written.workspace_config?.api_key?.value).toBe("secret-1");
    expect(written.workspace_config?.region?.value).toBe("us-west-2");
  });

  test("preserves unrelated YAML structure (sibling keys + descriptions)", async () => {
    // applyMutation strips comments via @std/yaml — see task #26
    await writeFile(join(testDir, "workspace.yml"), stringify(baseConfig()));
    const { app } = createFixture({ workspacePath: testDir });
    await mountRoutes(app);

    await app.request("/ws-test-id/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceConfigValues: { api_key: "secret-1", region: "us-west-2" } }),
    });

    const written = parse(
      await readFile(join(testDir, "workspace.yml"), "utf-8"),
    ) as WorkspaceConfig;
    expect(written.version).toBe("1.0");
    expect(written.workspace.name).toBe("Test Workspace");
    expect(written.signals?.hourly?.provider).toBe("schedule");
    expect(written.workspace_config?.api_key?.description).toBe("API key");
    expect(written.workspace_config?.region?.description).toBe("Region");
  });

  test("does not write YAML when mutation fails (unknown key)", async () => {
    const original = stringify(baseConfig());
    await writeFile(join(testDir, "workspace.yml"), original);
    // Mutation rejects unknown keys; surface as validation error from the
    // mutation layer (mapMutationError → 400).
    const { app } = createFixture({ workspacePath: testDir });
    await mountRoutes(app);

    // To exercise the mutation-layer rejection rather than the route-layer
    // missingKeys check, add the unknown key alongside a satisfied required key.
    const response = await app.request("/ws-test-id/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceConfigValues: { api_key: "secret-1", region: "us-west-2", uninvited: "value" },
      }),
    });

    expect(response.status).toBe(400);
    const onDisk = await readFile(join(testDir, "workspace.yml"), "utf-8");
    expect(onDisk).toBe(original);
  });

  test("re-submission overwrites prior values", async () => {
    await writeFile(join(testDir, "workspace.yml"), stringify(baseConfig()));
    const { app } = createFixture({ workspacePath: testDir });
    await mountRoutes(app);

    const r1 = await app.request("/ws-test-id/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceConfigValues: { api_key: "first", region: "us-east-1" } }),
    });
    expect(r1.status).toBe(200);

    const r2 = await app.request("/ws-test-id/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceConfigValues: { api_key: "second", region: "us-west-2" } }),
    });
    expect(r2.status).toBe(200);

    const written = parse(
      await readFile(join(testDir, "workspace.yml"), "utf-8"),
    ) as WorkspaceConfig;
    expect(written.workspace_config?.api_key?.value).toBe("second");
    expect(written.workspace_config?.region?.value).toBe("us-west-2");
  });

  test("writes credential `id` pins alongside config values in a single YAML write", async () => {
    const initial = configWithGithubLinkRef({
      GITHUB_TOKEN: { from: "link", provider: "github", key: "token" },
    });
    await writeFile(join(testDir, "workspace.yml"), stringify(initial));
    const { app } = createFixture({ workspacePath: testDir, config: initial });
    await mountRoutes(app);

    const response = await app.request("/ws-test-id/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceConfigValues: { api_key: "secret-1", region: "us-west-2" },
        credentialChoices: { "mcp:github:GITHUB_TOKEN": "cred_abc123" },
      }),
    });

    expect(response.status).toBe(200);

    const written = parse(
      await readFile(join(testDir, "workspace.yml"), "utf-8"),
    ) as WorkspaceConfig;
    expect(written.workspace_config?.api_key?.value).toBe("secret-1");
    expect(written.workspace_config?.region?.value).toBe("us-west-2");
    const ref = written.tools?.mcp?.servers?.github?.env?.GITHUB_TOKEN;
    expect(ref).toEqual({ from: "link", id: "cred_abc123", provider: "github", key: "token" });
  });

  test("returns 400 without writing when a required credential pin is missing", async () => {
    const initial = configWithGithubLinkRef({
      GITHUB_TOKEN: { from: "link", provider: "github", key: "token" },
    });
    const original = stringify(initial);
    await writeFile(join(testDir, "workspace.yml"), original);
    const { app } = createFixture({ workspacePath: testDir, config: initial });
    await mountRoutes(app);

    const response = await app.request("/ws-test-id/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceConfigValues: { api_key: "k", region: "r" },
        // Note: no credentialChoices for the required github pin.
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as JsonBody;
    expect(body).toMatchObject({
      success: false,
      error: "validation",
      missingCredentialPaths: ["mcp:github:GITHUB_TOKEN"],
    });

    const onDisk = await readFile(join(testDir, "workspace.yml"), "utf-8");
    expect(onDisk).toBe(original);
  });

  test("accepts a credential pin for a ref that already has an `id` (opt-in override)", async () => {
    const initial = configWithGithubLinkRef({
      GITHUB_TOKEN: { from: "link", id: "cred_default", provider: "github", key: "token" },
    });
    await writeFile(join(testDir, "workspace.yml"), stringify(initial));
    const { app } = createFixture({ workspacePath: testDir, config: initial });
    await mountRoutes(app);

    const response = await app.request("/ws-test-id/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceConfigValues: { api_key: "k", region: "r" },
        credentialChoices: { "mcp:github:GITHUB_TOKEN": "cred_override" },
      }),
    });

    expect(response.status).toBe(200);

    const written = parse(
      await readFile(join(testDir, "workspace.yml"), "utf-8"),
    ) as WorkspaceConfig;
    const ref = written.tools?.mcp?.servers?.github?.env?.GITHUB_TOKEN;
    expect(ref).toEqual({ from: "link", id: "cred_override", provider: "github", key: "token" });
  });

  test("calls handleWorkspaceConfigChange after successful write", async () => {
    await writeFile(join(testDir, "workspace.yml"), stringify(baseConfig()));
    const { app, handleWorkspaceConfigChange } = createFixture({ workspacePath: testDir });
    await mountRoutes(app);

    const response = await app.request("/ws-test-id/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceConfigValues: { api_key: "k", region: "r" } }),
    });

    expect(response.status).toBe(200);
    expect(handleWorkspaceConfigChange).toHaveBeenCalledTimes(1);
    expect(handleWorkspaceConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws-test-id", path: testDir }),
      join(testDir, "workspace.yml"),
    );
  });

  test("returns 400 with per-field errors when a value fails its schema (format: email)", async () => {
    const initial = configWithEmailSchema();
    const original = stringify(initial);
    await writeFile(join(testDir, "workspace.yml"), original);
    const { app } = createFixture({ workspacePath: testDir, config: initial });
    await mountRoutes(app);

    const response = await app.request("/ws-test-id/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceConfigValues: { contact: "not-an-email", note: "ok" } }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as JsonBody;
    expect(body).toMatchObject({
      success: false,
      error: "validation",
      message: "workspace_config values failed schema validation",
    });
    expect(body.fieldErrors).toHaveProperty("contact");
    expect(body.fieldErrors).not.toHaveProperty("note");

    // No write happened.
    const onDisk = await readFile(join(testDir, "workspace.yml"), "utf-8");
    expect(onDisk).toBe(original);
  });

  test("accepts a valid email value when schema declares format: email", async () => {
    const initial = configWithEmailSchema();
    await writeFile(join(testDir, "workspace.yml"), stringify(initial));
    const { app } = createFixture({ workspacePath: testDir, config: initial });
    await mountRoutes(app);

    const response = await app.request("/ws-test-id/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceConfigValues: { contact: "alice@example.com", note: "hi" } }),
    });

    expect(response.status).toBe(200);

    const written = parse(
      await readFile(join(testDir, "workspace.yml"), "utf-8"),
    ) as WorkspaceConfig;
    expect(written.workspace_config?.contact?.value).toBe("alice@example.com");
    expect(written.workspace_config?.note?.value).toBe("hi");
  });

  test("entry without `schema` accepts arbitrary strings", async () => {
    // baseConfig() declares api_key + region with no schemas.
    await writeFile(join(testDir, "workspace.yml"), stringify(baseConfig()));
    const { app } = createFixture({ workspacePath: testDir });
    await mountRoutes(app);

    const response = await app.request("/ws-test-id/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceConfigValues: { api_key: "anything-goes-!@#$", region: "us-west-2" },
      }),
    });

    expect(response.status).toBe(200);
    const written = parse(
      await readFile(join(testDir, "workspace.yml"), "utf-8"),
    ) as WorkspaceConfig;
    expect(written.workspace_config?.api_key?.value).toBe("anything-goes-!@#$");
  });
});
