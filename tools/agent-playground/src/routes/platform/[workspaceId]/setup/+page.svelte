<!--
  Workspace setup page — fills in declared `workspace_config` values.

  Two modes share one form:
  - Setup (`requires_setup === true`): renders the unfilled keys from the
    daemon's `setup_requirements.configKeys`. Submit label "Finish setup".
  - Edit (`requires_setup === false`): renders every declared
    `workspace_config[*]` entry, prefilled from each entry's existing
    `value`. Submit label "Save changes". The setup page doubles as the
    editor (design § 8); there is no separate edit UI.

  Both modes POST to `/:workspaceId/setup` with the same payload shape and
  navigate to `/platform/{workspaceId}` on success.

  Config Requirements only — Credential Requirements come in task #18.

  @component
-->

<script lang="ts">
  import { Button } from "@atlas/ui";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { getDaemonClient } from "$lib/daemon-client";
  import { workspaceQueries } from "$lib/queries";
  import { z } from "zod";

  const client = getDaemonClient();
  const queryClient = useQueryClient();

  const workspaceId = $derived(page.params.workspaceId ?? null);
  const configQuery = createQuery(() => workspaceQueries.config(workspaceId));

  /**
   * Edit-mode derivation: parse the `workspace_config` block from the
   * config response so we can list every declared key and seed inputs
   * from each entry's existing `value`. Hono RPC types this as a broad
   * union; runtime parsing keeps us honest about what's actually there.
   */
  const WorkspaceConfigEntrySchema = z
    .object({
      description: z.string().optional(),
      value: z.unknown().optional(),
    })
    .passthrough();
  const ConfigBlockSchema = z
    .object({
      workspace_config: z.record(z.string(), WorkspaceConfigEntrySchema).optional(),
    })
    .passthrough();

  /** Coerce a stored YAML value to a single-line string for the text input. */
  function coerceToInputValue(v: unknown): string {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return JSON.stringify(v);
  }

  const requiresSetup = $derived(configQuery.data?.requires_setup === true);

  /**
   * Entries to render. Initial setup mode pulls from the daemon's
   * `setup_requirements.configKeys` (unfilled keys only). Edit mode pulls
   * every declared key from `workspace_config`, in YAML order.
   */
  const configKeys = $derived.by((): { key: string; description?: string }[] => {
    const data = configQuery.data;
    if (!data) return [];
    if (requiresSetup) {
      if (!("setup_requirements" in data)) return [];
      const reqs = data.setup_requirements;
      if (!reqs || !("configKeys" in reqs) || !Array.isArray(reqs.configKeys)) return [];
      return reqs.configKeys;
    }
    const parsed = ConfigBlockSchema.safeParse(data.config);
    if (!parsed.success) return [];
    const block = parsed.data.workspace_config ?? {};
    return Object.entries(block).map(([key, entry]) => ({ key, description: entry.description }));
  });

  /** Existing values keyed by config key — only populated in edit mode. */
  const initialValues = $derived.by((): Record<string, string> => {
    if (requiresSetup) return {};
    const parsed = ConfigBlockSchema.safeParse(configQuery.data?.config);
    if (!parsed.success) return {};
    const block = parsed.data.workspace_config ?? {};
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(block)) out[key] = coerceToInputValue(entry.value);
    return out;
  });

  let values = $state<Record<string, string>>({});

  // Seed inputs for any newly-seen key. Setup mode seeds empty strings;
  // edit mode seeds from each entry's existing `value`. Preserves any
  // user input already typed for previously-seen keys.
  $effect(() => {
    for (const entry of configKeys) {
      if (!(entry.key in values)) values[entry.key] = initialValues[entry.key] ?? "";
    }
  });

  const allFilled = $derived(
    configKeys.length > 0 && configKeys.every((entry) => values[entry.key]?.trim().length > 0),
  );

  let submitting = $state(false);
  let errorMessage = $state<string | null>(null);

  /**
   * Setup endpoint error shape: `{ success: false, error, message?, missingKeys? }`.
   * `safeParse` so a malformed payload renders a generic message rather than crashing.
   */
  const SetupErrorSchema = z.object({
    error: z.string(),
    message: z.string().optional(),
    missingKeys: z.array(z.string()).optional(),
  });

  async function formatSetupError(res: Response): Promise<string> {
    const raw = await res.text();
    try {
      const parsed: unknown = JSON.parse(raw);
      const result = SetupErrorSchema.safeParse(parsed);
      if (result.success) {
        const { message, missingKeys } = result.data;
        if (missingKeys && missingKeys.length > 0) {
          return `Missing values: ${missingKeys.join(", ")}`;
        }
        return message ?? result.data.error;
      }
    } catch {
      // Non-JSON body — fall through.
    }
    return raw || `Request failed (${res.status})`;
  }

  async function submit() {
    if (!workspaceId || !allFilled || submitting) return;
    submitting = true;
    errorMessage = null;

    try {
      const res = await client.workspace[":workspaceId"].setup.$post({
        param: { workspaceId },
        json: { workspaceConfigValues: values },
      });

      if (!res.ok) {
        errorMessage = await formatSetupError(res);
        return;
      }

      await queryClient.invalidateQueries({ queryKey: workspaceQueries.all() });
      await goto(`/platform/${workspaceId}`);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : "Failed to save setup";
    } finally {
      submitting = false;
    }
  }
