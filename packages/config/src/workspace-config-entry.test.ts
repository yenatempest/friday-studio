import { describe, expect, it } from "vitest";
import { WorkspaceConfigEntrySchema, WorkspaceConfigSchema } from "./workspace.ts";

const minimalWorkspace = {
  version: "1.0" as const,
  workspace: { name: "test", description: "test workspace" },
};

describe("WorkspaceConfigEntrySchema", () => {
  it("parses an empty entry", () => {
    expect(WorkspaceConfigEntrySchema.parse({})).toEqual({});
  });

  it("parses an entry with only description", () => {
    const entry = WorkspaceConfigEntrySchema.parse({ description: "Email recipient" });
    expect(entry.description).toBe("Email recipient");
  });

  it.each([
    ["empty string", ""],
    ["zero", 0],
    ["false", false],
    ["null", null],
  ])("parses an entry with value: %s", (_label, value) => {
    const entry = WorkspaceConfigEntrySchema.parse({ value });
    expect(entry.value).toBe(value);
  });

  it("parses an entry with schema { type: string, format: email }", () => {
    const entry = WorkspaceConfigEntrySchema.parse({
      schema: { type: "string", format: "email" },
    });
    expect(entry.schema?.type).toBe("string");
  });

  it("parses an entry with both schema and value", () => {
    const entry = WorkspaceConfigEntrySchema.parse({
      description: "Email recipient",
      schema: { type: "string" },
      value: "alice@example.com",
    });
    expect(entry.description).toBe("Email recipient");
    expect(entry.schema?.type).toBe("string");
    expect(entry.value).toBe("alice@example.com");
  });

  it("rejects unknown subfields", () => {
    expect(() =>
      WorkspaceConfigEntrySchema.parse({ description: "x", unknown_field: "nope" }),
    ).toThrow();
  });
});

describe("WorkspaceConfigSchema workspace_config block", () => {
  it("parses an empty workspace_config record", () => {
    const config = WorkspaceConfigSchema.parse({
      ...minimalWorkspace,
      workspace_config: {},
    });
    expect(config.workspace_config).toEqual({});
  });

  it("parses workspace_config entries with mixed fill states", () => {
    const config = WorkspaceConfigSchema.parse({
      ...minimalWorkspace,
      workspace_config: {
        unfilled: { description: "no value yet" },
        empty_string: { value: "" },
        zero: { value: 0 },
        falsy: { value: false },
        nulled: { value: null },
        filled: {
          description: "Email recipient",
          schema: { type: "string", format: "email" },
          value: "alice@example.com",
        },
      },
    });
    expect(config.workspace_config?.unfilled?.value).toBeUndefined();
    expect(config.workspace_config?.empty_string?.value).toBe("");
    expect(config.workspace_config?.zero?.value).toBe(0);
    expect(config.workspace_config?.falsy?.value).toBe(false);
    expect(config.workspace_config?.nulled?.value).toBeNull();
    expect(config.workspace_config?.filled?.value).toBe("alice@example.com");
  });

  it("rejects unknown subfields inside an entry", () => {
    expect(() =>
      WorkspaceConfigSchema.parse({
        ...minimalWorkspace,
        workspace_config: {
          email: { description: "x", typo_field: "bad" },
        },
      }),
    ).toThrow();
  });

  it("treats workspace_config as optional", () => {
    const config = WorkspaceConfigSchema.parse(minimalWorkspace);
    expect(config.workspace_config).toBeUndefined();
  });
});
