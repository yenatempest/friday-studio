# Workspace Setup Interstitial Design

## Problem Statement

When users import example workspaces from GitHub (Discover Spaces) or upload
`workspace.yml` files, the workspace may contain unfilled configuration and
unresolved credentials. Currently:

- Placeholder strings like `[ADD EMAIL RECIPIENT HERE]` (see
  `/Users/ericskram/code/tempest/friday-studio-examples/rtx-price-monitor/workspace.yml`)
  are never filled in, causing runtime failures.
- Required MCP provider credentials (for example, `google-gmail` for the price
  monitor) are silently missing.
- The user has no way to know what's needed before the workspace attempts to
  run.
- Cron schedules fire even when the workspace is unconfigured, producing failed
  sessions.

The primary use case for v1 is giving users a clean import experience for our
own example workspaces (rtx-price-monitor and friends) — not arbitrary
user-authored YAML.

## Domain Decisions

- **Workspace Setup State** is orthogonal to Workspace lifecycle status
  (`inactive` / `running` / `stopped`) and Draft Mode (`direct` / `draft`). Do
  not model setup as a new Workspace status.
- **Setup Requirements** are unresolved user inputs that keep a Workspace in
  setup-required state.
- Setup Requirements have two v1 types:
  - **Config Requirement** — a key declared under `workspace_config:` whose
    entry has no `value` field, or whose `value` is `null`. Anything else —
    including `""`, `0`, `false` — counts as filled (a valid user choice).
  - **Credential Requirement** — a Link reference (`from: link, provider: X`)
    that would fail to resolve at runtime today. Specifically: provider-only
    ref where `getDefaultByProvider(provider)` returns null (the user has
    zero credentials for that provider, or has multiple credentials with no
    default). When Link *does* have a default, the ref auto-resolves at
    runtime and is **not** a Requirement — this preserves the "just works"
    behavior for existing workspaces. The setup form shows existing
    credentials as selectable rows _plus_ a "Connect another account"
    affordance only when there's a Requirement to satisfy.
- **Setup Completion** is the single path that resolves all Setup Requirements
  and reloads the Workspace deterministically. It writes user values to
  `workspace.yml` via the existing `applyMutation` pipeline (which preserves
  comments and structure), and lets the file watcher trigger the existing
  config-change reload. Atomic with respect to params and credential _choice
  selections_ — nothing is written to YAML until the user clicks Finish setup.
  Credential _connections_ are an exception: completing OAuth binds the
  Credential on the Link side as a side effect that survives tab close.
- **Setup Gate** prevents Workspaces with open Setup Requirements from running
  Jobs. Two layers: (1) **defer registration** of cron and fs-watch signals
  while `requires_setup` is true; (2) **runtime gate** at
  `triggerWorkspaceSignal` and `getOrCreateWorkspaceRuntime` that catches the
  seven register-less providers (`http`, `slack`, `telegram`, `whatsapp`,
  `discord`, `teams`, `system`) and chat (which bypasses the cascade). The gate
  returns a sentinel skip without ever creating a Session — so
  `persistSessionToHistory` doesn't need a setup-aware bypass.
- **`workspace.yml` is the single source of truth.** All user-supplied
  configuration values live in YAML. Setup Completion is the only platform
  write path; it goes through the existing `applyMutation` pipeline, which
  preserves comments and structure. There is no parallel metadata-backed
  values store, no JSON-on-disk side cache, no schema duplication.
- **`requires_setup` is derived, not stored.** It is recomputed from the
  parsed config every time the daemon needs to know it (workspace
  registration, file-change reload, runtime gate check). The mtime-keyed
  `configCache` already makes the parse cheap. Drift cases like "user
  `git pull`s and the YAML grows new declared keys" are handled
  automatically: the next config load re-derives a fresh truth.
- **No schema invention for credential pinning.** The existing
  `LinkCredentialRefSchema` already supports an optional `id` field that
  pins a specific Credential. Setup Completion uses the existing
  `updateCredential` mutation to write `id` into the link ref. No new YAML
  block, no parallel `credential_choices` invention.

## Solution

Introduce setup-required Workspaces. A workspace is setup-required if its
parsed config contains any Config Requirement or Credential Requirement
(see Detection Algorithm below). In this state:

- Cron and fs-watch signal registration is **deferred** until Setup Completion.
- The seven register-less signal providers (HTTP, Slack, Telegram, WhatsApp,
  Discord, Teams, system) and chat are caught by a **runtime gate** at
  `triggerWorkspaceSignal` and inside `getOrCreateWorkspaceRuntime`. The gate
  returns before any Session is created, so no skip-history bypass is needed.
- A dedicated `/setup` page shows exactly what must be configured.
- Users can access setup and basic management surfaces, including delete.
- Operational workspace surfaces redirect to `/setup` while setup remains
  required.
- Setup Completion writes user values to `workspace.yml` via `applyMutation`
  and `updateCredential`. The existing file watcher reload picks up the
  change and re-runs the config-change pipeline. The next derivation pass
  sees no Requirements and `requires_setup` flips to false.

The `workspace_config:` block in `workspace.yml` is one block that holds
both declarations and values. Each entry has an optional `description`
(helper text), an optional `schema` (JSON Schema describing the value's
shape — reuses the existing pattern from `signals.<name>.schema`,
`jobs.<name>.inputs`, and `jobs.<name>.fsm.documentTypes`), and an
optional `value` (what the user filled in). The existing `{{double_brace}}`
interpolator (already used for `{{repo_root}}`) is extended with one level
of dotted nesting to resolve `{{workspace_config.<key>}}` references at
load time, reading from each entry's `value` field (coerced to string).
Entries without a `value` are unfilled; the placeholder stays literal and
the existing interpolator warning fires.

Credentials reuse the existing schema: each link ref already accepts an
optional `id` field. A provider-only ref (`{ from: link, provider: X, key: Y }`)
is a Credential Requirement until Setup Completion writes `id` via the
existing `updateCredential` mutation.

## Detection Algorithm