</script>

<div class="setup-page">
  {#if !workspaceId}
    <p class="state-msg">No workspace selected.</p>
  {:else if configQuery.isLoading}
    <p class="state-msg">Loading workspace…</p>
  {:else if configQuery.isError}
    <p class="state-msg">Failed to load workspace: {configQuery.error?.message}</p>
  {:else if configKeys.length === 0}
    <div class="complete">
      <h1>Nothing to configure</h1>
      <p>This workspace has no declared <code>workspace_config</code> keys.</p>
      <Button variant="primary" href="/platform/{workspaceId}">Open workspace</Button>
    </div>
  {:else}
    <header class="header">
      <h1>{requiresSetup ? "Finish workspace setup" : "Workspace configuration"}</h1>
      <p class="subtitle">
        {requiresSetup
          ? "Fill in the values below to start using this workspace."
          : "Update declared workspace values. Saving rewrites workspace.yml."}
      </p>
    </header>

    <form
      class="form"
      onsubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {#each configKeys as entry (entry.key)}
        <label class="field">
          <span class="field-label">{entry.key}</span>
          {#if entry.description}
            <span class="field-description">{entry.description}</span>
          {/if}
          <input
            type="text"
            class="field-input"
            bind:value={values[entry.key]}
            disabled={submitting}
            autocomplete="off"
          />
        </label>
      {/each}

      {#if errorMessage}
        <p class="error">{errorMessage}</p>
      {/if}

      <div class="actions">
        <Button type="submit" variant="primary" disabled={!allFilled || submitting}>
          {submitting ? "Saving…" : requiresSetup ? "Finish setup" : "Save changes"}
        </Button>
      </div>
    </form>
  {/if}
</div>

<style>
  .setup-page {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    margin-inline: auto;
    max-inline-size: 560px;
    padding: var(--size-10) var(--size-6);
    width: 100%;
  }

  .state-msg {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-3);
    text-align: center;
  }

  .header {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .header h1 {
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-7);
    line-height: var(--font-lineheight-1);
    margin: 0;
  }

  .subtitle {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-3);
    margin: 0;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: var(--size-5);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
  }

  .field-label {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
  }

  .field-description {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
  }

  .field-input {
    background-color: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-size: var(--font-size-3);
    padding: var(--size-2) var(--size-3);
    transition: border-color 150ms ease;

    &:focus {
      border-color: var(--color-text);
      outline: none;
    }

    &:disabled {
      opacity: 0.6;
    }
  }

  .error {
    background-color: color-mix(in srgb, var(--color-error), transparent 90%);
    border-radius: var(--radius-2);
    color: var(--color-error);
    font-size: var(--font-size-2);
    margin: 0;
    padding: var(--size-2) var(--size-3);
    white-space: pre-wrap;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }

  .complete {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding-block: var(--size-10);
    text-align: center;
  }

  .complete h1 {
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-7);
    margin: 0;
  }

  .complete p {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-3);
    margin: 0;
  }

  .complete p code {
    background-color: var(--color-surface-1);
    border-radius: var(--radius-1);
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    padding: 0 var(--size-1);
  }
</style>
