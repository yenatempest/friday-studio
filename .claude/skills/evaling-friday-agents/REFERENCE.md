# Reference

Deep dive on the Friday eval scaffold. Read this when you need to understand the moving parts, not just write a scenario.

## Scaffold architecture

```
┌────────────────────────────────────────────────────────────┐
│  npx promptfoo eval                                        │
│    ↓ loads tools/qa/live-daemon/promptfoo/promptfooconfig  │
│    ↓ registers file://provider.cjs as the only provider    │
│    ↓ iterates tests.yaml: 20 cases × { vars: {scenarioId} }│
└────────────────────────────────────────────────────────────┘
                           │
                           ↓
┌────────────────────────────────────────────────────────────┐
│  provider.cjs (Node CJS)                                   │
│    ↓ FIRST callApi: spawns deno once via reportOnce()      │
│    ↓ subsequent callApi: reads from in-memory cached JSON  │
│    ↓ returns { output: JSON.stringify(scenarioResult) }    │
└────────────────────────────────────────────────────────────┘
                           │
                           ↓
┌────────────────────────────────────────────────────────────┐
│  deno run scenarios/first-principles.ts --json-output PATH │
│    ↓ main(): spawn NATS, spawn daemon (random ports)       │
│    ↓ register fixtures, materialize tmpdir state           │
│    ↓ run all scenario functions sequentially               │
│    ↓ aggregate results, write JSON, exit                   │
└────────────────────────────────────────────────────────────┘
                           │
                           ↓
┌────────────────────────────────────────────────────────────┐
│  defaultTest.assert (promptfooconfig.yaml)                 │
│    ↓ is-json: ensures output is valid JSON                 │
│    ↓ javascript: throws unless result.pass === true        │
└────────────────────────────────────────────────────────────┘
```

**Critical implication:** all 20 test cases share *one* daemon spawn per `eval` invocation. Adding scenarios is cheap; running cross-model is expensive (each model = a full re-spawn).

## Scenario contract

Every scenario function returns one or more `EvalResult` rows. The runner aggregates them into a single JSON report keyed by `id`.

```typescript
interface EvalResult {
  id: string;                       // matches tests.yaml scenarioId
  pass: boolean;                    // single boolean — sub-checks fold into this
  notes: string[];                  // human-readable trail; surfaces on failure
  metrics: Record<string, unknown>; // captured even on pass — wallTimeMs, sessionId, usage, etc.
}
```

**Convention:** one scenario function may return *multiple* `EvalResult`s when checking distinct facets of a single LLM action (see `runRefsOverDataScenario` in `first-principles.ts:408-520` — 4 results for one trigger).

## Harness API surface

All in `tools/qa/live-daemon/harness.ts`. Import directly from scenarios.

### Daemon lifecycle

```typescript
spawnFridayDaemon(options?): Promise<DaemonHandle>
// → { port, baseUrl, fridayHome, natsUrl, process, stop }
// Random ports, isolated FRIDAY_HOME under /tmp, NATS JetStream enabled.
// Sets FRIDAY_LOCAL_ONLY=true, FRIDAYD_URL, FRIDAY_PORT_FRIDAY automatically.

await daemon.stop()
// SIGTERM, 8s grace for JetStream flush, SIGKILL if hung.
// Removes fridayHome unless FRIDAY_QA_KEEP_HOME=1.
```

### Workspace registration

```typescript
registerWorkspace(d, fixturePath, { name, description }): Promise<{ id: string }>
// POST /api/workspaces/add — returns workspace ID for triggering signals.

materializeFixture(srcDir, replacements): Promise<string>
// Copies workspace.yml + supporting files into a tmpdir,
// substitutes __VAR__ placeholders. Returns tmpdir path.
```

### Signal & job triggering

```typescript
triggerSignalSSE(d, workspaceId, signalId, opts): Promise<SignalTriggerResult>
// → { events, jobComplete, jobError, sessionId, durationMs }
// POST /api/signals/{signalId} with payload, consume SSE until [DONE].
// opts.timeoutMs: defaults to 4 min, override for slow jobs.
// opts.onEvent: optional per-event callback.
```

### Session inspection

```typescript
fetchSessionEvents(d, sessionId): Promise<{
  events: SSEEvent[];                    // full stream
  stepCompletes: StepCompleteData[];     // type === "step:complete" only
  stepValidations: ValidationBlock[];    // strategy: "skip" | "self" | "lite-judge"
  totalUsage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
  toolCalls: ToolCall[];                 // flattened from step:completes
  agentBlocks: AgentBlock[];             // for SessionView reducer regression
}>
```

### Artifact + state inspection

