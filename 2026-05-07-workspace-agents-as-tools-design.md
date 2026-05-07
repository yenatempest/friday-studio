# Workspace Agents as First-Class Chat Tools

## Problem Statement

When I author a workspace and declare an agent like `meal-planner` with its own
prompt, memory access, and domain knowledge, I expect to chat with it from the
workspace's chat surface. Today that doesn't work. Workspace-declared agents
are only reachable via FSM `entry: { type: agent, agentId: ... }` actions
inside a job — chat itself has no way to invoke them. The validator
(`unreachable_agent`) correctly enforces this contract by rejecting any
declared agent not referenced from a job, which means I can't even import
workspaces that were exported from Friday and feel structurally valid to me.

The mental model gap is: I think of `agents:` as "things chat can talk to,"
but the platform treats `agents:` as "things FSM jobs can invoke." Both the
runtime and the validator hold up that latter contract. The right fix is to
make the platform conform to the natural mental model — agents declared in a
workspace become first-class tools the chat agent can call directly.

## Solution

Each agent declared in `workspace.agents` is auto-exposed to the workspace's
chat agent as a tool named `ws_agent_<id>`, mirroring how bundled atlas
agents already register as `agent_<id>` today. The chat agent (and any child
agent spawned by `delegate`, since delegate inherits parent tools) can invoke
workspace agents directly. `list_capabilities` advertises them so the LLM
knows they exist and what they're for. The `unreachable_agent` validator rule
is dropped — any declared agent is now reachable.

To make this work cleanly, the runtime's `executeAgent` method (currently
FSM-coupled) is split into a thin FSM wrapper plus a deeper FSM-free
primitive `runWorkspaceAgent`. Both the FSM action handler and the new chat
tool wrapper sit on top of the primitive.

End-to-end for the meal-planner case: import succeeds, workspace-chat boots
with `ws_agent_meal-planner`, `ws_agent_list-compiler`, `ws_agent_grocery-emailer`,
`ws_agent_cycle-advancer` in its tool set. When the user asks meal-planning
questions, the LLM picks `ws_agent_meal-planner` and runs it with the
agent's declared system prompt + the user's message.

## User Stories

1. As a workspace author, I want to declare an agent with a custom prompt and
   tools, so that the chat agent can route domain-specific user questions to
   it without me having to wrap it in a job.
2. As a workspace author, I want to import a workspace.yml that declares an
   agent without a wrapping job, so that workspaces exported from Friday can
   round-trip through import without spurious validation errors.
3. As a workspace author, I want my workspace agents listed in
   `list_capabilities` output, so that the chat LLM knows they exist and can
   reason about when to use them.
4. As a workspace author, I want my agent's `description` to be the tool's
   description visible to the LLM, so that I can author tool selection
   guidance in one place.
5. As a workspace author, I want my agent's declared `tools:` (e.g.,
   `google-gmail/send_gmail_message`, `memory_save`) to be available when
   chat invokes the agent, so that the agent has the same capabilities chat
   would give it through a job.
6. As a workspace author, I want my agent's declared system prompt to be
   used when chat invokes it, so that domain instructions aren't lost when
   moving from FSM-driven to chat-driven invocation.
7. As a workspace author, when my workspace agent has the same name as a
   bundled atlas agent (e.g., I declare `web`), I want both to remain
   accessible without collision, so that I don't accidentally shadow
   platform agents.
8. As a chat user, when I ask the chat agent something domain-specific, I
   want it to delegate to the appropriate workspace agent, so that I get the
   benefit of the specialized prompt and tools without manual orchestration.
9. As a chat user, when a workspace agent runs as a sub-step of my chat, I
   want to see its progress (intermediate output, tool calls) the same way
   delegate spawn boxes show today, so that I can follow what's happening.
10. As a chat user, when I cancel an in-flight chat, I want any running
    workspace agent invocation to abort cleanly, so that I don't leave LLM
    work running in the background.
11. As a child agent spawned by `delegate`, I want to inherit access to
    workspace agents from my parent, so that delegated work can compose
    workspace agents the same way my parent could.
12. As a workspace author, when my agent's required credentials are missing,
    I want `list_capabilities` to surface that via `requiresConfig`, so
    that the LLM can reason about whether the agent is currently usable.
