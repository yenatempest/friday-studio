import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MergedConfig } from "@atlas/config";
import { createKVStorage } from "@atlas/storage";
import { aroundEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "./manager.ts";
import { RegistryStorageAdapter } from "./registry-storage-adapter.ts";
import type { WorkspaceSignalRegistrar } from "./types.ts";

/**
 * Subclass exposing a test seam for the protected `signalRegistrars` field.
 * Lets tests inject a recording fake without invoking the full `initialize()`
 * pipeline (which auto-imports workspaces, registers system workspaces, etc.).
 */
class TestableWorkspaceManager extends WorkspaceManager {
  attachRegistrar(registrar: WorkspaceSignalRegistrar): void {
    this.signalRegistrars = [registrar];
  }
}

type RegistrarCall = { method: "register" | "unregister"; workspaceId: string };

function createRecordingRegistrar(): {
  registrar: WorkspaceSignalRegistrar;
  calls: RegistrarCall[];
} {
  const calls: RegistrarCall[] = [];
  const registrar: WorkspaceSignalRegistrar = {
    registerWorkspace: (workspaceId: string, _path: string, _config: MergedConfig) => {
      calls.push({ method: "register", workspaceId });
    },
    unregisterWorkspace: (workspaceId: string) => {
      calls.push({ method: "unregister", workspaceId });
    },
  };
  return { registrar, calls };
}

const setupRequiredYaml = `
version: "1.0"
workspace:
  name: setup-required-ws
workspace_config:
  email_recipient:
    description: Where to send alerts
`;

const filledYaml = `
version: "1.0"
workspace:
  name: filled-ws
workspace_config:
  email_recipient:
    description: Where to send alerts
    value: alice@example.com
`;

describe("WorkspaceManager setup gate — registerWithRegistrars", () => {
  let tempDir: string;
  let manager: TestableWorkspaceManager;
  let calls: RegistrarCall[];

  aroundEach(async (run) => {
    tempDir = await mkdtemp(join(tmpdir(), "atlas-setup-gate-"));
    const kv = await createKVStorage({ type: "memory" });
    const registry = new RegistryStorageAdapter(kv);
    await registry.initialize();
    manager = new TestableWorkspaceManager(registry);
    const recording = createRecordingRegistrar();
    calls = recording.calls;
    manager.attachRegistrar(recording.registrar);
    await run();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("does not call signal registrar when workspace requires setup", async () => {
    await writeFile(join(tempDir, "workspace.yml"), setupRequiredYaml);

    const { workspace, created } = await manager.registerWorkspace(tempDir);

    expect(created).toBe(true);
    expect(workspace.name).toBe("setup-required-ws");
    expect(calls.filter((c) => c.method === "register")).toHaveLength(0);
  });

  it("calls signal registrar when workspace_config values are filled", async () => {
    await writeFile(join(tempDir, "workspace.yml"), filledYaml);

    const { workspace, created } = await manager.registerWorkspace(tempDir);

    expect(created).toBe(true);
    expect(workspace.name).toBe("filled-ws");
    expect(calls.filter((c) => c.method === "register")).toHaveLength(1);
    expect(calls[0]?.workspaceId).toBe(workspace.id);
  });

  it("re-registers signals after Setup Completion fills missing value", async () => {
    const yamlPath = join(tempDir, "workspace.yml");
    await writeFile(yamlPath, setupRequiredYaml);
    const { workspace } = await manager.registerWorkspace(tempDir);

    expect(calls.filter((c) => c.method === "register")).toHaveLength(0);

    // Simulate Setup Completion: rewrite YAML with the value filled in,
    // then trigger the same code path that the file watcher uses.
    await writeFile(yamlPath, filledYaml);
    await manager.handleWorkspaceConfigChange(workspace, yamlPath);

    expect(calls.filter((c) => c.method === "register")).toHaveLength(1);
    expect(calls.find((c) => c.method === "register")?.workspaceId).toBe(workspace.id);
  });
});