```typescript
listArtifactsForSession(d, workspaceId, sessionId): Promise<Artifact[]>
// JetStream Object Store listing, filtered by lifecycle.boundTo.sessionId.

countLogMatches(d, pattern): Promise<number>
// Reads {fridayHome}/logs/global.log, counts substring/regex matches.
// Used for debug-log assertions (scrubber lift, validator skip, injection).

natsKvGetJson(natsUrl, bucket, key): Promise<unknown>
// Shells out to `nats kv get --raw`, parses JSON.
// Used for inspecting persisted state (memory, workspace config).
```

## Assertion pattern catalog

The five categories observed across all scenarios. **Pick the lightest one that proves the claim.**

### 1. Sentinel-marker (semantic contract, deterministic)

Plant a marker string in the fixture prompt; assert exact-match in the LLM output.

```yaml
# fixture prompt
"...emit a JSON payload with marker: 'CONSUMED_EMAIL_BATCH', count: 12, firstId: 'fake-001'..."
```

```typescript
const payload = parseJsonResponsePayload(output);
const pass = payload?.marker === "CONSUMED_EMAIL_BATCH"
          && payload?.count === 12
          && payload?.firstId === "fake-001";
```

**Use when** you want deterministic semantic checks without LLM-grading. ~95% of Friday assertions are this.

### 2. Daemon log substring

Some signals only surface in debug logs (scrubber lift, validator skip, ambient injection). No wire representation.

```typescript
const liftCount = await countLogMatches(d, "Lifted tool result to artifact");
const pass = liftCount >= 1;
```

**Use when** the behavior is internal to a daemon component and not exposed via SSE/API.

### 3. Session event inspection

Walk `step:complete.toolCalls`, aggregate usage, count validations.

```typescript
const events = await fetchSessionEvents(d, sessionId);
const calledDelegate = events.toolCalls.some(tc => tc.toolName === "delegate");
const totalIn = events.totalUsage.inputTokens;
const skips = events.stepValidations.filter(v => v.strategy === "skip");
```

**Use when** asserting on tool sequence, token budgets, validation routing.

### 4. SSE payload shape

Inspect `jobComplete` directly for compact vs legacy shape.

```typescript
const compact = jobComplete?.artifactIds?.length > 0
             && typeof jobComplete?.summary === "string";
```

**Use when** verifying the wire format (Phase 2.C compact returns, chat-flip byte sizing).

### 5. Side-effect / persistent state

Read JetStream artifacts, NATS KV, or HTTP endpoints to verify mutations.

```typescript
const artifacts = await listArtifactsForSession(d, ws.id, sessionId);
const memoryNotes = await fetch(`${d.baseUrl}/api/memory/${ws.id}/narrative/notes`);
const kvDoc = await natsKvGetJson(d.natsUrl, "workspaces", ws.id);
```

**Use when** the assertion is about durable state (artifacts, memory, workspace config, elicitations).

## Workspace fixture conventions

- **Location:** `tools/qa/fixtures/<name>/workspace.yml` — one directory per fixture.
- **Templating:** Use `__STUB_MCP_PATH__`, `__FAKE_INBOX_MCP_PATH__`, `__FRIDAY_HOME__` placeholders. The harness substitutes via `materializeFixture` before daemon registration.
- **Stub MCPs:** `tools/qa/fixtures/stub-mcp/*.ts` — Deno scripts implementing MCP protocol with deterministic synthetic data. Use these instead of real services in evals.
- **Sentinel data:** corpus emails contain predictable markers (`fake-001`, `FIRST_PRINCIPLES_EMAIL_BODY`). Add new markers when you need new semantic checks.
- **Temperature:** set `temperature: 0` on the agent in `workspace.yml` for deterministic evals (see `first-principles-refs/workspace.yml:190`).

## Promptfoo config surface

### `defaultTest.assert`

Currently every test runs the same two asserts:
1. `is-json` — output must be valid JSON (the scenario result row)
2. `javascript` — throws unless `result.pass === true`

To add LLM-rubric overlays for prose-grading scenarios, add a per-test assert in `tests.yaml`:

```yaml
- description: workspace-chat tone
  vars: { scenarioId: chat-tone-grading }
  assert:
    - type: llm-rubric
      provider: anthropic:messages:claude-sonnet-4-6
      value: "Response is concise (<200 words), professional, no apologies"
      threshold: 0.7
```

**Caveat:** the `output` for that test is the JSON-stringified `EvalResult`. To grade prose, your scenario must surface the LLM text in `metrics.responseText` (or similar) and the rubric must reference `JSON.parse(output).metrics.responseText`. See [EXAMPLES.md](EXAMPLES.md) for the pattern.

### CLI flags worth knowing