13. As a workspace author, I want missing credentials to fail at call time
    with a clear error rather than silently gate the tool out at boot, so
    that workspace_config + setup flows that resolve credentials lazily
    still work.
14. As an FSM author writing a job that invokes an agent, I want the
    existing `entry: { type: agent, agentId: ... }` action to keep working
    unchanged, so that this change doesn't force me to rewrite jobs.
15. As an agent SDK consumer, I want `runtime.executeAgent` to keep its
    public-facing behavior for FSM callers, so that internal refactoring
    doesn't leak through.
16. As a workspace agent of `type: atlas` referencing a bundled agent, I
    want my workspace-declared overrides (prompt, config) to be honored
    when chat invokes me, so that the workspace's customization isn't lost.
17. As a maintainer, I want `runWorkspaceAgent` to be a single primitive
    both FSM and chat invocation paths use, so that future changes to
    agent execution (e.g., new bootstrap blocks, new validation hooks)
    only need to be made in one place.
18. As a maintainer, I want the `unreachable_agent` validator rule
    deleted (not warned, not flagged), so that the validator's contract
    matches the runtime's actual reachability semantics.

## Implementation Decisions

### Modules built or modified

**New: `packages/workspace/src/run-workspace-agent.ts`**
The FSM-free agent execution primitive. Accepts an agentId, a fully composed
prompt, and a session context (sessionId, workspaceId, streamId, datetime,
foregroundWorkspaceIds, abortSignal, onStreamEvent). Internally:
- Looks up the agent config from the workspace
- Resolves the runtime agent ID (via existing `resolveRuntimeAgentId`)
- Applies standing orders + memory bootstrap blocks (today's behavior)
- Sets up memory mounts scoped to the agent
- Wraps the call in the existing `agent.execute` otel span
- Dispatches to `orchestrator.executeAgent` (llm/atlas/system) or
  `executeCodeAgent` (user)
- Runs `validateAgentOutput`
- Cleans up mount context

Optional inputs that the FSM caller passes through (chat caller leaves
defaulted): `additionalDocuments`, `prepareConfig`, `outputSchema`, `jobName`.

**Modified: `packages/workspace/src/runtime.ts`**
The existing `executeAgent` method becomes a thin FSM-shaped wrapper. It:
- Builds the FSM-flavored prompt via `buildAgentPrompt(fsmContext, signal,
  ...)` and `composeAgentPrompt(action, agentConfig, fsmContext.input,
  context)`
- Pulls `prepareConfig` from `fsmContext.input?.config`
- Pulls `documents` from `fsmContext.documents`
- Calls `runWorkspaceAgent(...)` with the composed prompt and the FSM-only
  optional inputs populated
- Populates the side channel for FSM event consumers from the result
- Returns the result

**New: `packages/system/agents/workspace-chat/tools/workspace-agent-tools.ts`**
Sibling to `bundled-agent-tools.ts`. Iterates `wsConfig.agents` and produces
a tool record. Each agent → tool named `ws_agent_<id>`. Tool input schema:
the agent's declared `inputSchema` if present (future-proofed against
adding the field to `LLMAgentConfigSchema`), otherwise the existing
`{ prompt: string }` fallback. Tool execute() composes a minimal prompt
(agent's system prompt + user-supplied prompt + any standing context the
primitive needs) and calls `runWorkspaceAgent`. Stream events forwarded
through a proxy writer matching the delegate pattern.

**Modified: `packages/system/agents/workspace-chat/workspace-chat.agent.ts`**
The composed tool set now includes workspace agent tools alongside bundled
agent tools. The change is mechanical: import the new factory, call it with
`wsConfig`, spread the result into the tool composition.

**Modified: `packages/system/agents/workspace-chat/tools/list-capabilities.ts`**
Adds a fourth `kind: "workspace_agent"` builder. Iterates `wsConfig.agents`,
emits one `Capability` entry per agent. Sorted alphabetically within the
kind. Fields: `kind`, `id`, `description`, `type` (llm/atlas/user/system),
`requiresConfig` (computed from agent's declared tools and the workspace's
credential resolution state). The tool's description string is updated to
mention workspace agents as a category.

