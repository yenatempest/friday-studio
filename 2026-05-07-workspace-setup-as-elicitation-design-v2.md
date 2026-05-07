# Workspace Setup as Elicitation Design

## Problem Statement

The workspace setup interstitial that just shipped
(`docs/plans/2026-04-29-workspace-setup-interstitial-design.md`) blocks the
entire workspace UI when `requires_setup === true`. Every operational route,
including chat, redirects to a static `/setup` form. Two consequences in
practice:

1. Workspace chat is unreachable on a setup-required workspace, so users cannot
   ask the workspace-chat agent what the workspace does, why setup is needed,
   or for help filling the form. They see a form before they see the workspace.
2. Setup is modeled as a navigational dead-end rather than as a request the
   workspace makes of the user. There is no chat-addressable surface for "this
   workspace needs config values from you before it can run a job."

Meanwhile a sibling branch introduced an elicitation system: a JetStream-backed
primitive for human-in-the-loop asks (`tool-allowlist`, `auth-refresh`,
`confirm-action`, `open-question`), each tied to a session, with KV-backed
status and stream-backed delivery. The system is the natural fit for "the
workspace is asking the user for something" but currently has no kind for
workspace setup.

## Solution

Unblock chat on setup-required workspaces, and add a new elicitation kind
`workspace-setup` that the workspace-chat agent can emit when the user asks for
something the unset workspace cannot do yet. The elicitation carries a
JSON-schema-driven form for unfilled `workspace_config` values; the user fills
it inline; the answer handler writes YAML through the existing setup
completion pipeline; the agent retries the original request.

Credentials are out of scope for this elicitation. They are handled by the
existing `connect_service` tool, which the agent calls separately when a
provider connection is missing.

The derived `requires_setup` flag stays as the gating signal for non-chat
surfaces (cron, fs-watch, HTTP, Slack, etc.). The static `/setup` page stays
as the canonical advanced editor (full setup including credentials and
pinning override). The elicitation is a chat-native fast-path for the common
case: "fill in the config values you forgot."

## User Stories

1. As a user importing the RTX Price Monitor example, I want to land in
   workspace chat instead of a setup form, so I can ask the agent what the
   workspace does before I configure it.
2. As a user in chat on a setup-required workspace, I want to ask "what is this
   workspace?" and get an answer, so I learn what I am about to configure.
3. As a user in chat on a setup-required workspace, I want to ask "monitor RTX
   prices for me" and have the agent surface a form for the missing config
   values inline, so I can fill them without leaving the conversation.
4. As a user filling the inline form, I want to see the same field labels,
   helper text, and validation as the `/setup` page, so the experience is
   consistent across surfaces.
5. As a user who fills config values inline, I want the chat session to resume
   and act on my original request once setup is complete, so I do not have to
   re-ask.
6. As a user with a missing Gmail credential, I want the agent to call
   `connect_service('google-gmail')` and prompt me to OAuth, so the credential
   flow is handled separately from config-value filling.
7. As a user who would rather use the full setup page, I want the existing
   `/setup` route and form to keep working, so I can fill credentials, pin
   non-default credentials per workspace, and edit values after setup is
   complete.
8. As a user who fills config values via `/setup` while a chat-emitted
   elicitation is pending, I want the elicitation to auto-resolve, so I do not
   see a stale form in the activity panel.
9. As a user who direct-edits `workspace.yml` to fill config values, I want any
   pending workspace-setup elicitations to auto-resolve, so the activity panel
   reflects the actual workspace state.
10. As a user with two chat sessions open on the same setup-required
    workspace, I want both sessions to converge on the same elicitation, so I
    do not see duplicate forms.
11. As a user who deletes a workspace with a pending setup elicitation, I want
    the elicitation to be marked declined automatically, so it does not zombie
    in the activity log.
12. As a developer maintaining cron-triggered workspaces, I want cron, fs-watch,
    and inbound webhook signals to keep skipping setup-required workspaces
    without creating sessions, so failed runs do not pollute history.
13. As a user who finishes setup, I want the workspace-chat agent's prompt to
    stop showing the setup-status block, so the agent does not keep asking me
    to fill things I already filled.
14. As a developer writing a new workspace example, I want the elicitation form
    to render text inputs from each `workspace_config[key].schema` declaration,
    so my JSON-schema validation rules apply on submit.

## Implementation Decisions

### Elicitation Kind: `workspace-setup`

A new kind joins the existing four. The request payload carries the same
`configKeys` shape that `setup_requirements` already exposes via the workspace
summary endpoint. The credentials block is omitted; that gap is the agent's
responsibility via `connect_service`.

