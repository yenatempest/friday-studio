import { WorkspaceConfigSchema } from "@atlas/config";
import { describe, expect, it } from "vitest";
import { resolveWorkspaceSetupRequirements } from "../setup-requirements.ts";

const baseConfig = {
  version: "1.0",
  workspace: { name: "test-workspace" },
} as const;

function parse(input: Record<string, unknown>) {
  return WorkspaceConfigSchema.parse({ ...baseConfig, ...input });
}

describe("resolveWorkspaceSetupRequirements", () => {
  describe("when no Config Requirements exist", () => {
    it("returns requires_setup: false with no setup_requirements when workspace_config is absent", () => {
      const config = parse({});
      const status = resolveWorkspaceSetupRequirements(config);
      expect(status).toEqual({ requires_setup: false });
      expect(status.setup_requirements).toBeUndefined();
    });

    it("returns requires_setup: false when workspace_config is empty", () => {
      const config = parse({ workspace_config: {} });
      const status = resolveWorkspaceSetupRequirements(config);
      expect(status).toEqual({ requires_setup: false });
    });

    it("returns requires_setup: false when every entry has a filled value", () => {
      const config = parse({
        workspace_config: {
          email: { value: "user@example.com" },
          count: { value: 3 },
        },
      });
      expect(resolveWorkspaceSetupRequirements(config)).toEqual({ requires_setup: false });
    });
  });

  describe("unfilled values produce a Config Requirement", () => {
    it("treats an entry with no value field as unfilled", () => {
      const config = parse({
        workspace_config: { email: { description: "Recipient address" } },
      });
      const status = resolveWorkspaceSetupRequirements(config);
      expect(status.requires_setup).toBe(true);
      expect(status.setup_requirements?.configKeys).toEqual([
        { key: "email", description: "Recipient address" },
      ]);
    });

    it("treats value: null as unfilled", () => {
      const config = parse({
        workspace_config: { email: { value: null } },
      });
      const status = resolveWorkspaceSetupRequirements(config);
      expect(status.requires_setup).toBe(true);
      expect(status.setup_requirements?.configKeys).toEqual([{ key: "email" }]);
    });
  });

  describe("falsy literals count as filled", () => {
    it.each([
      ["empty string", ""],
      ["zero", 0],
      ["false", false],
      ["empty array", [] as unknown[]],
      ["empty object", {} as Record<string, unknown>],
    ])("treats value: %s as filled", (_label, value) => {
      const config = parse({
        workspace_config: { key_under_test: { value } },
      });
      expect(resolveWorkspaceSetupRequirements(config)).toEqual({ requires_setup: false });
    });
  });

  describe("mixed filled and unfilled entries", () => {
    it("only emits requirements for unfilled entries and preserves declaration order", () => {
      const config = parse({
        workspace_config: {
          alpha: { value: "filled" },
          bravo: { description: "second slot" },
          charlie: { value: 0 },
          delta: { value: null, description: "fourth slot" },
          echo: { value: false },
        },
      });
      const status = resolveWorkspaceSetupRequirements(config);
      expect(status.requires_setup).toBe(true);
      expect(status.setup_requirements?.configKeys).toEqual([
        { key: "bravo", description: "second slot" },
        { key: "delta", description: "fourth slot" },
      ]);
    });
  });

  describe("description handling", () => {
    it("omits description when the entry has none", () => {
      const config = parse({
        workspace_config: { bare: { value: null } },
      });
      const requirement = resolveWorkspaceSetupRequirements(config).setup_requirements
        ?.configKeys?.[0];
      expect(requirement).toEqual({ key: "bare" });
      expect(requirement && "description" in requirement).toBe(false);
    });
  });
});