**Modified: `packages/core/src/mcp-registry/config-validator.ts`**
The `unreachable_agent` rule (lines 264-279) is deleted. The supporting
`referencedAgentIds` accumulator is deleted if no other rule consumes it
(verify via grep before removing). Sibling rules (`unknown_agent_id`,
`unknown_signal_name`, `unknown_memory_store`, etc.) stay — they're
referential integrity, not reachability.

### Module Boundaries

**`runWorkspaceAgent` (the primitive)**
- **Interface:** `(agentId, prompt, sessionContext, optionalFSMInputs?) => Promise<AgentResult>`
- **Hides:** Workspace config lookup, runtime agent ID resolution, standing
  orders bootstrap, memory bootstrap, memory mount setup and cleanup, otel
  span wiring, llm-vs-atlas-vs-user dispatch, output validation. The exact
  set of "things every agent invocation must do" lives in this one place.
- **Trust contract:** Caller has a validated agentId and a composed prompt.
  The primitive will dispatch through whichever execution path the agent's
  type requires, surface a structured result, and clean up after itself.
  Caller does not need to know the agent's type to call it.

**`runtime.executeAgent` (FSM wrapper)**
- **Interface:** Unchanged: `(action, fsmContext, job, signal, options?) => Promise<AgentResult>`.
- **Hides:** FSM-shaped prompt composition (document interpolation,
  `inputFrom`/`outputTo` semantics, action.prompt concatenation), prepare
  function config merging, FSM side-channel population for event
  consumers.
- **Trust contract:** FSM callers can keep calling this method exactly as
  they do today. Behavior is preserved.

**`createWorkspaceAgentTool` (chat-side wrapper)**
- **Interface:** `(agentId, agentConfig, deps) => AISDKTool`.
- **Hides:** Tool input schema derivation (from optional inputSchema or
  prompt fallback), prompt composition for chat-driven invocation, stream
  event proxying to the parent writer, error shaping for the LLM.
- **Trust contract:** Tool registration is idempotent; calling the tool
  with valid input either returns the agent's result or returns a
  structured error the LLM can reason about. Missing credentials surface
  as a runtime error, not a registration failure.

**`list_capabilities`**
- **Interface:** Unchanged input/output discriminated-union shape; gains
  one new `kind`. Existing consumers reading bundled/mcp_enabled/
  mcp_available continue to work.
- **Hides:** How each capability category is gathered (already true today
  for bundled and MCP).
- **Trust contract:** The output is a complete enumeration of what's
  callable from chat in this workspace, sorted by precedence within
  category.

### Naming and dispatch

- Workspace agent tools use the prefix `ws_agent_<id>`.
- Bundled atlas agent tools keep `agent_<id>`.
- These prefixes are distinct, so name collisions between workspace
  agents and bundled agents are impossible.
- A workspace agent of `type: atlas` referencing a bundled agent (e.g.,
  `web`) still gets its own `ws_agent_<id>` tool. The workspace tool
  honors any prompt/config overrides from the workspace config; the
  unmodified bundled `agent_web` remains available.

### Streaming and abort

- Tool wrapper passes a proxy `onStreamEvent` into `runWorkspaceAgent`'s
  sessionContext. The proxy wraps stream chunks in the same envelope
  pattern delegate uses today (`data-delegate-chunk` or a parallel
  `data-ws-agent-chunk` envelope, TBD during implementation).