The answer envelope becomes a discriminated union by `kind`. Existing kinds
keep their flat `{ value: string; note?: string }` shape. The new kind carries
`{ kind: 'workspace-setup'; workspaceConfigValues: Record<string, unknown> }`.

`workspace-setup` is exempt from the 30-minute expiry sweeper. Setup may sit
unfinished for days. The state machine is `pending → answered | declined`.

### Producer: `request_workspace_setup` Tool

A new tool factory lives next to the existing `request_tool_access` factory at
`packages/system/agents/workspace-chat/tools/`. It is in-process for the
workspace-chat agent.

The tool takes one optional argument: `reason: string` (what the user just
asked for, used for form context if rendered). It does not take requirement
arguments; the daemon reads `setup_requirements` fresh from the canonical
derivation. The tool returns
`{ status: 'completed' | 'declined' }` after the elicitation resolves. On
`completed`, the agent retries the user's original request.

The tool subscribes to the elicitation's stream subject and resolves when KV
status flips. Same await pattern as `request_tool_access`.

### Producer: System-Prompt Augmentation

When the daemon spawns a workspace-chat agent on a workspace where
`requires_setup === true`, it injects a setup-status block into the system
prompt. The block names unfilled config keys and missing credentials, tells the
agent both gaps must clear before runtime, and pairs each gap with the
appropriate tool call (`request_workspace_setup` for config,
`connect_service(<provider>)` for credentials). The block is omitted when
`requires_setup === false`.

### Dedupe: Workspace-Scoped Singleton

The `request_workspace_setup` handler uses a get-or-create pattern keyed by
`(workspaceId, kind='workspace-setup')`. A KV index entry serves as the
singleflight token. Concurrent callers (multiple sessions, activity-page polls)
all converge on one elicitation id. The first emitting session is recorded as
the elicitation's `sessionId`; later sessions just subscribe.

### Auto-Resolution Paths

Three paths converge on a single helper `resolvePendingSetupElicitations(
workspaceId, sentinel)` that marks any pending workspace-setup elicitation
`answered` and publishes on the stream:

1. The elicitation's own answer handler runs the YAML write, then calls the
   helper. (Default chat-driven path.)
2. `POST /:workspaceId/setup` calls the helper after its existing work. (User
   filled `/setup` directly while a pending elicitation existed.)
3. The config-change reload handler in `packages/workspace/src/manager.ts`
   calls the helper when re-derivation finds the config-side requirements
   empty. (User direct-edited YAML.)

Workspace deletion calls a sibling helper to mark all pending elicitations
`declined` with `{ workspaceDeleted: true }`.

### Answer Handler

A new HTTP route handler dispatches on the elicitation's `kind`. For
`workspace-setup`:

1. Validate each `workspaceConfigValues[key]` against the entry's `schema`
   when present, via `z.fromJSONSchema(schema).parse(value)`.
2. Compose one `applyMutation` call that walks
   `draft.workspace_config[key].value` for each provided key, using the
   existing `setWorkspaceConfigValues` mutation.
3. Synchronously call `restartSignalsForWorkspace`.
4. Mark the elicitation `answered` and publish on the stream.

This is the config-only slice of today's `POST /:workspaceId/setup`. No
`updateCredential` calls. No `credentialChoices` plumbing.

### Form Renderer

Lift the existing `/setup` page's per-requirement components into a shared
directory:

- `<ConfigRequirementInput>`: text input, label from key, helper text from
  `description`, blur-time validation against `schema` if present.
- `<SetupSubmitButton>`: disabled until every requirement has a non-empty value
  in local form state.

The elicitation detail panel composes these two. The `/setup` page composes
these two plus the credential picker, OAuth jump-out, pinning override, and
edit-mode prefill. No parallel implementation; one component tree, two
callers.

JSON-schema rendering ships text input regardless of declared `type` for v1,
matching the original interstitial design's choice. Validation uses the
declared schema; widget dispatch on `type` is future work.

### Surfacing in Chat

The elicitation appears in two surfaces:

1. **Activity panel detail view** at `tools/agent-playground/src/routes/
   activity/(components)/activity-view.svelte`. The kind-switch gains a
   `workspace-setup` branch that renders the form.
2. **Inline in chat**, the same way `request_tool_access` surfaces its
   allow/deny prompt today. The exact integration point is whatever pattern
   that tool already uses; the new branch reuses it. To be confirmed during
   implementation.

