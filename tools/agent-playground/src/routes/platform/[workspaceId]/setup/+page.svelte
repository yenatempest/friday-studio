<!--
  Workspace setup page — fills in declared `workspace_config` values and pins
  per-workspace credential choices for any provider-only link refs that have
  no Link default.

  Two modes share one form:
  - Setup (`requires_setup === true`): renders the unfilled config keys from
    `setup_requirements.configKeys` and one block per
    `setup_requirements.credentials[]` entry. Submit label "Finish setup".
  - Edit (`requires_setup === false`): renders every declared
    `workspace_config[*]` entry, prefilled from each entry's existing
    `value`. Credential blocks only appear when the provider still has no
    default (i.e. the entry is genuinely a Requirement). Submit label
    "Save changes". The setup page doubles as the editor (design § 8); there
    is no separate edit UI.

  Both modes POST to `/:workspaceId/setup` with the same payload shape
  (`workspaceConfigValues` + `credentialChoices`) and navigate to
  `/platform/{workspaceId}` on success.

  @component
-->

<script lang="ts">
  import { Badge, Button, Dialog, DropdownMenu, Icons, toast } from "@atlas/ui";
  import { browser } from "$app/environment";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { getDaemonClient } from "$lib/daemon-client";
  import { useDeleteWorkspace, workspaceQueries } from "$lib/queries";
  import { useCredentialConnect } from "$lib/use-credential-connect.svelte.ts";
  import CredentialSecretForm from "$lib/components/credential-secret-form.svelte";
  import { writable } from "svelte/store";
  import { stringify } from "yaml";
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

  /**
   * Schemas for `setup_requirements.credentials[]`. The Hono RPC response is
   * narrowed by Zod here because `workspace-queries.ts:config()` strips
   * unknown fields by default — see `docs/learnings/2026-05-07-workspace-setup.md`
   * (frontend gotcha: typed client + Zod stripping).
   */
  const CredentialOptionSchema = z.object({
    id: z.string(),
    label: z.string(),
    displayName: z.string().nullable(),
    userIdentifier: z.string().nullable(),
    isDefault: z.boolean(),
  });
  const CredentialRequirementSchema = z.object({
    provider: z.string(),
    label: z.string().optional(),
    options: z.array(CredentialOptionSchema),
  });
  const SetupRequirementsSchema = z
    .object({
      configKeys: z
        .array(
          z.object({
            key: z.string(),
            description: z.string().optional(),
          }),
        )
        .optional(),
      credentials: z.array(CredentialRequirementSchema).optional(),
    })
    .optional();

  type CredentialOption = z.infer<typeof CredentialOptionSchema>;
  type CredentialRequirement = z.infer<typeof CredentialRequirementSchema>;

  /**
   * Subset of Link's `GET /v1/summary?provider=X` credentials list used to
   * render the override picker. Currently-resolved credential metadata is
   * derived client-side: the credential with `isDefault: true` is the one
   * `getDefaultByProvider` hands back to the resolver.
   */
  const CredentialSummarySchema = z.object({
    id: z.string(),
    label: z.string(),
    displayName: z.string().nullable().optional(),
    userIdentifier: z.string().nullable().optional(),
    isDefault: z.boolean(),
  });
  const SummaryResponseSchema = z.object({
    credentials: z.array(CredentialSummarySchema),
  });
  type CredentialSummary = z.infer<typeof CredentialSummarySchema>;

  /**
   * Schema for the parsed config's link refs. Used to walk the YAML and build
   * a `provider → path[]` map so per-provider blocks know which ref paths
   * (`mcp:<serverId>:<envVar>` / `agent:<agentId>:<envVar>`) they bind.
   */
  const LinkRefSchema = z
    .object({
      from: z.literal("link"),
      provider: z.string().optional(),
      id: z.string().optional(),
    })
    .passthrough();
  const ServerEnvSchema = z.record(z.string(), z.unknown());
  const McpServerSchema = z
    .object({ env: ServerEnvSchema.optional() })
    .passthrough();
  const AtlasAgentSchema = z
    .object({ type: z.literal("atlas"), env: ServerEnvSchema.optional() })
    .passthrough();
  const RefWalkSchema = z
    .object({
      tools: z
        .object({
          mcp: z
            .object({
              servers: z.record(z.string(), McpServerSchema).optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough()
        .optional(),
      agents: z.record(z.string(), z.unknown()).optional(),
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
   * Workspace color (shared cache with sidebar). Mirrors the lookup in the
   * overview page so the header dot stays visually consistent across pages.
   */
  const workspacesQuery = createQuery(() => workspaceQueries.list());

  const COLORS: Record<string, string> = {
    yellow: "var(--yellow-2, #facc15)",
    purple: "var(--purple-2, #a78bfa)",
    red: "var(--red-2, #f87171)",
    blue: "var(--blue-2, #60a5fa)",
    green: "var(--green-2, #4ade80)",
    brown: "var(--brown-2, #a3824a)",
  };

  const workspaceColor = $derived.by(() => {
    const ws = (workspacesQuery.data ?? []).find((w) => w.id === workspaceId);
    const color = ws?.metadata?.color;
    return COLORS[color ?? "yellow"] ?? COLORS["yellow"];
  });

  const workspaceName = $derived(
    configQuery.data?.config?.workspace?.name ?? workspaceId ?? "",
  );
  const workspaceDescription = $derived(configQuery.data?.config?.workspace?.description ?? null);

  // ---------------------------------------------------------------------------
  // Header actions — export / download / delete (mirrors overview page)
  // ---------------------------------------------------------------------------

  const deleteMut = useDeleteWorkspace();
  const deleteDialogOpen = writable(false);

  function exportWorkspaceConfig() {
    if (!configQuery.data) return;
    const yamlStr = stringify(configQuery.data.config);
    const blob = new Blob([yamlStr], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "workspace.yml";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function downloadWorkspaceBundle(mode: "definition" | "migration") {
    if (!workspaceId) return;
    const qs = mode === "migration" ? "?mode=migration" : "";
    const url = `/api/daemon/api/workspaces/${workspaceId}/bundle${qs}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const errBody = await res.text();
        toast({ title: `Download failed: ${errBody.slice(0, 200)}`, error: true });
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const nameMatch = /filename="([^"]+)"/.exec(disposition);
      const filename = nameMatch?.[1] ?? `${workspaceId}.zip`;
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(href);
      toast({ title: "Workspace downloaded" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast({ title: `Download failed: ${msg}`, error: true });
    }
  }

  async function confirmDelete() {
    if (!workspaceId || deleteMut.isPending) return;
    try {
      await deleteMut.mutateAsync(workspaceId);
      deleteDialogOpen.set(false);
      toast({ title: `${workspaceName} removed` });
      goto("/platform");
    } catch {
      toast({ title: "Failed to remove workspace", error: true });
    }
  }

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

  /**
   * Credential Requirements parsed off the daemon response. Empty array when
   * the response carries no `credentials` block (config-only setup, or
   * everything resolved to a default).
   */
  const credentialRequirements = $derived.by((): CredentialRequirement[] => {
    const data = configQuery.data;
    if (!data || !("setup_requirements" in data)) return [];
    const parsed = SetupRequirementsSchema.safeParse(data.setup_requirements);
    if (!parsed.success || !parsed.data) return [];
    return parsed.data.credentials ?? [];
  });

  /**
   * `provider → ref paths[]` derived by walking the parsed config for
   * `from: link` env entries. Mirrors `extractCredentials` server-side. Only
   * paths that lack an `id` (i.e. provider-only refs that the setup endpoint
   * will demand a `credentialChoices` entry for) are emitted.
   */
  const pathsByProvider = $derived.by((): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    const parsed = RefWalkSchema.safeParse(configQuery.data?.config);
    if (!parsed.success) return map;

    const push = (provider: string, path: string) => {
      const existing = map.get(provider);
      if (existing) existing.push(path);
      else map.set(provider, [path]);
    };

    const servers = parsed.data.tools?.mcp?.servers ?? {};
    for (const [serverId, server] of Object.entries(servers)) {
      const env = server.env ?? {};
      for (const [envVar, raw] of Object.entries(env)) {
        const ref = LinkRefSchema.safeParse(raw);
        if (!ref.success) continue;
        if (ref.data.id) continue;
        if (!ref.data.provider) continue;
        push(ref.data.provider, `mcp:${serverId}:${envVar}`);
      }
    }

    const agents = parsed.data.agents ?? {};
    for (const [agentId, rawAgent] of Object.entries(agents)) {
      const agent = AtlasAgentSchema.safeParse(rawAgent);
      if (!agent.success) continue;
      const env = agent.data.env ?? {};
      for (const [envVar, raw] of Object.entries(env)) {
        const ref = LinkRefSchema.safeParse(raw);
        if (!ref.success) continue;
        if (ref.data.id) continue;
        if (!ref.data.provider) continue;
        push(ref.data.provider, `agent:${agentId}:${envVar}`);
      }
    }
    return map;
  });

  /** Flat list of every credential ref path that needs a selection. */
  const credentialPaths = $derived.by((): string[] => {
    const out: string[] = [];
    for (const req of credentialRequirements) {
      const paths = pathsByProvider.get(req.provider) ?? [];
      for (const p of paths) out.push(p);
    }
    return out;
  });

  /**
   * Provider-only refs whose default resolves (i.e. NOT in
   * `credentialRequirements`) and so are eligible for opt-in pinning.
   * Functionally equivalent to the server's `overridableRefs` payload but
   * derived client-side from the same parsed config the Requirements blocks
   * already walk — saves the route handler from forwarding a third field.
   */
  const overridableRefs = $derived.by((): { path: string; provider: string }[] => {
    const requiredProviders = new Set(credentialRequirements.map((r) => r.provider));
    const out: { path: string; provider: string }[] = [];
    for (const [provider, paths] of pathsByProvider) {
      if (requiredProviders.has(provider)) continue;
      for (const path of paths) out.push({ path, provider });
    }
    return out;
  });

  const overridableProviders = $derived.by((): string[] => {
    return [...new Set(overridableRefs.map((r) => r.provider))];
  });

  let values = $state<Record<string, string>>({});
  let credentialChoices = $state<Record<string, string>>({});

  /**
   * Per-provider details fetched from Link's `/v1/providers/:id` so the
   * "Connect another account" affordance dispatches to the right flow
   * (oauth popup, app-install popup, or inline API-key form).
   */
  type ProviderType = "oauth" | "apikey" | "app_install";
  type ProviderDetails = {
    id: string;
    type: ProviderType;
    displayName: string;
    secretSchema?: { properties?: Record<string, unknown>; required?: string[] };
  };
  const ProviderResponseSchema = z.object({
    id: z.string(),
    type: z.enum(["oauth", "apikey", "app_install"]),
    displayName: z.string(),
    secretSchema: z
      .object({
        properties: z.record(z.string(), z.unknown()).optional(),
        required: z.array(z.string()).optional(),
      })
      .optional(),
  });
  let providerDetails = $state<Record<string, ProviderDetails | null>>({});
  let apiKeyExpanded = $state<Record<string, boolean>>({});

  /**
   * Override section UI state. `overridesExpanded` collapses the whole
   * section by default. `overrideRefExpanded` tracks per-ref picker
   * expansion (`mcp:slack:SLACK_TOKEN` → showing radios). `apiKeyOverrideExpanded`
   * is the override-section's own apikey form expansion, kept separate from
   * the Requirement block's `apiKeyExpanded` so each can open independently.
   */
  let overridesExpanded = $state(false);
  let overrideRefExpanded = $state<Record<string, boolean>>({});
  let apiKeyOverrideExpanded = $state<Record<string, boolean>>({});
  let overrideCredentials = $state<Record<string, CredentialSummary[] | null>>({});

  // Seed config inputs for any newly-seen key. Setup mode seeds empty strings;
  // edit mode seeds from each entry's existing `value`. Preserves any
  // user input already typed for previously-seen keys.
  $effect(() => {
    for (const entry of configKeys) {
      if (!(entry.key in values)) values[entry.key] = initialValues[entry.key] ?? "";
    }
  });

  // Preselect credential choices: every path bound to a single-option
  // requirement gets that option's id. Any user-made selection wins on
  // subsequent renders (we never overwrite a path that already has a value).
  $effect(() => {
    for (const req of credentialRequirements) {
      const paths = pathsByProvider.get(req.provider) ?? [];
      if (req.options.length === 1) {
        const onlyId = req.options[0].id;
        for (const p of paths) {
          if (!(p in credentialChoices)) credentialChoices[p] = onlyId;
        }
      }
    }
  });

  /**
   * One `useCredentialConnect` instance per provider, kept stable across
   * renders so popup-blocked / submitting state survives. Built lazily as
   * providers appear.
   */
  const connectByProvider = new Map<string, ReturnType<typeof useCredentialConnect>>();
  function getConnect(provider: string) {
    let connect = connectByProvider.get(provider);
    if (!connect) {
      connect = useCredentialConnect(provider);
      connectByProvider.set(provider, connect);
    }
    return connect;
  }

  /**
   * Wire callback listeners for every provider with an active block. On
   * successful connect, invalidate the workspace config query so the option
   * list re-fetches with the freshly-created credential, and pre-select the
   * new id for every path bound to that provider so the user can submit
   * without an extra click.
   */
  $effect(() => {
    if (!browser) return;
    const cleanups: Array<() => void> = [];
    for (const req of credentialRequirements) {
      const connect = getConnect(req.provider);
      const cleanup = connect.listenForCallback((message) => {
        const paths = pathsByProvider.get(req.provider) ?? [];
        for (const p of paths) credentialChoices[p] = message.credentialId;
        if (workspaceId) {
          void queryClient.invalidateQueries({
            queryKey: workspaceQueries.config(workspaceId).queryKey,
          });
        }
      });
      cleanups.push(cleanup);
    }
    return () => {
      for (const c of cleanups) c();
    };
  });

  /**
   * Override-section callback wiring. Mirrors the Requirements wiring but
   * binds the new credential id only to the single override ref the user
   * was working on (tracked via the most-recently-expanded picker), not to
   * every ref of that provider — overriding is per-ref by design.
   */
  let lastOverridePathByProvider = $state<Record<string, string>>({});
  $effect(() => {
    if (!browser) return;
    const cleanups: Array<() => void> = [];
    for (const provider of overridableProviders) {
      const connect = getConnect(provider);
      const cleanup = connect.listenForCallback((message) => {
        const path = lastOverridePathByProvider[provider];
        if (path) credentialChoices[path] = message.credentialId;
        if (workspaceId) {
          void queryClient.invalidateQueries({
            queryKey: workspaceQueries.config(workspaceId).queryKey,
          });
        }
      });
      cleanups.push(cleanup);
    }
    return () => {
      for (const c of cleanups) c();
    };
  });

  // Fetch provider details on demand (one call per provider). Triggers when a
  // new credential block appears. Failures collapse to `null` so the block
  // falls back to the OAuth flow — better than blocking the page on a fetch.
  $effect(() => {
    if (!browser) return;
    const seen = new Set<string>();
    for (const req of credentialRequirements) seen.add(req.provider);
    for (const provider of overridableProviders) seen.add(provider);
    for (const provider of seen) {
      if (provider in providerDetails) continue;
      providerDetails[provider] = null;
      void fetch(`/api/daemon/api/link/v1/providers/${encodeURIComponent(provider)}`)
        .then(async (res) => {
          if (!res.ok) return;
          const parsed = ProviderResponseSchema.safeParse(await res.json());
          if (!parsed.success) return;
          providerDetails[provider] = parsed.data;
        })
        .catch(() => {
          // Swallow — block falls back to OAuth.
        });
    }
  });

  /**
   * Fetch credential summaries for every overridable provider so the picker
   * can show options and the section header can show currently-resolved
   * metadata (`displayName` / `userIdentifier` of the `isDefault` cred).
   * Mirrors `linkProviderQueries.credentialsByProvider` but inlined to keep
   * the fetch lifecycle attached to this page's reactivity.
   */
  $effect(() => {
    if (!browser) return;
    for (const provider of overridableProviders) {
      if (provider in overrideCredentials) continue;
      overrideCredentials[provider] = null;
      const url = new URL("/api/daemon/api/link/v1/summary", globalThis.location.origin);
      url.searchParams.set("provider", provider);
      void fetch(url.href)
        .then(async (res) => {
          if (!res.ok) return;
          const parsed = SummaryResponseSchema.safeParse(await res.json());
          if (!parsed.success) return;
          overrideCredentials[provider] = parsed.data.credentials;
        })
        .catch(() => {
          // Swallow — section degrades gracefully (no metadata, no options).
        });
    }
  });

  async function handleApiKeySubmit(
    provider: string,
    label: string,
    secret: Record<string, string>,
  ) {
    const connect = getConnect(provider);
    const newId = await connect.submitApiKey(label, secret);
    if (!newId) return;
    const paths = pathsByProvider.get(provider) ?? [];
    for (const p of paths) credentialChoices[p] = newId;
    apiKeyExpanded[provider] = false;
    if (workspaceId) {
      await queryClient.invalidateQueries({
        queryKey: workspaceQueries.config(workspaceId).queryKey,
      });
    }
  }

  async function handleOverrideApiKeySubmit(
    path: string,
    provider: string,
    label: string,
    secret: Record<string, string>,
  ) {
    const connect = getConnect(provider);
    const newId = await connect.submitApiKey(label, secret);
    if (!newId) return;
    credentialChoices[path] = newId;
    apiKeyOverrideExpanded[path] = false;
    if (workspaceId) {
      await queryClient.invalidateQueries({
        queryKey: workspaceQueries.config(workspaceId).queryKey,
      });
    }
  }

  /**
   * Resolve the credential summary the workspace currently uses for an
   * override ref. If the user has pinned via this session, prefer that;
   * otherwise fall back to the provider's default (`isDefault: true`),
   * which is what the server-side resolver picked.
   */
  function resolvedFor(
    path: string,
    provider: string,
  ): CredentialSummary | undefined {
    const list = overrideCredentials[provider];
    if (!list) return undefined;
    const pinnedId = credentialChoices[path];
    if (pinnedId) return list.find((c) => c.id === pinnedId);
    return list.find((c) => c.isDefault);
  }

  function summaryLabel(c: CredentialSummary): string {
    return c.displayName ?? c.userIdentifier ?? c.label;
  }

  const allConfigFilled = $derived(
    configKeys.every((entry) => values[entry.key]?.trim().length > 0),
  );
  const allCredentialsChosen = $derived(
    credentialPaths.every((path) => (credentialChoices[path] ?? "").length > 0),
  );
  const formReady = $derived(
    (configKeys.length > 0 || credentialPaths.length > 0) &&
      allConfigFilled &&
      allCredentialsChosen,
  );

  let submitting = $state(false);
  let errorMessage = $state<string | null>(null);

  /**
   * Setup endpoint error shape: `{ success: false, error, message?, missingKeys?,
   * missingCredentialPaths? }`. `safeParse` so a malformed payload renders a
   * generic message rather than crashing.
   */
  const SetupErrorSchema = z.object({
    error: z.string(),
    message: z.string().optional(),
    missingKeys: z.array(z.string()).optional(),
    missingCredentialPaths: z.array(z.string()).optional(),
  });

  async function formatSetupError(res: Response): Promise<string> {
    const raw = await res.text();
    try {
      const parsed: unknown = JSON.parse(raw);
      const result = SetupErrorSchema.safeParse(parsed);
      if (result.success) {
        const { message, missingKeys, missingCredentialPaths } = result.data;
        if (missingKeys && missingKeys.length > 0) {
          return `Missing values: ${missingKeys.join(", ")}`;
        }
        if (missingCredentialPaths && missingCredentialPaths.length > 0) {
          return `Missing credential pins: ${missingCredentialPaths.join(", ")}`;
        }
        return message ?? result.data.error;
      }
    } catch {
      // Non-JSON body — fall through.
    }
    return raw || `Request failed (${res.status})`;
  }

  async function submit() {
    if (!workspaceId || !formReady || submitting) return;
    submitting = true;
    errorMessage = null;

    try {
      const res = await client.workspace[":workspaceId"].setup.$post({
        param: { workspaceId },
        json: {
          workspaceConfigValues: values,
          credentialChoices,
        },
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

  function optionLabel(option: CredentialOption): string {
    return option.displayName ?? option.userIdentifier ?? option.label;
  }
</script>

<div class="setup-page">
  {#if !workspaceId}
    <p class="state-msg">No workspace selected.</p>
  {:else if configQuery.isLoading}
    <p class="state-msg">Loading workspace…</p>
  {:else if configQuery.isError}
    <p class="state-msg">Failed to load workspace: {configQuery.error?.message}</p>
  {:else if configKeys.length === 0 && credentialRequirements.length === 0}
    <div class="complete">
      <h1>Nothing to configure</h1>
      <p>This workspace has no declared <code>workspace_config</code> keys or unresolved credentials.</p>
      <Button variant="primary" href="/platform/{workspaceId}">Open workspace</Button>
    </div>
  {:else}
    <header class="workspace-header">
      <div class="header-info">
        <h1 class="workspace-name">
          <span class="workspace-dot" style:color={workspaceColor}><span></span></span>
          {workspaceName}
          {#if requiresSetup}
            <Badge variant="warning">Setup</Badge>
          {/if}
        </h1>
        {#if workspaceDescription}
          <p class="workspace-description">{workspaceDescription}</p>
        {/if}
      </div>
      <div class="actions">
        <DropdownMenu.Root positioning={{ placement: "bottom-end" }}>
          {#snippet children()}
            <DropdownMenu.Trigger class="more-trigger" aria-label="More options">
              <Icons.TripleDots />
            </DropdownMenu.Trigger>

            <DropdownMenu.Content>
              <DropdownMenu.Item onclick={exportWorkspaceConfig}>
                Export configuration
              </DropdownMenu.Item>
              <DropdownMenu.Item onclick={() => downloadWorkspaceBundle("definition")}>
                Download workspace
              </DropdownMenu.Item>
              <DropdownMenu.Item onclick={() => downloadWorkspaceBundle("migration")}>
                Download workspace with notes &amp; memory
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onclick={() => deleteDialogOpen.set(true)}>
                Remove workspace
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          {/snippet}
        </DropdownMenu.Root>
      </div>
    </header>

    <p class="subtitle">
      {requiresSetup
        ? "Fill in the values below to start using this workspace."
        : "Update declared workspace values. Saving rewrites workspace.yml."}
    </p>

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

      {#each credentialRequirements as req (req.provider)}
        {@const connect = getConnect(req.provider)}
        {@const paths = pathsByProvider.get(req.provider) ?? []}
        {@const groupName = `cred-${req.provider}`}
        {@const details = providerDetails[req.provider] ?? null}
        <fieldset class="cred-block">
          <legend class="cred-legend">{req.label ?? req.provider}</legend>
          <p class="cred-helper">
            Connecting persists immediately even if you don't finish setup.
          </p>
          {#if req.options.length > 0}
            <div class="cred-options" role="radiogroup">
              {#each req.options as option (option.id)}
                <label class="cred-option" class:selected={paths[0] && credentialChoices[paths[0]] === option.id}>
                  <input
                    type="radio"
                    name={groupName}
                    value={option.id}
                    checked={paths[0] ? credentialChoices[paths[0]] === option.id : false}
                    onchange={() => {
                      for (const p of paths) credentialChoices[p] = option.id;
                    }}
                    disabled={submitting}
                  />
                  <span class="cred-option-text">
                    <span class="cred-option-name">{optionLabel(option)}</span>
                    {#if option.userIdentifier && option.userIdentifier !== optionLabel(option)}
                      <span class="cred-option-meta">{option.userIdentifier}</span>
                    {/if}
                    {#if option.isDefault}
                      <span class="cred-option-default">default</span>
                    {/if}
                  </span>
                </label>
              {/each}
            </div>
          {:else}
            <p class="cred-empty">No connected accounts for this provider yet.</p>
          {/if}

          {#if details?.type === "apikey"}
            {#if apiKeyExpanded[req.provider]}
              <CredentialSecretForm
                secretSchema={details.secretSchema ?? {}}
                submitting={connect.submitting}
                error={connect.error}
                onSubmit={(label, secret) => handleApiKeySubmit(req.provider, label, secret)}
                onCancel={() => (apiKeyExpanded[req.provider] = false)}
              />
            {:else}
              <div class="cred-actions">
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  onclick={() => (apiKeyExpanded[req.provider] = true)}
                  disabled={submitting}
                >
                  Connect another account
                </Button>
              </div>
            {/if}
          {:else}
            <div class="cred-actions">
              <Button
                type="button"
                variant="secondary"
                size="small"
                onclick={details?.type === "app_install" ? connect.startAppInstall : connect.startOAuth}
                disabled={submitting}
              >
                Connect another account
              </Button>
              {#if connect.popupBlocked && connect.blockedUrl}
                <a class="cred-fallback" href={connect.blockedUrl} target="_blank" rel="noreferrer">
                  Continue in this tab
                </a>
              {/if}
            </div>
          {/if}
          {#if connect.error}
            <p class="cred-error">{connect.error}</p>
          {/if}
        </fieldset>
      {/each}

      {#if overridableRefs.length > 0}
        <section class="override-section">
          <button
            type="button"
            class="override-toggle"
            aria-expanded={overridesExpanded}
            onclick={() => (overridesExpanded = !overridesExpanded)}
          >
            <span class="override-chevron" class:open={overridesExpanded} aria-hidden="true">›</span>
            <span class="override-toggle-text">
              <span class="override-title">Pin credentials per-workspace</span>
              <span class="override-hint">
                Optional. Use a specific account for this workspace instead of your default.
              </span>
            </span>
          </button>

          {#if overridesExpanded}
            <ul class="override-list">
              {#each overridableRefs as ref (ref.path)}
                {@const connect = getConnect(ref.provider)}
                {@const details = providerDetails[ref.provider] ?? null}
                {@const list = overrideCredentials[ref.provider] ?? []}
                {@const resolved = resolvedFor(ref.path, ref.provider)}
                {@const groupName = `override-${ref.path}`}
                <li class="override-item">
                  <div class="override-item-head">
                    <div class="override-item-meta">
                      <span class="override-item-path">{ref.path}</span>
                      {#if resolved}
                        <span class="override-item-using">
                          using <strong>{summaryLabel(resolved)}</strong>
                          {#if resolved.isDefault && credentialChoices[ref.path] === undefined}
                            <span class="override-item-default-tag">default</span>
                          {/if}
                        </span>
                      {:else if list.length === 0 && ref.provider in overrideCredentials}
                        <span class="override-item-using muted">No connected account</span>
                      {/if}
                    </div>
                    {#if !overrideRefExpanded[ref.path]}
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        onclick={() => (overrideRefExpanded[ref.path] = true)}
                        disabled={submitting}
                      >
                        Pin a different account
                      </Button>
                    {/if}
                  </div>

                  {#if overrideRefExpanded[ref.path]}
                    <div class="override-picker">
                      {#if list.length > 0}
                        <div class="cred-options" role="radiogroup">
                          {#each list as option (option.id)}
                            <label class="cred-option" class:selected={credentialChoices[ref.path] === option.id}>
                              <input
                                type="radio"
                                name={groupName}
                                value={option.id}
                                checked={credentialChoices[ref.path] === option.id}
                                onchange={() => {
                                  credentialChoices[ref.path] = option.id;
                                }}
                                disabled={submitting}
                              />
                              <span class="cred-option-text">
                                <span class="cred-option-name">{summaryLabel(option)}</span>
                                {#if option.userIdentifier && option.userIdentifier !== summaryLabel(option)}
                                  <span class="cred-option-meta">{option.userIdentifier}</span>
                                {/if}
                                {#if option.isDefault}
                                  <span class="cred-option-default">default</span>
                                {/if}
                              </span>
                            </label>
                          {/each}
                        </div>
                      {/if}

                      {#if details?.type === "apikey"}
                        {#if apiKeyOverrideExpanded[ref.path]}
                          <CredentialSecretForm
                            secretSchema={details.secretSchema ?? {}}
                            submitting={connect.submitting}
                            error={connect.error}
                            onSubmit={(label, secret) =>
                              handleOverrideApiKeySubmit(ref.path, ref.provider, label, secret)}
                            onCancel={() => (apiKeyOverrideExpanded[ref.path] = false)}
                          />
                        {:else}
                          <div class="cred-actions">
                            <Button
                              type="button"
                              variant="secondary"
                              size="small"
                              onclick={() => (apiKeyOverrideExpanded[ref.path] = true)}
                              disabled={submitting}
                            >
                              Connect another account
                            </Button>
                          </div>
                        {/if}
                      {:else}
                        <div class="cred-actions">
                          <Button
                            type="button"
                            variant="secondary"
                            size="small"
                            onclick={() => {
                              lastOverridePathByProvider[ref.provider] = ref.path;
                              if (details?.type === "app_install") connect.startAppInstall();
                              else connect.startOAuth();
                            }}
                            disabled={submitting}
                          >
                            Connect another account
                          </Button>
                          {#if connect.popupBlocked && connect.blockedUrl}
                            <a class="cred-fallback" href={connect.blockedUrl} target="_blank" rel="noreferrer">
                              Continue in this tab
                            </a>
                          {/if}
                        </div>
                      {/if}
                      {#if connect.error}
                        <p class="cred-error">{connect.error}</p>
                      {/if}

                      <div class="override-picker-actions">
                        <button
                          type="button"
                          class="override-collapse"
                          onclick={() => (overrideRefExpanded[ref.path] = false)}
                          disabled={submitting}
                        >
                          Done
                        </button>
                      </div>
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}

      {#if errorMessage}
        <p class="error">{errorMessage}</p>
      {/if}

      <div class="actions">
        <Button type="submit" variant="primary" disabled={!formReady || submitting}>
          {submitting ? "Saving…" : requiresSetup ? "Finish setup" : "Save changes"}
        </Button>
      </div>
    </form>
  {/if}
</div>

<Dialog.Root open={deleteDialogOpen}>
  {#snippet children()}
    <Dialog.Content>
      <Dialog.Close />

      {#snippet header()}
        <Dialog.Title>Remove workspace</Dialog.Title>
        <Dialog.Description>
          This will unregister <strong>{workspaceName}</strong> from Friday.
        </Dialog.Description>
      {/snippet}

      {#snippet footer()}
        <Dialog.Button onclick={confirmDelete} disabled={deleteMut.isPending} closeOnClick={false}>
          {deleteMut.isPending ? "Removing..." : "Remove"}
        </Dialog.Button>
        <Dialog.Cancel>Cancel</Dialog.Cancel>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>

<style>
  .setup-page {
    display: flex;
    flex-direction: column;
    gap: var(--size-5);
    padding: var(--size-8) var(--size-10);
  }

  .state-msg {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-3);
    text-align: center;
  }

  .workspace-header {
    align-items: flex-start;
    display: flex;
    gap: var(--size-4);
    justify-content: space-between;
  }

  .header-info {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .actions {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  :global(.more-trigger) {
    align-items: center;
    background-color: var(--color-surface-2);
    block-size: var(--size-6);
    border: none;
    border-radius: var(--radius-2-5);
    color: var(--text-1);
    cursor: default;
    display: inline-flex;
    inline-size: var(--size-6);
    justify-content: center;
    transition: all 150ms ease;
    user-select: none;
    -webkit-user-select: none;
  }

  :global(.more-trigger:hover) {
    background-color: color-mix(in srgb, var(--color-surface-2), var(--color-text) 5%);
  }

  .workspace-name {
    align-items: center;
    color: var(--color-text);
    display: flex;
    font-size: var(--font-size-8);
    font-weight: var(--font-weight-7);
    gap: var(--size-3);
    line-height: var(--font-lineheight-1);
    margin: 0;
  }

  .workspace-dot {
    align-items: center;
    aspect-ratio: 1;
    block-size: var(--size-4);
    display: flex;
    justify-content: center;

    span {
      background-color: currentColor;
      block-size: 11px;
      border: var(--size-0-5) solid var(--color-white);
      border-radius: var(--radius-round);
      box-shadow: var(--shadow-1);
      inline-size: 11px;
    }
  }

  .workspace-description {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-3);
    margin: 0;
    max-inline-size: 56ch;
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
    max-inline-size: 720px;
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

  .cred-block {
    background-color: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    margin: 0;
    padding: var(--size-4);
  }

  .cred-legend {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    padding: 0 var(--size-1);
  }

  .cred-helper {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    margin: 0;
  }

  .cred-options {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
  }

  .cred-option {
    align-items: center;
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    cursor: pointer;
    display: flex;
    gap: var(--size-2);
    padding: var(--size-2) var(--size-3);
    transition: border-color 150ms ease, background-color 150ms ease;
  }

  .cred-option:hover {
    border-color: color-mix(in srgb, var(--color-text), transparent 60%);
  }

  .cred-option.selected {
    border-color: var(--color-text);
  }

  .cred-option input[type="radio"] {
    flex-shrink: 0;
  }

  .cred-option-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .cred-option-name {
    color: var(--color-text);
    font-size: var(--font-size-2);
  }

  .cred-option-meta {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
  }

  .cred-option-default {
    background-color: color-mix(in srgb, var(--color-accent), transparent 80%);
    border-radius: var(--radius-1);
    color: var(--color-accent);
    font-size: var(--font-size-1);
    margin-block-start: 2px;
    padding: 0 var(--size-1);
    width: fit-content;
  }

  .cred-empty {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-2);
    margin: 0;
  }

  .cred-actions {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .cred-fallback {
    color: var(--color-accent);
    font-size: var(--font-size-1);
    text-decoration: underline;
  }

  .cred-error {
    color: var(--color-error);
    font-size: var(--font-size-2);
    margin: 0;
  }

  .override-section {
    border-top: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding-block-start: var(--size-4);
  }

  .override-toggle {
    align-items: flex-start;
    background: transparent;
    border: 0;
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    gap: var(--size-2);
    padding: 0;
    text-align: start;
  }

  .override-toggle:hover .override-title {
    color: color-mix(in srgb, var(--color-text), transparent 0%);
  }

  .override-chevron {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    display: inline-block;
    font-size: var(--font-size-3);
    line-height: 1;
    transform: rotate(0deg);
    transition: transform 150ms ease;
  }

  .override-chevron.open {
    transform: rotate(90deg);
  }

  .override-toggle-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .override-title {
    color: var(--color-text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
  }

  .override-hint {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
  }

  .override-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .override-item {
    background-color: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding: var(--size-3) var(--size-4);
  }

  .override-item-head {
    align-items: center;
    display: flex;
    gap: var(--size-3);
    justify-content: space-between;
  }

  .override-item-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .override-item-path {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    overflow-wrap: anywhere;
  }

  .override-item-using {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2);
  }

  .override-item-using.muted {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
  }

  .override-item-default-tag {
    background-color: color-mix(in srgb, var(--color-accent), transparent 80%);
    border-radius: var(--radius-1);
    color: var(--color-accent);
    font-size: var(--font-size-1);
    margin-inline-start: var(--size-1);
    padding: 0 var(--size-1);
  }

  .override-picker {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .override-picker-actions {
    display: flex;
    justify-content: flex-end;
  }

  .override-collapse {
    background: transparent;
    border: 0;
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    cursor: pointer;
    font-size: var(--font-size-2);
    padding: 0;
    text-decoration: underline;
  }

  .override-collapse:disabled {
    cursor: not-allowed;
    opacity: 0.6;
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
