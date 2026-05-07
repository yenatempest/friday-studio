# Examples

Six worked examples for daemon-spawning promptfoo scenarios. Each shows the full code shape (scenario + tests.yaml entry + how to run).

For hermetic prompt-only iteration without a daemon, use `tools/evals/` (`deno task evals run`) instead — this skill is scoped to daemon scenarios.

All examples assume scenarios live in `tools/qa/live-daemon/scenarios/first-principles.ts` and are registered in its `main()`. See [SKILL.md](SKILL.md#bootstrap-a-new-scenario) for the bootstrap script that scaffolds the boilerplate.

---

## 1. Daemon scenario (full daemon spawn, signal trigger, SSE consumption)

Use when failure involves tools, retrieval, validation, or the FSM.

```typescript
// in first-principles.ts
import {
  fetchSessionEvents,
  registerWorkspace,
  triggerSignalSSE,
  type DaemonHandle,
} from "../harness.ts";

const FIXTURE_DIR = "tools/qa/fixtures/auto-triage-readonly";

export async function runReadonlyTriageScenario(d: DaemonHandle): Promise<EvalResult[]> {
  const startedAt = Date.now();
  const ws = await registerWorkspace(d, FIXTURE_DIR, {
    name: "readonly-triage-eval",
    description: "Phase 4.A — read-only fetcher → skip",
  });

  const result = await triggerSignalSSE(d, ws.id, "inbox-event", {
    payload: { source: "fixture", count: 12 },
    timeoutMs: 4 * 60 * 1000,
  });

  if (!result.sessionId) {
    return [{
      id: "readonly-triage-skip",
      pass: false,
      notes: ["no sessionId — signal trigger failed", result.jobError?.error ?? ""],
      metrics: { wallTimeMs: Date.now() - startedAt },
    }];
  }

  const events = await fetchSessionEvents(d, result.sessionId);
  const skipValidations = events.stepValidations.filter(v => v.strategy === "skip");
  const pass = skipValidations.length >= 1;

  return [{
    id: "readonly-triage-skip",
    pass,
    notes: [
      `workspace: ${ws.id}`,
      `session: ${result.sessionId}`,
      `skip validations: ${skipValidations.length}`,
      ...skipValidations.map(v => `skip reason: ${v.skipReason}`),
    ],
    metrics: {
      wallTimeMs: Date.now() - startedAt,
      sessionId: result.sessionId,
      stepCompleteCount: events.stepCompletes.length,
      usage: events.totalUsage,
    },
  }];
}
```

```yaml
- description: readonly fetcher → validation skip
  vars:
    scenarioId: readonly-triage-skip
```

---

## 2. Sentinel-marker assertion (the canonical Friday pattern)

The fixture prompt instructs the agent to emit a marker; the scenario asserts exact-match. Deterministic, no LLM grading.

**Fixture (`workspace.yml`):**
```yaml
agents:
  - id: contract-writer
    type: llm
    temperature: 0
    instructions: |
      Read the inbox via fs_glob, count unread emails, and emit a JSON payload:
      {
        "marker": "CONSUMED_EMAIL_BATCH",
        "count": <number of emails seen>,
        "firstId": "<id of first email>"
      }
      Do not include any prose, only the JSON.
```

**Scenario:**
```typescript
import { parseJsonResponsePayload, expectMarker } from "../../../.claude/skills/evaling-friday-agents/scripts/assertions.ts";

export async function runConsumeEmailBatchScenario(d: DaemonHandle): Promise<EvalResult[]> {
  // ... trigger signal as in example 2 ...

  const artifacts = await listArtifactsForSession(d, ws.id, result.sessionId!);
  const terminal = artifacts.find(a => a.outputTo === "triage-summary");
  const payload = parseJsonResponsePayload(terminal?.body ?? "");

  const markerCheck = expectMarker(payload, {
    marker: "CONSUMED_EMAIL_BATCH",
    count: 12,
    firstId: "fake-001",
  });

  return [{
    id: "consume-email-batch-marker",
    pass: markerCheck.ok,
    notes: markerCheck.ok ? ["marker matched"] : markerCheck.diffs,
    metrics: { sessionId: result.sessionId, payloadKeys: Object.keys(payload ?? {}) },
  }];
}
```

---

## 3. Compact-shape assertion (Phase 2.C, no body sentinels)

Verify the SSE `job-complete` event carries the compact `{artifactIds, summary}` shape, not the legacy `output: Document[]`.

```typescript
import { expectCompactShape, byteLen } from "../../../.claude/skills/evaling-friday-agents/scripts/assertions.ts";

export async function runCompactJobReturnScenario(d: DaemonHandle): Promise<EvalResult[]> {
  // ... trigger signal ...

  const shape = expectCompactShape(result.jobComplete);
  const totalBytes = byteLen(result.jobComplete);

  return [{
    id: "compact-job-tool-return",
    pass: shape.ok && totalBytes < 2048,
    notes: [
      `shape: ${shape.kind}`,                       // "compact" | "legacy" | "missing"
      `bytes: ${totalBytes}`,
      shape.ok ? "ok" : `FAIL: ${shape.reason}`,
      totalBytes >= 2048 ? `FAIL: bytes >= 2048` : "ok: under 2KB",
    ],
    metrics: {
      sessionId: result.sessionId,
      jobCompleteBytes: totalBytes,
      artifactIdCount: result.jobComplete?.artifactIds?.length ?? 0,
    },
  }];
}
```

---

## 4. Tool-call presence + count assertion

Used for delegate isolation, ack-only mutations, "agent must call X exactly once" scenarios.

```typescript
import { expectToolCalls } from "../../../.claude/skills/evaling-friday-agents/scripts/assertions.ts";

export async function runReviewChoiceMemoryScenario(d: DaemonHandle): Promise<EvalResult[]> {
  // ... trigger signal ...
  const events = await fetchSessionEvents(d, result.sessionId!);

  // Memory must be saved exactly once, mutation called exactly once,
  // delegate must NOT be called (no bypass).
  const memoryCheck = expectToolCalls(events, "memory_save", { count: 1 });
  const mutationCheck = expectToolCalls(events, "mark_as_read", { count: 1 });
  const noDelegate = expectToolCalls(events, "delegate", { count: 0 });

  const allChecks = [memoryCheck, mutationCheck, noDelegate];
  const pass = allChecks.every(c => c.ok);

  return [{
    id: "review-choice-memory-learning",
    pass,
    notes: allChecks.flatMap(c => c.ok ? [`✓ ${c.name}`] : [`✗ ${c.name}: ${c.reason}`]),
    metrics: {
      sessionId: result.sessionId,
      toolCalls: events.toolCalls.map(tc => tc.toolName),
    },
  }];
}
```

---

## 5. Cross-model matrix overlay

Run the same scenario against multiple models via separate `eval` invocations. Scenarios read `FRIDAY_EVAL_MODEL` from env and template it into the fixture. The shim forwards `process.env` to the Deno spawn unchanged, so any env var you set propagates through.

**1. Add a placeholder to the fixture's `workspace.yml`:**

```yaml
agents:
  - id: contract-writer
    type: llm
    model: __MODEL__   # templated at materialize time
    instructions: ...
```

**2. Thread `FRIDAY_EVAL_MODEL` through `materializeFixture`:**

```typescript
const MODEL = Deno.env.get("FRIDAY_EVAL_MODEL") ?? "anthropic:claude-sonnet-4-6";

export async function runAgentOutputContractScenario(d: DaemonHandle): Promise<EvalResult[]> {
  const fixtureDir = await materializeFixture(SRC_FIXTURE, { "__MODEL__": MODEL });
  const ws = await registerWorkspace(d, fixtureDir, {
    name: "agent-output-contract-eval",
    description: `model=${MODEL}`,
  });

  const result = await triggerSignalSSE(d, ws.id, "run-contract", { payload: {} });
  // ... assertions on result.jobComplete + session events as in example 1 ...

  return [{
    id: "agent-output-contract",
    pass: /* ... */,
    notes: [`model: ${MODEL}`, /* ... */],
    metrics: { model: MODEL, sessionId: result.sessionId, /* ... */ },
  }];
}
```

**3. Run separately per model and diff:**

```bash
cd tools/qa/live-daemon/promptfoo

FRIDAY_EVAL_MODEL=anthropic:claude-sonnet-4-6 npx promptfoo eval \
  --filter-pattern agent-output-contract --no-cache --output sonnet.json

FRIDAY_EVAL_MODEL=anthropic:claude-haiku-4-5 npx promptfoo eval \
  --filter-pattern agent-output-contract --no-cache --output haiku.json

jq -r '.results[].response.output' sonnet.json haiku.json
```

Each invocation re-spawns the full suite (~$0.30 each). `--filter-pattern` only narrows what promptfoo reports — the Deno runner still executes everything in `main()`. A single-`eval` matrix that runs all combinations cheaply is on the backlog (see [REFERENCE.md → Future shim improvements](REFERENCE.md)).

### Adding an LLM-rubric overlay (prose-quality grading)

Surface the relevant LLM text in `metrics.responseText` (extract from artifact body or a `step:complete` event), then add a per-test rubric:

```yaml
- description: agent-output — concise & professional
  vars: { scenarioId: agent-output-contract }
  assert:
    - type: javascript
      value: |
        const r = JSON.parse(output);
        if (!r.pass) throw new Error(`${r.id} hard-failed: ${(r.notes||[]).join('; ')}`);
        return true;
    - type: llm-rubric
      provider: anthropic:messages:claude-sonnet-4-6
      transform: 'JSON.parse(output).metrics.responseText'
      value: |
        Response should be concise (<200 words), professional, no apologies,
        no lecturing. Should answer the user's question directly.
      threshold: 0.7
```

The `transform` extracts the prose from the result row before grading. Don't put rubrics on `defaultTest` — they'd run against the JSON-stringified result, which doesn't grade prose.

---

## 6. Known-failing scenario (regression alarm)

When a scenario uncovers a real product bug you can't fix immediately, mark `metrics.knownFailing = true` and keep it in the suite as an alarm. Don't skip; don't comment out.

```typescript
export async function runMidSessionArtifactInjectionScenario(d: DaemonHandle): Promise<EvalResult[]> {
  // ... trigger signal ...
  const injectCount = await countLogMatches(d, "Injected artifact blocks into LLM action prompt");
  const pass = injectCount >= 1;

  return [{
    id: "ambient-artifact-injection-pruning",
    pass,
    notes: [
      `inject log lines: ${injectCount}`,
      pass ? "" : "KNOWN FAIL — pt3 finding M1 (mid-session persistence gap)",
    ].filter(Boolean),
    metrics: {
      sessionId: result.sessionId,
      knownFailing: !pass,                 // ← surfaces in report; report writer treats as expected
      knownFailingReason: pass ? null : "pt3 M1: artifacts persist at session-complete only",
    },
  }];
}
```

The `defaultTest.assert` still throws on `pass: false`. Two paths:

**Option A (cheap):** keep it in `tests.yaml`, accept the red. Treat it as a CI dashboard alarm; revisit when the bug is fixed.

**Option B (clean):** add a per-test override that allows `knownFailing: true`:

```yaml
- description: ambient artifact injection (KNOWN FAIL — pt3 M1)
  vars: { scenarioId: ambient-artifact-injection-pruning }
  assert:
    - type: javascript
      value: |
        const r = JSON.parse(output);
        if (!r.pass && r.metrics?.knownFailing) return true;  // expected red
        if (!r.pass) throw new Error(`${r.id} failed: ${(r.notes||[]).join('; ')}`);
        return true;
```

Option B is more honest — track unintended regressions separately from acknowledged gaps. When you fix the underlying bug, flip `knownFailing: false` and the per-test override turns into a no-op until you remove it.

---

## Picking which example to follow

| Goal                                                  | Start from |
|-------------------------------------------------------|------------|
| "I edited prompt.txt and want fast feedback (no daemon)" | not this skill — use `tools/evals/` |
| "I added a new tool / FSM transition and want to test it" | Example 1 (daemon scenario) |
| "Agent must say something specific or emit specific JSON" | Example 2 (sentinel) |
| "Compact return / artifact-ref refactor"              | Example 3 (compact-shape) |
| "Tool sequence / 'must call X exactly once'"          | Example 4 (tool-calls) |
| "Does Haiku do as well as Sonnet on this prompt?"     | Example 5 (cross-model) |
| "Found a real bug, can't fix today"                   | Example 6 (known-failing) |