| Flag                          | When to use                                              |
|-------------------------------|----------------------------------------------------------|
| `--filter-pattern <regex>`    | Iterate on one scenario; matches `description`           |
| `--no-cache`                  | After editing prompt or scenario — cache hides changes   |
| `--repeat <n>`                | Stress-test for nondeterminism (don't run on full suite) |
| `--max-concurrency <n>`       | Override; daemon scenarios are serial inside one report  |
| `--output <path>`             | Write JSON/HTML to a known path for diffing              |
| `--grader <provider>`         | Override LLM grader for `llm-rubric` assertions          |

### Env vars

| Var                                  | Effect                                                      |
|--------------------------------------|-------------------------------------------------------------|
| `ANTHROPIC_API_KEY`                  | Required — propagated to daemon via env passthrough         |
| `FIRST_PRINCIPLES_PROMPTFOO_REPORT`  | Skip Deno spawn, read this JSON instead. Useful for re-grading without re-running. |
| `FRIDAY_QA_KEEP_HOME=1`              | Preserve `{tmpDir}` for log spelunking after a failure      |
| `FRIDAY_QA_DUMP_EVENTS=1`            | Dump session events JSON alongside results                  |
| `FRIDAY_SWEEPER_INTERVAL_MS=1000`    | Already set by harness; don't override unless extending Phase 6-style temporal scenarios |

## Cost + timing conventions

- **Header annotations:** scenario files start with a comment `// Cost: ~$0.30 of LLM calls, ~3 min wall time`. Update when you add scenarios.
- **Sentinel-driven cheapness:** because asserts are exact-match, single runs are sufficient. No `--repeat 5` to average out variance.
- **Token telemetry:** `step:complete.usage` rolls up into `totalUsage` per session. Surface in `metrics.usage` so regression tracking can alert on token spikes.
- **Wall-time budget:** scenarios use `timeoutMs: 4*60*1000` by default; bump to 8–15 min for chat / auto-triage flows.

## Cross-model overlays

Cross-model evaluation runs as separate `eval` invocations per model. The shim forwards `process.env` to the Deno spawn unchanged, so `FRIDAY_EVAL_MODEL` (or any other env var) you set propagates through. Scenarios read the env and template the model into the fixture or LLM call:

```typescript
const MODEL = Deno.env.get("FRIDAY_EVAL_MODEL") ?? "anthropic:claude-sonnet-4-6";
```

Run separately per model and diff:

```bash
FRIDAY_EVAL_MODEL=anthropic:claude-sonnet-4-6 npx promptfoo eval --output sonnet.json
FRIDAY_EVAL_MODEL=anthropic:claude-haiku-4-5 npx promptfoo eval --output haiku.json
jq -r '.results[].response.output' sonnet.json haiku.json
```

Each invocation re-spawns the full suite (~$0.30 each). The shim doesn't currently support a single-`eval` matrix — see [Future shim improvements](#future-shim-improvements). For the fixture-templating pattern, see [EXAMPLES.md → Cross-model matrix overlay](EXAMPLES.md).

## Gotchas catalog

| Symptom                                          | Cause / fix                                              |
|--------------------------------------------------|----------------------------------------------------------|
| Edited `prompt.txt`, eval still passes/fails the same | Cache. Use `--no-cache`.                              |
| `runner exit=1; stderr="connection refused"`     | NATS port collision (parallel runs). Re-run; harness picks fresh ports. |
| `scenario not found in first-principles report`  | `tests.yaml` has scenarioId not in `main()`'s registry. Add the function call. |
| Hung Deno process                                | Daemon failed health check. `FRIDAY_QA_KEEP_HOME=1` and read `harness-daemon.stderr.log`. |
| `payload?.marker === "X"` fails on every model run | Model output isn't pure JSON. Pipe through `parseJsonResponsePayload` to strip code fences. |
| Cross-model results inconsistent                 | Models differ in code-fence behavior, token padding. Normalize in the scenario, not the assertion. |
| `tools/evals/` results conflict with promptfoo   | Different runners. `tools/evals/` is hermetic (no daemon); promptfoo is full integration. They test different things — both should pass. |

## Future shim improvements

Tracked as backlog; the skill teaches the current shape until these land.

1. **Multi-runner dispatch.** `provider.cjs` accepts a `runner` var from `tests.yaml` and spawns the right scenario file. Today it hardcodes `first-principles.ts`.
2. **Vars passthrough.** Forward `tests.yaml` `vars` (model, temperature, fixture overrides) as env vars to the Deno script and key the spawn cache on the var combination. Enables single-`eval` cross-model matrices.
3. **LLM output surfacing.** Scenarios capture LLM response text in `metrics.responseText` so per-test `llm-rubric` asserts can grade prose without re-running the LLM.
4. **Streaming progress.** Provider streams scenario completion to promptfoo's UI during long runs.
5. **Result diffing.** `--output baseline.json` then `--baseline baseline.json` to show only regressions.

When you make any of these changes, update REFERENCE.md and the relevant SKILL.md gotchas in the same PR.
