/**
 * Unit tests for setWorkspaceConfigValues mutation.
 */

import { describe, expect, test } from "vitest";
import { createTestConfig } from "./test-fixtures.ts";
import { setWorkspaceConfigValues } from "./workspace-config.ts";

describe("setWorkspaceConfigValues", () => {
  test("sets `value` on each declared key", () => {
    const config = createTestConfig({
      workspace_config: {
        api_key: { description: "API key", value: null },
        region: { description: "Region", value: null },
      },
    });

    const result = setWorkspaceConfigValues(config, { api_key: "secret-1", region: "us-west-2" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.workspace_config?.api_key?.value).toBe("secret-1");
      expect(result.value.workspace_config?.region?.value).toBe("us-west-2");
    }
  });

  test("preserves entry metadata (description, schema)", () => {
    const config = createTestConfig({
      workspace_config: { api_key: { description: "API key", value: null } },
    });

    const result = setWorkspaceConfigValues(config, { api_key: "secret-1" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.workspace_config?.api_key?.description).toBe("API key");
    }
  });

  test("rejects unknown keys with a validation error", () => {
    const config = createTestConfig({
      workspace_config: { api_key: { description: "API key", value: null } },
    });

    const result = setWorkspaceConfigValues(config, { api_key: "secret-1", uninvited: "value" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("validation");
    }
  });

  test("rejects when workspace_config block is absent", () => {
    const config = createTestConfig();
    const result = setWorkspaceConfigValues(config, { api_key: "x" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("validation");
    }
  });

  test("partial submission: only updates submitted keys", () => {
    const config = createTestConfig({
      workspace_config: {
        api_key: { description: "API key", value: "existing-key" },
        region: { description: "Region", value: "existing-region" },
      },
    });

    const result = setWorkspaceConfigValues(config, { region: "new-region" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.workspace_config?.api_key?.value).toBe("existing-key");
      expect(result.value.workspace_config?.region?.value).toBe("new-region");
    }
  });
});