- Abort signal flows from the parent chat session's `signal._context.
  abortSignal` into the tool wrapper's invocation, then into
  `runWorkspaceAgent`. Cancelling the chat aborts in-flight workspace
  agent invocations cleanly.

### Validator change

- Drop `unreachable_agent` and any test cases that depended on it being
  raised.
- Sibling `unknown_agent_id` checks (FSM action references a nonexistent
  agentId) stay — they catch typos.

### Reachability semantics (post-change)

- An agent declared in `workspace.agents` is reachable if and only if it
  is declared. There is no second-order check.
- Chat reaches it via `ws_agent_<id>` (or via delegate, which inherits
  the tool).
- FSM jobs reach it via `entry: { type: agent, agentId: ... }` actions
  (unchanged).

## Testing Decisions

A good test verifies external behavior, not the shape of internals.
Refactoring `executeAgent` is a high-risk change to hot path code, so the
tests should anchor on observable behavior: what gets passed to the
orchestrator, what comes back, what the chat tool surface looks like.

### Modules tested

**`runWorkspaceAgent`** — direct unit tests with a mock orchestrator.
Verify: agent config lookup pulls the right entry, runtime agent ID
resolves correctly per type (llm/atlas/system/user), the orchestrator
receives the composed prompt and merged config, output validation runs,
mount context is set up and cleaned up regardless of success/failure.

**`runtime.executeAgent` (FSM wrapper)** — existing tests
(`runtime-agent-prompt-composition.test.ts`,
`runtime-bootstrap-injection.test.ts`,
`__tests__/standing-orders-bootstrap.test.ts`,
`runtime-session-summary.test.ts`) should continue to pass. They mock
`AgentOrchestrator.executeAgent` and assert on what the FSM wrapper
ultimately calls. After the refactor, that call still happens — possibly
one layer deeper. Mock paths may need to shift; behavior assertions stay.

**`createWorkspaceAgentTool`** — unit tests verifying tool name is
`ws_agent_<id>`, description matches `agentConfig.description`, input
schema falls back to `{ prompt: string }` when no inputSchema is
declared, the tool's execute() routes into `runWorkspaceAgent` with the
right session context.

**`list_capabilities` (workspace_agent kind)** — unit tests verifying
that workspace agents appear under `kind: "workspace_agent"`, sorted
alphabetically within the kind, with `requiresConfig` populated when
the agent's declared tools require credentials the workspace can't
currently resolve.

**`config-validator`** — flip existing `unreachable_agent` test cases
from "rejects" to "accepts" the same workspace shape (e.g., a workspace
declaring an agent without a wrapping job).

**Integration** — import the meal-planner workspace fixture, assert the
workspace boots, assert `list_capabilities` includes all four agent
entries, simulate a chat turn that mentions meal planning, assert the
tool call goes to `ws_agent_meal-planner` and the orchestrator receives
the agent's declared system prompt.

### Prior art

The existing `bundled-agent-tools.ts` test pattern (if present, or its
absence is itself informative) is the closest model for the new
`workspace-agent-tools.ts` tests. Validator tests in
`config-validator.test.ts` (or its sibling spec file) are the model
for the `unreachable_agent` flip. FSM agent action tests in the
runtime test files are the model for the integration test.

## Out of Scope

- Conversational handoff / "primary chat agent" pattern (chat
  delegating its entire conversation to a workspace agent for multi-turn
  domain interaction). Distinct UX problem; pursue separately if needed.
- Adding an `inputSchema` field to `LLMAgentConfigSchema` so workspace
  authors can declare structured inputs. Future enhancement; current
  fallback to `{ prompt: string }` is sufficient for v1.
- Routing bundled atlas agents through `runWorkspaceAgent` to unify the
  agent invocation pathway end-to-end. Their existing wrapper works;
  unifying is an internal cleanup with no user-visible benefit.
- Cross-workspace agent invocation (chat operating over multiple
  foreground workspaces calling agents declared in workspaces other than
  the primary one).
- Workspace agents calling other workspace agents (recursion). The
  orchestrator-supplied tool set for workspace agents at runtime does
  not include `ws_agent_*`. If recursion is desired later, that's an
  additive change.
- UI changes to render `ws_agent_*` invocations distinctly from
  `delegate` spawn boxes. Reuses the existing chunk envelope pattern;
  visual treatment can iterate post-launch.
- Eval coverage for chat selecting the right workspace agent. Worth
  adding as a follow-up under `tools/evals/agents/workspace-chat/`,
  parallel to `bundled-agent-default.eval.ts`. Not required for the
  initial change to land.

## Further Notes

The `unreachable_agent` rule was added in the validator's initial commit
(`eb919c8`, "Initial commit") and reflects the original
chat-only-reaches-agents-via-jobs contract. That contract was a
consequence of the runtime architecture, not an authored design intent.
Once the runtime supports chat-driven invocation, the rule no longer
encodes a real constraint — keeping it would create a gap between what
the platform can do and what authors are allowed to declare.

The split of `executeAgent` into wrapper + primitive is the load-bearing
piece of this design. It's the change that converts the runtime from
"FSM dispatches to agents" into "agents are a primitive; FSM is one
caller, chat is another." Future callers (a hypothetical HTTP-driven
agent invocation endpoint, a CLI `atlas run-agent` command, etc.) would
sit on the same primitive without each duplicating the bootstrap +
mount + dispatch + validation logic.