`requires_setup` is computed by scanning the parsed `WorkspaceConfig`:

1. **Config Requirements** — walk every entry under `workspace_config:`. An
   entry is unfilled iff `value === undefined || value === null`. Anything
   else — including `""`, `0`, `false`, `[]`, `{}` — counts as filled (a
   valid user choice for the entry's declared `schema` type). One
   Requirement per unfilled entry. Source: pure YAML scan, no Link calls.

2. **Credential Requirements** — walk every link ref via the existing
   `extractCredentials` helper (`packages/config/src/mutations/credentials.ts`).
   For each provider-only ref (no `id` pinned), call
   `getDefaultByProvider(provider)`:
   - **Default exists** (Link returns a credential) → ref auto-resolves at
     runtime. **Not a Requirement.** This is the migration-safe path — Link
     auto-marks the first credential per provider as default at insert
     time, so single-credential users (and multi-credential users with a
     default) continue to "just work" without prompting.
   - **No default** (Link returns null) → emit a Credential Requirement
     carrying the user's existing credentials (which may be empty) as
     `options`. This is exactly the case where the workspace would fail at
     runtime today with `NoDefaultCredentialError`.
   For pre-pinned `id` refs, no Requirement is emitted regardless of
   default state. (If the pinned `id` no longer resolves, that's a hard
   error, not a Requirement — see step 3.)

3. **Hard errors** (not Requirements) — unknown Link Provider, expired
   credential, pinned `id` referring to a deleted credential. These remain
   creation/import errors; the setup page can't fix them.

`requires_setup` is the boolean OR of (any Config Requirement) and (any
Credential Requirement). It is derived on every parse — see "Domain
Decisions" above.

## User Stories

1. As a user importing the "RTX Price Monitor" example, I see a setup page with
   a field for my email address and a button to connect Gmail, so I know exactly
   what to configure before the workspace starts checking prices.
2. As a user uploading a `workspace.yml` with declared config keys, I want to
   fill in their values and see the workspace become ready, so I don't have to
   hand-edit YAML.
3. As a user who imported a workspace but got distracted, I want to find it in
   the sidebar with a setup badge, click it, and finish configuration later, so
   I don't lose my work.
4. As a user who has already connected Gmail to Friday, I want imported
   workspaces to use that credential automatically — no extra setup step
   for the credential — so the only thing I have to fill in is the
   workspace_config values the author left blank.
5. As a user with multiple Slack accounts and one marked default in Link, I
   want the same default to be used for new workspaces by default, but I
   also want a way to opt into pinning a different account for a specific
   workspace. (Solved via the optional pinning override on the setup page,
   not as a blocking Credential Requirement.)
6. As a user who accidentally imported a workspace I don't need, I want to
   delete it even in setup-required state, so I'm not stuck with dead
   workspaces.
7. As a user browsing Discover Spaces, I want to see what a workspace needs
   before I import it, so I can decide if I'm ready.
8. As a user whose cron-scheduled workspace is setup-required, I want scheduled
   checks to skip without polluting session history, so I don't get repeated
   bogus failures.
9. As a developer writing example workspaces, I want a clear, optional `config`
   block I can declare next to my agents, so I can mark which strings are
   user-configurable without inventing my own placeholder convention.
10. As a user with multiple connected credentials for a provider but no
    default set in Link, I want the setup page to show each account with a
    radio button when I import a workspace that uses that provider, so I
    can choose without guessing — and the choice is recorded as a
    workspace-specific pin so the workspace continues to use it even if my
    default changes later.
11. As a user who filled in my email during setup, I want to revisit the setup
    page later to update it without hand-editing YAML, so my workspace stays
    correct as my preferences change.
12. As a user sharing a workspace with a colleague, I want them to see the
    same `workspace_config` declarations I see — without my personal values
    baked in — so they can fill in their own and aren't stuck with mine.
    (The existing bundle-export already strips link `id` fields to provider
    refs "for portability"; the same export step walks
    `workspace_config[*]` and clears each entry's `value` field, leaving
    only the declaration metadata.)

## Non-Negotiable Constraints

- Setup state is derived readiness, not a lifecycle status.
- Setup Requirements are blocking requirements, not advisory hints.
- Config Requirements are for non-secret values only. Secrets, API keys,
  webhook URLs, and tokens belong in Link Credentials or explicit environment
  configuration, not the `workspace_config` block.
- Unknown or missing Link Providers are creation/import errors, not Setup
  Requirements. The setup page can only solve credential state for known
  providers.
- Setup Completion is atomic with respect to params and credential _choice
  selections_ — nothing is written to YAML until the request succeeds.
  Credential _connections_ are an exception: completing OAuth binds the
  credential on the Link side as a side effect that survives tab close. The
  setup page must make this asymmetry visible.
- **`workspace.yml` is the single source of truth.** Setup Completion is the
  only platform-side writer; it goes through `applyMutation` /
  `updateCredential`. There is no parallel metadata-backed values store.
- Setup Completion writes YAML and lets the existing file-watcher reload
  fire. The endpoint may also synchronously call `restartSignalsForWorkspace`
  to close the timing window between write and watcher delivery, but it must
  not skip the file-watcher path.
- `/setup/complete` is deleted outright. There is no compatibility shim (zero
  in-repo callers, never shipped externally).
- The `workspace_config:` block is one block: declarations and values
  coexist per entry. Each entry has an optional `description` and an
  optional `value`. There is no separate values block.
- **Filled-vs-unfilled rule.** An entry is unfilled iff `value === undefined`
  or `value === null`. `value: ""` is filled (empty string is a valid user
  choice). Document this rule in CONTEXT.md and the interpolator code.
- **No new schema for credential pinning.** Setup Completion writes `id`
  into existing link refs via the existing `updateCredential` mutation.

## Removals / Replacements

The following existing/planned paths should be removed or replaced:

1. **`GET /:workspaceId/setup` endpoint** — Not needed. The client derives
   Setup Requirements from the parsed config returned by existing workspace
   list/config endpoints.
2. **`unresolvedCredentials` as error for user-missing credentials** — Known
   provider with no credential becomes setup-required creation success.
   Unknown/missing provider remains a hard error.
3. **Credential error banner parsing in `workspace-loader.svelte`** — The
   upload modal routes to setup on `setupRequired: true` instead of formatting
   missing-provider errors.
4. **Per-page setup guards** — Use a platform-level navigation/layout guard
   for operational workspace pages. Setup and basic management remain
   accessible.
5. **New query/cache keys** — Extend existing workspace summary/config schemas
   with the (derived) `requires_setup` boolean and the `setup_requirements`
   payload. Don't invent a second cache lane for the same damn workspace.
6. **`POST /:workspaceId/setup/complete`** — Delete outright. Zero in-repo
   callers, not exposed in any generated client, not externally documented,
   one test file to update. Replaced by `POST /:workspaceId/setup` (Setup
   Completion).
7. **`metadata.workspace_config_values` and a sibling
   `workspace_config_values:` YAML block (proposed by earlier drafts).** Do
   not introduce either. Values live inline under each
   `workspace_config:` entry as a `value` field.
8. **`metadata.requires_setup` as a stored boolean.** Existing code already
   has the field in the schema (`packages/workspace/src/types.ts:22`), but
   nothing stable depends on it being persisted. Treat it as a derived
   computed property and stop writing to the metadata field. (Schema can keep
   the optional field for transitional reads but new code shouldn't set it.)
9. **`processSignal`-level skip-history bypass.** The plan no longer requires
   one. The runtime gate fires before any Session is created (see Setup
   Gate), so there's nothing for `persistSessionToHistory` to suppress.

## Implementation Decisions

### 1. `workspace_config:` Block

`workspace.yml` adds one optional top-level block: `workspace_config:`. Each
entry holds an optional `description` (helper text), an optional `schema`
(JSON Schema describing the value's shape and constraints — same convention
as `signals.<name>.schema`, `jobs.<name>.inputs`, and
`jobs.<name>.fsm.documentTypes`), and an optional `value` (what the user
filled in). The block name is chosen to (a) match the existing flat
snake_case root-variable convention (`workspace_id`, `workspace_path`,
`repo_root`) and (b) avoid colliding with the per-agent
`agents.<id>.config` block, which is a different concept.

**Before Setup Completion** — minimal form (author skips `schema:`, the
form treats `value` as a string):

```yaml
version: '1.0'
workspace:
  name: RTX Price Monitor

workspace_config:
  email_recipient:
    description: Email address where RTX price alerts are sent
    # (no value yet — author doesn't know the user's email)

agents:
  rtx-alert-emailer:
    type: llm
    config:
      prompt: >
        ... call google-gmail/send_gmail_message with
        to: "{{workspace_config.email_recipient}}" ...
```

**Before Setup Completion** — schema form (author declares constraints):

```yaml
workspace_config:
  email_recipient:
    description: Email address where RTX price alerts are sent
    schema:
      type: string
      format: email
      minLength: 3
```

**After Setup Completion** (Setup Completion added `value:` to the entry
and `id:` to the link ref):

```yaml
version: '1.0'
workspace:
  name: RTX Price Monitor

workspace_config:
  email_recipient:
    description: Email address where RTX price alerts are sent
    schema:
      type: string
      format: email
    value: alice@example.com   # ← written by Setup Completion, validated against schema

tools:
  mcp:
    servers:
      google-gmail:
        env:
          GOOGLE_GMAIL_ACCESS_TOKEN:
            from: link
            id: cred_abc123          # ← written by updateCredential mutation
            provider: google-gmail
            key: access_token
```

Schema (`packages/config/src/workspace.ts`):

```ts
import { JSONSchemaSchema } from "@atlas/schemas/json-schema";

export const WorkspaceConfigEntrySchema = z.object({
  description: z.string().optional(),
  schema: JSONSchemaSchema.optional(),
  value: z.unknown().nullable().optional(),
});

export const WorkspaceConfigSchema = z.strictObject({
  // ...existing keys
  workspace_config: z
    .record(z.string(), WorkspaceConfigEntrySchema)
    .optional(),
});
```

Rules:

- One block, two roles. Authors write entries with `description` and
  optionally `schema`. Setup Completion writes `value` onto each entry.
- **Filled-vs-unfilled.** An entry is unfilled iff `value === undefined ||
  value === null`. Anything else — including `""`, `0`, `false`, `[]`,
  `{}` — counts as filled (a valid user choice). Documented here, in
  CONTEXT.md, and asserted in the interpolator's variable-bag
  construction.
- **`schema` is JSON Schema.** Reuses the existing `JSONSchemaSchema` /
  `z.fromJSONSchema()` machinery from `packages/schemas/src/json-schema.ts`.
  Authors can declare `type`, `format`, `enum`, `pattern`, `minLength`,
  `maxLength`, etc. v1 ships a text input form widget regardless of `type`
  and validates the user's input against the schema at Setup Completion
  via `z.fromJSONSchema(schema).parse(value)`. Validation errors surface
  as form errors. Future versions can dispatch on `type` for type-aware
  form widgets without changing the schema.
- **Substitution coerces.** The variable bag's
  `workspace_config.<key>` is `String(entry.value)`. Numbers, booleans,
  etc. substitute cleanly into prompts. Objects and arrays substitute as
  `JSON.stringify(value)` (rare; documented as a known shape).
- Users may hand-edit the YAML directly to change values; the file watcher
  picks up changes either way.
- **Sharing-scrub** walks `workspace_config[*]` and clears each entry's
  `value` field, leaving only declaration metadata (`description`,
  `schema`). Pairs with the existing link-ref `id` strip already done by
  `bundle-helpers.ts`.
- The credential side has no analogous YAML addition: link refs already
  carry an optional `id`. Setup Completion sets it via the existing
  `updateCredential` mutation.

### 2. Setup Requirements Payload

There is no new metadata schema field for values — values live in YAML (see
§1). What the daemon does need is a way to deliver the structured Setup
Requirements payload to the client so the setup page can render. This is a
runtime-derived payload, not stored state.

Shape of the payload returned alongside workspace summaries / config
endpoints:

```ts
type SetupStatus = {
  requires_setup: boolean;
  setup_requirements?: {
    configKeys?: Array<{
      key: string;
      description?: string;
    }>;
    credentials?: Array<{
      provider: string;
      label?: string;
      options: Array<{
        id: string;
        label: string;
        displayName: string | null;
        userIdentifier: string | null;
        isDefault: boolean;
      }>;
    }>;
  };
};
```

The single `credentials` array (no Connection vs. Choice split) always
carries the user's existing options for that provider (which may be empty);
the setup page renders the list plus a "Connect another account" affordance
regardless of count.

This payload is **derived** from the parsed config + a Link-side credential
list lookup at the moment the daemon serves the response. There's no stored
`setup_requirements` field; it's computed on demand. Caching is fine
(per-workspace, invalidated by the existing config-change reload), but the
ground truth is always the parsed YAML plus current Link state.

The `WorkspaceMetadataSchema.requires_setup` field stays in the schema as
optional (existing code reads it transitionally), but new code should not
rely on the stored value — derive it.

### 3. Config Substitution at Load Time

Reuse `interpolateConfig` in `packages/workspace/src/variable-interpolation.ts`
rather than introducing a parallel substitution pass.

Two changes:

**(a) Extend the placeholder regex** to support one level of dotted nesting:

```ts
// before: /\{\{([a-z_]+)\}\}/g
// after:  /\{\{([a-z_]+(?:\.[a-z_]+)?)\}\}/g
```

Resolution:

- `{{repo_root}}` → top-level variable bag (existing behavior).
- `{{workspace_config.email_recipient}}` →
  `variables.workspace_config?.email_recipient`.
- Unknown keys remain logged as warnings and left in place (existing behavior).
  This is what makes setup-required workspaces safe: unfilled
  `{{workspace_config.x}}` stays literal, the setup gate prevents the runtime
  from running, and no garbage data leaks into prompts.

**(b) Build the `workspace_config` namespace** from the parsed config in
`resolveWorkspaceVariables` (or a thin wrapper around it):

```ts
const wsVars = await resolveWorkspaceVariables(...);
const entries = parsedConfig.workspace_config ?? {};
const variables = {
  ...wsVars,
  workspace_config: Object.fromEntries(
    Object.entries(entries)
      .filter(([_, entry]) => entry.value != null) // drop unfilled
      .map(([k, entry]) => [
        k,
        typeof entry.value === "object"
          ? JSON.stringify(entry.value)
          : String(entry.value),
      ]),
  ),
};
```

Source: the parsed `WorkspaceConfig` already in hand. No metadata read.
Unfilled entries are absent from the bag, so `{{workspace_config.x}}` stays
literal at substitution time and the existing warning fires. Numbers,
booleans, etc. coerce via `String(value)`; arrays and objects serialize via
`JSON.stringify` (rare; reserved for future expressivity).

Why post-validation is fine: every workspace-config string field that's a
substitution target (agent `prompt`, LLM action `prompt`, tool name strings,
etc.) is plain `z.string()` with no email/URL/regex refinements (verified
against `packages/config/src/agents.ts`, `packages/fsm-engine/schema.ts`, and
`packages/agent-sdk/src/types.ts`). The literal
`{{workspace_config.email_recipient}}` passes Zod validation as a string, and
gets substituted before the LLM sees it. No new pre-validation pass is needed.

**No namespace collision with PR #199.** PR #199's prompt-runtime interpolator
exposes `{{inputs.x}}`, `{{config.x}}` (legacy alias), and
`{{signal.payload.x}}` — all resolving from `prepareResult.config`. By choosing
`{{workspace_config.x}}` (rather than `{{config.x}}`) for workspace-level user
values, this plan avoids the collision entirely. The two interpolators operate
on disjoint namespaces and run at different stages: config-time interpolation
runs first at workspace load (resolving `{{workspace_config.x}}`); runtime
prompt interpolation runs later inside fsm-engine (resolving `{{inputs.x}}` /
`{{config.x}}` / `{{signal.payload.x}}`). The legacy `{{config.x}}` alias in PR
#199 can remain as-is — it never resolves to workspace-level values.

### 4. `POST /create` — Setup-Required Creation

Request shape:

```ts
{
  config: Record<string, unknown>;
  workspaceName?: string;
  ephemeral?: boolean;
}
```

Flow:

1. Parse `config` as today.
2. Inject bundled agent credential refs as today.
3. Run the Detection Algorithm (see top of document) to compute
   `requires_setup` and the `setup_requirements` payload. Provider-only
   refs with a Link default are **not** Requirements.
4. **Preserve the existing single-credential auto-pin behavior.** Today's
   `/create` rewrites provider-only refs to pinned `id` refs when exactly
   one credential exists for the provider (`toIdRefs` at
   `apps/atlasd/routes/workspaces/index.ts:521`). This stays. It's
   independent of the Detection Algorithm — auto-pin happens before the
   YAML hits disk; detection runs on the parsed config (which already
   reflects the pin). The combined effect: single-credential users get a
   pinned `id` in their YAML, multi-credential-with-default users get a
   provider-only ref that auto-resolves at runtime, multi-credential-no-default
   users see a Requirement.
5. If `requires_setup === true`:
   - Write `workspace.yml` to disk (post-`toIdRefs` pin, no other platform
     mutation).
   - Register workspace with `skipEnvValidation: true` **and skip cron /
     fs-watch signal registration** (see §5).
   - Return `{ workspaceId, setupRequired: true, setup_requirements }`.
6. Otherwise:
   - Write `workspace.yml` to disk.
   - Register workspace normally.
   - Return `{ workspaceId, setupRequired: false }`.

There is no `metadata.workspace_config_values` initialization step — values
live inline under each `workspace_config:` entry as `value`. There is no
`metadata.requires_setup` write either; the flag is derived. The only
metadata mutation is the existing path for non-setup-related workspace
metadata.

### 5. Setup Gate — Hybrid Model

Of the nine signal providers, only two register per-workspace today (`schedule`
via `CronSignalRegistrar`, `fs-watch` via `FsWatchSignalRegistrar`). The other
seven (`http`, `slack`, `telegram`, `whatsapp`, `discord`, `teams`, `system`)
plus chat have no per-workspace registration phase — webhook routes mount
globally at daemon startup, and inbound traffic dynamically routes to workspaces
via config lookup. Gate accordingly.

**(a) Defer registration of cron and fs-watch.**

In `packages/workspace/src/manager.ts`, mirror the existing ephemeral skip when
calling `registerWithRegistrars`:

```ts
const shouldSkipRegistration = Boolean(workspace.metadata?.ephemeral) ||
  workspace.configPath.endsWith("eph_workspace.yml") ||
  Boolean(workspace.metadata?.requires_setup);

if (!shouldSkipRegistration) {
  await this.registerWithRegistrars(workspace.id, workspace.path, cfg);
}
```

Apply the same guard inside `restartSignalsForWorkspace` (`manager.ts:1125`) so
a `workspace.yml` edit while setup-required doesn't accidentally register
signals.

This avoids zombie `fs.watch()` descriptors on paths that don't exist yet, and
skips broken-schedule KV writes for cron timers.

**(b) Runtime gate at `triggerWorkspaceSignal` and
`getOrCreateWorkspaceRuntime`.**

For the seven register-less providers and chat, the gate must live at the
runtime entry point. Two layers of belt-and-suspenders:

1. **`triggerWorkspaceSignal` in `apps/atlasd/src/atlas-daemon.ts`:**
   short-circuit cascade-dispatched signals (cron, fs-watch, HTTP, communicator
   inbound via NATS) before runtime instantiation. Returns a sentinel
   `{ skipped: true, reason: "setup_required" }`.

2. **`getOrCreateWorkspaceRuntime`:** the load-bearing choke point. Catches chat
   (which bypasses the cascade and calls `runtime.triggerSignalWithSession`
   directly). When `requires_setup` is true, return without creating the runtime
   — no agents register, no Session is created.

**Crucially: the gate fires before any `SessionResult` is constructed.** No
`finalizeSession` call, no `persistSessionToHistory` call, no skip-history
bypass needed. This is what made the hybrid approach simpler than the
register-and-gate alternative.

**(c) After Setup Completion.**

The Setup Completion endpoint explicitly invokes `restartSignalsForWorkspace`,
which re-runs `registerWithRegistrars` now that `requires_setup` is false. Cron
timers register, fs-watch descriptors spawn, and the runtime gate stops
short-circuiting on the next trigger.

### 6. `POST /:workspaceId/setup` — Setup Completion

Single endpoint for finishing or re-editing setup. `/setup/complete` is
deleted outright (zero callers, never shipped).

Request:

```ts
{
  workspaceConfigValues: Record<string, string>;
  credentialChoices: Record<
    string,        // path: "mcp:<serverId>:<envVar>" or "agent:<agentId>:<envVar>"
    string         // credential id (e.g. "cred_abc123")
  >;
}
```

The `credentialChoices` keys are **paths to specific link refs**, not
provider names. This is required because the same provider can be referenced
multiple times across MCP servers / atlas agents, and the user picks per
ref. (For v1 the setup page can group paths by provider in the UI and
default to the same pick across all paths sharing a provider, but the wire
format is per-path so we don't paint ourselves into a corner.)

Semantics:

- `workspaceConfigValues[key]` is written as `workspace_config[key].value`
  in YAML and satisfies the corresponding Config Requirement.
- `credentialChoices[path]` writes `id: <credentialId>` onto the link ref
  at that path via the existing `updateCredential` mutation
  (`packages/config/src/mutations/credentials.ts`).
- The endpoint accepts pins for **any** path the user wants to override —
  not just paths that currently have a Credential Requirement. The setup
  page's "Pin a specific credential" override (see §8) sends pins for
  refs that would otherwise auto-resolve via Link's default. The endpoint
  does not distinguish required vs. opt-in pins; it simply writes whatever
  the client sends.
- Atomic for params and credential choices: the platform applies all
  mutations in a single `applyMutation` invocation that writes YAML once.
  If any mutation fails, none are applied.
- Credential connections opened via the "Connect another account"
  affordance are an exception — OAuth completes outside this endpoint and
  binds the credential at the Link layer immediately, surviving tab close.

Flow:

1. Load workspace and parse current YAML to confirm setup is required (or
   treat as edit if not).
2. Validate that every declared `workspace_config` key is present in
   `workspaceConfigValues` (or already filled — has a non-null `value` —
   in the parsed config).
3. **Validate each `workspaceConfigValues[key]` against the entry's
   `schema`**, if a schema is declared. Use
   `z.fromJSONSchema(entry.schema).parse(value)` and surface validation
   errors per-field. Entries without a schema accept the value as-is for
   v1 (treated as string).
4. Validate every Credential Requirement is satisfied by `credentialChoices`
   (or by an `id` already pinned on the ref from a prior submission).
5. Compose a single `applyMutation` call that, against the parsed config:
   - For each `(key, value)` in `workspaceConfigValues`, sets
     `draft.workspace_config[key].value = value` (creating the entry shell
     `{ value }` if it didn't exist — though the Detection Algorithm
     guarantees it does).
   - For each path in `credentialChoices`, calls `updateCredential` to set
     `id` on the matching link ref.
6. `applyMutation` writes the YAML. The file watcher sees the mtime change
   and runs the existing config-change/reload pipeline, which re-derives
   `requires_setup` (now false) and re-registers cron / fs-watch signals.
7. To close the timing window between write and watcher delivery, also
   synchronously call `restartSignalsForWorkspace` from the endpoint.
8. Return `{ success: true }`.

> **YAML is the single writeable surface.** All values live in YAML;
> Setup Completion is the only platform-side writer; comment / structure
> preservation is handled by `applyMutation`. Hand-editing the YAML to
> change values later works too, the file watcher will pick it up.

Re-submission works the same way. A user revisiting `/setup` with
already-set values can submit new values; the setup page is the editor.

### 7. Discover Import — Single Path

Both delivery mechanisms — Discover Spaces (GitHub fetch) and UI export → zip →
re-import — already converge on `/import-bundle`. The current Discover route at
`tools/agent-playground/src/lib/server/routes/discover.ts` fetches files from
GitHub, zips them client-side, and POSTs the zip to the daemon's
`/import-bundle`. UI export at `GET /api/workspaces/:id/bundle` produces the
same zip shape. Don't bifurcate.

**The `workspace.lock` file is meaningful — keep it in the bundle path.** It
carries the mode discriminator (`definition` vs `migration`) and SHA-256
integrity hashes for any bundled `skills/` and `agents/` directories. Empty
`primitives` (the current state of every example) is normal: those examples
reference bundled agents and MCP servers by ID rather than shipping custom code.
The bundle handler validates hashes; ignoring the lock would skip that check.

Import behavior:

- Discover keeps its current zip-then-`/import-bundle` flow. Don't add a
  raw-YAML fast-path; it would solve a problem that doesn't exist (no current
  example ships without a lock) and create exactly the experience-divergence
  this feature exists to prevent.
- UI uploads keep posting zips to `/import-bundle` (single) or
  `/import-bundle-all` (batch).
- Both surfaces always return `{ workspaceId, setupRequired }`.

**Setup processing lives at the bundle handler.** `/import-bundle` parses the
bundle's `workspace.yml`, calls the shared `resolveWorkspaceSetupRequirements`
helper (also called by `/create`), then either:

1. Writes `workspace.yml` as supplied, sets `requires_setup: true`, populates
   `setup_requirements`, returns `setupRequired: true`; or
2. Writes `workspace.yml` as supplied, registers normally, returns
   `setupRequired: false`.

`/import-bundle-all` runs the same sequence inside its per-workspace loop. There
is no "bundled workspaces bypass setup" escape hatch.

### 8. Client Setup Page

New route: `/platform/{workspaceId}/setup`.

Render sections from Setup Requirements:

- Config Requirements: text inputs labeled by key, with `description` as
  helper text when present.
- Credential Requirements: a single block per provider that always shows
  the user's existing credentials for that provider as selectable rows
  (preselected when exactly one exists) plus a "Connect another account"
  affordance that invokes `ConnectService`. Subtle helper text on this
  block notes that connecting a new account persists immediately, even if
  the user doesn't finish setup.

**Optional pinning override** (always available, never required):

- A collapsed "Pin credentials per-workspace" section lists every link ref
  in the workspace that resolves via Link's default (i.e., refs that are
  *not* a Requirement but *could* be overridden).
- For each ref, show the currently-resolved credential and a "Pin a
  different account" button that expands the same picker UI as a Credential
  Requirement.
- Pinning here is opt-in. Users with one Slack account never see this
  expanded; users with multiple Slacks who want a particular workspace to
  use a non-default account can pin explicitly.

Submit behavior:

- Button label: "Finish setup" (or "Save changes" when setup is already
  complete and the user is editing).
- Disabled until all Config Requirements have values and every Credential
  Requirement has a selected credential. Optional pins do not affect the
  enabled state.
- On success, invalidate workspace queries and navigate to
  `/platform/{workspaceId}`.

If setup is already complete and the user explicitly navigates to `/setup`,
show the same form prefilled from each parsed `workspace_config[*].value`
field and the link refs' current `id` fields so they can edit. Otherwise,
completion redirects to the workspace root.

### 9. Navigation and Sidebar

- Workspace sidebar items with setup required show a small setup badge/pill.
- Clicking a setup-required workspace routes to `/platform/{workspaceId}/setup`.
- Deep links to operational pages (`chat`, `agents`, `jobs`, etc.) redirect to
  setup while setup is required.
- Basic management/delete remains reachable.

### 10. Add Workspace Upload Flow

`workspace-loader.svelte` parses YAML client-side to extract the workspace name
for the UI, then sends the parsed config object:

```ts
const text = await file.text();
const config = parseYaml(text);
await client.workspace.create.$post({
  json: { config, workspaceName },
});
```

If the response has `setupRequired: true`, route to
`/platform/{workspaceId}/setup`; otherwise route to the workspace root.

> **Important:** The client must not validate the parsed config against a schema
> that rejects an unknown `workspace_config` key. The schema being added in
> Decision 1 makes the `workspace_config` block legal, so once
> `WorkspaceConfigSchema` is updated, this concern collapses.

### 11. Data Isolation

No new user-scoped tables. Setup state is derived from the parsed YAML;
values live in YAML. Existing workspace access rules apply: a user can only
see their own workspaces.

Sharing a workspace walks `workspace_config[*]` and clears each entry's
`value` field, leaving declarations intact. It also strips the `id` field
from every link ref (the latter is already done by `bundle-helpers.ts` for
portability). Recipients see the `workspace_config:` declarations and
provider-only link refs, and run setup themselves.

## Testing Decisions

1. **Schema: `workspace_config` block parsing**
   - Empty `workspace_config` block parses as empty record.
   - Entry with neither `description` nor `schema` nor `value` parses
     successfully.
   - Entry with only `description` parses successfully.
   - Entry with `value: ""` parses (empty string is filled).
   - Entry with `value: 0` parses (zero is filled).
   - Entry with `value: false` parses (false is filled).
   - Entry with `value: null` parses (null is unfilled).
   - Entry with `schema: { type: string, format: email }` parses via
     `JSONSchemaSchema`.
   - Entry with both `schema` and `value` parses.
   - Unknown subfields are rejected by entry-level strict validation.

2. **Interpolator: `{{workspace_config.x}}` resolution**
   - Variable bag includes `foo` iff `workspace_config.foo.value` is
     non-null and non-undefined.
   - Variable bag excludes `foo` when `value` is `undefined` or `null`.
   - Numbers and booleans coerce via `String(value)`.
   - Objects and arrays coerce via `JSON.stringify(value)`.
   - Empty string (`""`) appears in the bag and substitutes as empty
     string.
   - Replaces `{{workspace_config.foo}}` with the coerced value when
     bag-present.
   - Leaves `{{workspace_config.foo}}` literal when bag-absent (logs
     warning).
   - Handles nested `{{workspace_config.foo}}` inside larger strings.
   - Does not affect existing `{{repo_root}}` etc. resolution.
   - Does not affect PR #199's prompt-runtime `{{config.x}}` legacy alias.
   - Does not mutate the input config object.

3. **Server: `/create` with `workspace_config` block**
   - Entries with no `value` (or `value: null`) produce Config Requirements.
   - Entries with `value` (including `""`) → no Config Requirements.
   - Returns `setupRequired: true` and a `setup_requirements` payload when
     requirements exist.
   - `workspace.yml` is written byte-for-byte as supplied (no platform
     mutation at create time).

4. **Server: `/create` with credentials (migration-safe rule)**
   - Provider-only link ref + Link has a default for that provider →
     **not** a Credential Requirement (workspace would resolve at runtime).
   - Provider-only link ref + zero credentials → Credential Requirement.
   - Provider-only link ref + multiple credentials, no default →
     Credential Requirement.
   - Pre-pinned link ref (`id` already set) does **not** produce a
     Requirement.
   - Single-credential auto-pin behavior (existing): `toIdRefs` rewrites
     the YAML to pin `id` when exactly one credential exists. Asserted by
     the existing `import-credentials.test.ts` cases.
   - **Migration regression test**: a workspace with a provider-only ref
     imported by a user who has one credential (auto-marked default in
     Link) creates with `setupRequired: false`.
   - Unknown provider remains a hard error.
   - Expired credential remains a hard error.

5. **Server: deferred registration**
   - Workspace created with `requires_setup: true` does not register cron timers
     (no entry in `CRON_TIMERS` KV bucket).
   - Workspace created with `requires_setup: true` does not spawn fs-watch
     descriptors.
   - Setup Completion triggers `restartSignalsForWorkspace`, after which cron
     and fs-watch register normally.

6. **Server: runtime gate**
   - Cascade-dispatched signal to setup-required workspace returns
     `{ skipped: true, reason: "setup_required" }` from `triggerWorkspaceSignal`
     without instantiating a runtime.
   - Chat trigger to setup-required workspace short-circuits in
     `getOrCreateWorkspaceRuntime` without registering agents.
   - **No `SessionResult` is constructed**, no `persistSessionToHistory` call,
     no history record (positive assertion: history table unchanged).
   - Setup-complete workspace executes normally through both paths.

7. **Server: `POST /:workspaceId/setup` Setup Completion**
   - Writes `workspaceConfigValues` as `workspace_config[key].value`
     entries via `applyMutation`.
   - Writes `id` onto each affected link ref via `updateCredential`
     mutation.
   - **Validates each value against `workspace_config[key].schema`** when
     a schema is declared, via `z.fromJSONSchema(schema).parse(value)`.
     Schema violations surface per-field without writing the YAML.
   - Entries without a schema accept the value as-is (v1).
   - Mutations compose into a single `applyMutation` call (one YAML write).
   - Fails without writing if validation or any mutation fails.
   - Comments and structure of the YAML are preserved across the write.
   - Re-derived `requires_setup` flips to false after the write because the
     YAML now satisfies the Detection Algorithm.
   - Synchronously triggers `restartSignalsForWorkspace`.
   - Re-submission with new values overwrites prior `value` fields in the
     YAML.

8. **Client: Setup page rendering**
   - Renders fields from Setup Requirements.
   - Renders one block per Credential Requirement with existing options as
     selectable rows plus "Connect another account".
   - Preselects the row when exactly one credential exists.
   - Renders the optional "Pin credentials per-workspace" section
     collapsed by default; expanding lists every link ref that auto-resolves
     via default.
   - Pinning a ref via the override section sends a `credentialChoices`
     entry on submit; the Finish setup button stays enabled regardless of
     whether overrides are filled in.
   - Submits Setup Completion payload and navigates on success.
   - When setup is complete, prefills from each
     `workspace_config[*].value` and the link refs' current `id` fields
     for editing.

9. **Client: Navigation guard**
   - Operational deep links redirect to setup while setup is required.
   - Delete/basic management remains accessible.

10. **Integration: Discover import → setup → finish → run**
    - Discover import zips `workspace.yml` + `workspace.lock` + `README.md`,
      POSTs to `/import-bundle`, lands setup-required.
    - Setup page shows config + credential requirements.
    - Setup Completion writes `value` fields under `workspace_config:` and
      `id` fields onto link refs.
    - File watcher reloads; `requires_setup` re-derives to false.
    - Subsequent cron signal load resolves `{{workspace_config.*}}` from
      the parsed YAML and executes normally.
    - YAML comments and structure are preserved across the Setup Completion
      write.

11. **Integration: UI export → re-import**
    - Round-tripped export walks `workspace_config[*]` clearing each
      entry's `value`, and strips link `id` fields. Recipient imports
      through the same `/import-bundle` handler and lands in the same
      setup-required state as a Discover import of the same content.

## Out of Scope

- Pre-flight endpoint that scans a workspace before creation.
- Auto-detection of config values from user profile.
- Batch Setup Completion of multiple workspaces.
- **Type-aware form widgets dispatched from `schema.type`.** v1 ships a
  text input for every entry regardless of declared type. The schema is
  parsed and used for *validation* in v1, but not for widget selection.
  Number inputs, dropdowns for `enum`, etc. come later — and don't
  require a schema migration when they do.
- **`default` values from JSON Schema.** v1 doesn't prefill from
  `schema.default` — every declared key must be filled by the user.
  Adding default-prefill is a future enhancement.
- Sensitive value storage (use Link Credentials).
- Per-reference credential choices within one workspace.
- Setup wizard / multi-step flow.
- Auto-installing missing Link Providers.
- Default values for config keys. (Every declared key must be filled.)
- A separate "edit configuration" UI distinct from the setup page. (The
  setup page doubles as the editor.)

## Implementation Notes

- **YAML is the single source of truth.** No metadata-backed values store.
  `WorkspaceConfigSchema` gains one optional top-level field
  (`workspace_config`), each entry shaped
  `{ description?: string, schema?: ValidatedJSONSchema, value?: unknown | null }`.
  The existing `workspace.metadata.requires_setup` field stays in the
  schema for transitional reads but new code should derive the boolean
  rather than rely on a stored value.
- **JSON Schema reuse**. The `schema` field uses `JSONSchemaSchema` from
  `packages/schemas/src/json-schema.ts` — same type already used by
  `signals.<name>.schema` (`packages/config/src/signals.ts:36`),
  `jobs.<name>.inputs` (`packages/config/src/jobs.ts:144-147`), and
  `jobs.<name>.fsm.documentTypes` (`packages/fsm-engine/types.ts:38`).
  Validation at Setup Completion uses the same `z.fromJSONSchema()` /
  `parse()` pattern those subsystems already use. No new validation
  infrastructure.
- **Daemon already re-parses YAML on demand** with mtime-keyed caching
  (`packages/workspace/src/manager.ts:120, 444-490`). Setup Completion's
  YAML write naturally invalidates that cache via the existing file-watcher
  reload path. No new caching layer needed.
- **Existing code currently has `/setup/complete`** — delete it outright
  (zero in-repo callers, not exposed in any generated client, never shipped
  externally, one test file to update).
- **No skip-history bypass needed.** The hybrid Setup Gate fires before any
  `SessionResult` is constructed, so `persistSessionToHistory` doesn't need
  to learn a setup-aware exception.
- **Existing Discover listing** already filters folders that contain both
  `workspace.yml` and `workspace.lock`. Keep that filter — it works for
  every current example.
- **Unified setup processing**: Extract a shared helper
  (`resolveWorkspaceSetupRequirements`) that `/create`, `/import-bundle`,
  and `/import-bundle-all` all call. It takes a parsed `WorkspaceConfig`
  object, returns
  `{ requires_setup: boolean, setup_requirements: SetupRequirements, overridableRefs, unresolvedProviders, expiredCredentials }`.
  - Walk `workspace_config:` checking each entry's `value` for Config
    Requirements.
  - Walk link refs via `extractCredentials(workspaceConfig)`. For each
    provider-only ref, call `getDefaultByProvider(provider)`:
    - Returns null → Credential Requirement (carry user's existing
      credentials as `options`, may be empty).
    - Returns a credential → ref auto-resolves at runtime; not a
      Requirement. Add to `overridableRefs` so the setup page can offer
      opt-in pinning.
  - The `/create` endpoint's existing `toIdRefs` auto-pin (single
    credential exists for provider) is preserved upstream of this helper —
    after auto-pin, those refs become `id`-pinned and no longer
    provider-only.