### Gate Changes

Three surgical edits.

1. **Layout denylist** at `tools/agent-playground/src/routes/platform/
   [workspaceId]/+layout.ts`: drop `'chat'` from `OPERATIONAL_SEGMENTS`. Other
   operational segments still redirect to `/setup` while
   `requires_setup === true`.
2. **Runtime chat gate** at `apps/atlasd/src/atlas-daemon.ts`
   `getOrCreateWorkspaceRuntime`: remove the chat short-circuit added in the
   prior interstitial work. Chat sessions spin up runtimes regardless of
   `requires_setup`.
3. **Cascade gate at `triggerWorkspaceSignal`**: unchanged. Cron, fs-watch,
   HTTP, Slack, Telegram, WhatsApp, Discord, Teams, system signals all still
   short-circuit cleanly without creating sessions when
   `requires_setup === true`.

### Module Boundaries

- **`request_workspace_setup` tool factory** (new module).
  - Interface: `({ reason?: string }) => Promise<{ status: 'completed' |
    'declined' }>`.
  - Hides: get-or-create dedupe via KV index, stream subscription, answer
    polling, the fact that an elicitation may be a fresh create or an attach
    to an existing pending one.
  - Trust contract: the agent can call this tool at any point; it returns when
    the user has resolved the workspace's setup status, regardless of whether
    this call created the elicitation or attached to a sibling.

- **Elicitation answer dispatcher** (extension of the existing
  `/api/elicitations/:id/answer` route).
  - Interface: `(id, body) => Promise<{ ok: true }>`. `body` is a discriminated
    union over kinds.
  - Hides: per-kind validation logic, per-kind side effects, the YAML mutation
    pipeline, the stream publish.
  - Trust contract: the caller can submit any valid kind-shaped payload; the
    handler validates, applies side effects, and resolves the elicitation
    atomically.

- **`resolvePendingSetupElicitations(workspaceId, sentinel)` helper** (new).
  - Interface: `(workspaceId, sentinel) => Promise<void>`.
  - Hides: KV index lookup, stream publishing, idempotency under the case
    where there is no pending elicitation.
  - Trust contract: callers (`/setup` route handler, config-change reload
    handler, workspace-delete handler, the answer handler itself) can call
    this without checking pre-state. It is a no-op if nothing is pending.

- **Shared `setup-form/` components** (extracted from the existing `/setup`
  page).
  - Interface: `<ConfigRequirementInput>` props
    `{ requirement: ConfigRequirement; value; onChange; error? }`.
  - Hides: schema-driven validation timing, error rendering, helper-text
    layout.
  - Trust contract: a consumer can drop the component into any container and
    get the same input experience as `/setup`.

### Data Isolation

No new user-scoped tables. No RLS policy changes. The new elicitation kind
shares the existing elicitation storage, which is already workspace-scoped
through the existing access rules. Setup state stays derived from the parsed
YAML. Values still live in `workspace.yml`.

## Testing Decisions

Good tests cover external behavior. Implementation details (specific KV keys,
stream subjects, internal helper names) are not the contract; do not assert on
them directly when an outcome assertion will do.

1. **Schema: discriminated answer envelope**
   - `workspace-setup` answer with valid `workspaceConfigValues` parses.
   - `workspace-setup` answer with `credentialChoices` is rejected.
   - Existing `tool-allowlist` answer shape continues to parse unchanged.

2. **Schema: `workspace-setup` request payload**
   - Request carries `configKeys` mirroring the existing `SetupRequirements`
     `configKeys` shape.
   - Request omits the credentials block.

3. **Tool: `request_workspace_setup` get-or-create**
   - First call on a workspace with no pending setup elicitation creates one.
   - Second call (same or different session) returns the same id.
   - After answer, a fresh call (if `requires_setup` somehow flipped back to
     true) creates a new elicitation.

4. **Tool: await semantics**
   - Tool resolves with `'completed'` when the elicitation flips to `answered`.
   - Tool resolves with `'declined'` when the elicitation flips to `declined`.
   - Tool does not resolve while elicitation stays `pending`.