- **Migration safety property**: any workspace that resolved at runtime
  before this plan ships continues to resolve. The Detection Algorithm
  flags only refs where `getDefaultByProvider` returns null, which is
  exactly when today's runtime would throw `NoDefaultCredentialError`.
  Captured by an explicit migration regression test (see Testing
  Decisions §4).
- **Interpolator extension**: Update `PLACEHOLDER_RE` in
  `packages/workspace/src/variable-interpolation.ts` to support one level
  of dotted nesting, and build the variable bag's `workspace_config`
  namespace by walking `parsedConfig.workspace_config` and including
  entries whose `value != null`, coerced to string via `String(value)`
  (or `JSON.stringify(value)` for non-primitive `value`). Source is the
  parsed `WorkspaceConfig`, not metadata.
- **No naming collision with PR #199.** PR #199's prompt-runtime
  interpolator owns `{{inputs.x}}`, `{{config.x}}` (legacy alias), and
  `{{signal.payload.x}}`, all resolving from `prepareResult.config`. By
  scoping workspace-level user values to `{{workspace_config.x}}`, the two
  interpolators operate on disjoint namespaces. Both can coexist
  indefinitely; no deprecation needed.
- **Setup Completion writes via existing mutation pipeline.** No new
  file-handling code:
  - `applyMutation(workspacePath, fn)` at
    `packages/config/src/mutations/apply.ts:153-203` — atomic temp-file
    write, comment / structure preservation.
  - `updateCredential(config, path, credentialId)` at
    `packages/config/src/mutations/credentials.ts:88-156` — composes inside
    the same `applyMutation` to set `id` on a link ref.
  - The Config-side mutation walks `draft.workspace_config[key]` and sets
    `value`. Use `produce` (already used by `updateCredential`) for the
    immutable update.
  - One `applyMutation` invocation per Setup Completion — all mutations
    composed into one pure transformer function.
- **Setup Gate guards**:
  - `packages/workspace/src/manager.ts:194` — extend the ephemeral skip in
    `registerWithRegistrars` to also skip when the derived
    `requires_setup === true`.
  - `packages/workspace/src/manager.ts:1125` — same guard in
    `restartSignalsForWorkspace` so a YAML edit that reintroduces
    Requirements doesn't accidentally register signals.
  - `apps/atlasd/src/atlas-daemon.ts:1916` — short-circuit
    `triggerWorkspaceSignal` for setup-required workspaces.
  - `apps/atlasd/src/atlas-daemon.ts` (`getOrCreateWorkspaceRuntime`) —
    short-circuit before runtime instantiation.
- **Workspace export/sharing.** Existing `bundle-helpers.ts` already strips
  link-ref `id` fields "for portability." Extend the same export step to
  also walk `workspace_config[*]` and clear each entry's `value` field.
  Recipients see declarations and provider-only refs, then run setup
  themselves.

## ADR

No ADR yet. The decision is important, but the plan and domain context capture
the trade-offs sufficiently for implementation. Create an ADR only if
implementation reveals a broader architectural split between import, setup, and
runtime gating that future maintainers would not infer from code.