5. **Answer handler: `workspace-setup`**
   - Writes provided `workspaceConfigValues` as
     `workspace_config[key].value` via one `applyMutation` call.
   - Validates each value against the entry's `schema` when present.
   - Surfaces validation errors per-field without writing YAML.
   - Synchronously calls `restartSignalsForWorkspace`.
   - Marks the elicitation `answered` and publishes on the stream.
   - Comments and structure of the YAML are preserved across the write
     (covered by `applyMutation`'s existing test coverage; smoke-test only).

6. **Auto-resolution: `/setup` page submission**
   - Submitting `/setup` while a pending workspace-setup elicitation exists
     marks it `answered` with the external-resolution sentinel.
   - The agent's awaiting tool resolves with `'completed'`.

7. **Auto-resolution: YAML drift**
   - Direct-editing `workspace.yml` to fill all config keys, then triggering
     the file watcher reload, marks any pending workspace-setup elicitation
     `answered`.
   - Editing only some config keys does not auto-resolve.

8. **Auto-resolution: workspace deletion**
   - Deleting a workspace with a pending workspace-setup elicitation marks
     it `declined` with the deletion sentinel.

9. **Gate: chat unblock**
   - Workspace with `requires_setup === true` allows navigation to
     `/platform/<wsId>/chat`.
   - Workspace with `requires_setup === true` allows
     `getOrCreateWorkspaceRuntime` to spin up a chat runtime.
   - Other operational segments still redirect to `/setup`.

10. **Gate: non-chat short-circuit unchanged**
    - Cron-triggered signal on a setup-required workspace returns
      `{ skipped: true, reason: 'setup_required' }` without creating a
      session.
    - Inbound HTTP / Slack / Telegram signals short-circuit identically.

11. **System prompt: setup-status block**
    - When `requires_setup === true`, the workspace-chat agent's system prompt
      contains the setup-status block listing unfilled config keys and missing
      credentials.
    - When `requires_setup === false`, the block is absent.

12. **Form rendering: shared components**
    - `<ConfigRequirementInput>` rendered in the `/setup` page and rendered in
      the elicitation detail produce visually-equivalent output for the same
      requirement.
    - JSON-schema validation errors surface identically across both surfaces.

13. **Integration: import → chat → elicit → fill → run**
    - User imports an example workspace with one config key and one
      missing credential.
    - User opens chat. Workspace-chat agent's prompt has the setup-status
      block.
    - User asks for something requiring runtime. Agent calls
      `request_workspace_setup`, then `connect_service('<provider>')`.
    - User fills config in the inline form, completes OAuth in the popup.
    - Setup completes (both gaps cleared). Agent retries the original
      request.

Prior art for these tests: existing elicitation tests for `tool-allowlist`
(stream-await pattern, KV-state-flip behavior); existing setup-completion
tests in the `apps/atlasd/routes/workspaces` test directory (applyMutation
write semantics, schema validation paths).

## Out of Scope

- Modeling credentials as an elicitation kind. Credentials remain handled by
  the existing `connect_service` tool.
- A workspace-scoped variant of the elicitation schema (no `sessionId`).
  Dedupe is achieved via a KV index on `(workspaceId, kind)`; the elicitation
  itself keeps the existing session-bound shape.
- Replacing the derived `requires_setup` flag with a JetStream-native canonical
  state. Derivation stays as the source of truth.
- Removing the `/setup` page or its endpoint. Both stay as the advanced editor
  (credentials, pinning override, edit mode).
- Cron / fs-watch / inbound-signal-driven elicitation creation. These surfaces
  still skip silently when `requires_setup === true`. Surfacing setup
  proactively for non-chat workspaces is future work.
- Type-aware form widgets dispatched from `schema.type`. v1 ships text input
  for every config key.
- Multi-step setup flows or wizards. The form is one screen.
- An ADR. The decision is local enough to a feature design that this PRD
  captures the trade-offs sufficiently. Create one only if implementation
  surfaces a broader split in how human-in-the-loop primitives apply across
  the codebase.

## Further Notes

- The original interstitial design (`docs/plans/
  2026-04-29-workspace-setup-interstitial-design.md`) remains the canonical
  reference for the derivation algorithm, the `workspace_config` block schema,
  the `applyMutation` write path, and the gate behavior for non-chat surfaces.
  This document layers on top.
- The exact integration seam for inline-in-chat elicitation rendering follows
  whatever pattern `request_tool_access` already uses today. That seam is
  load-bearing for the user experience but not for the schema; it is a
  matter of UI plumbing.
- `request_workspace_setup` and the system-prompt setup-status block are the
  two changes most likely to need iteration after first user testing. The
  agent's judgment about *when* to call the tool depends on prompt wording;
  expect to tune.
- The elicitation kind name `workspace-setup` is preferred over alternatives
  like `workspace-config-input` because "setup" is the existing user-facing
  vocabulary across the product. The fact that this kind is config-only
  (credentials handled separately) is an internal detail.
