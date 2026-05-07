---
name: evaling-friday-agents
description: Iterate on Friday agent prompts using the daemon-spawning promptfoo scaffold at `tools/qa/live-daemon/promptfoo/`. Covers the diagnose → change → re-run → decide loop. Use when tuning a Friday agent prompt, adding or extending an eval scenario, debugging a failed eval, or comparing models across runs. Triggers on "eval this prompt", "add a promptfoo scenario", "why did the eval fail", "cross-model comparison", or any work touching `tools/qa/live-daemon/scenarios/` or `tools/qa/live-daemon/promptfoo/`.
---

# Evaling Friday Agents

Friday's promptfoo loop wraps `tools/qa/live-daemon/`. Promptfoo is the **runner + reporter**; scenarios in `tools/qa/live-daemon/scenarios/` own LLM calls, daemon orchestration, and assertions. One Deno spawn produces a JSON report; promptfoo dispatches each test case by `scenarioId`.

## Quick start

```bash
# Run the whole suite
cd tools/qa/live-daemon/promptfoo
ANTHROPIC_API_KEY=... npx promptfoo eval

# Iterate on one scenario, no cache (cache hides prompt edits)
npx promptfoo eval --filter-pattern refs-over-data --no-cache

# Reuse a prior JSON report instead of re-running the daemon
FIRST_PRINCIPLES_PROMPTFOO_REPORT=/tmp/last-report.json npx promptfoo eval

# Inspect results in the UI
npx promptfoo view
```

## The iteration loop

1. **Diagnose.** Run `--filter-pattern <id>` for the failing scenario. Read its `notes` and `metrics`. If thin, set `FRIDAY_QA_KEEP_HOME=1` (preserves `{tmpDir}/logs/global.log`, daemon stderr) or `FRIDAY_QA_DUMP_EVENTS=1` (dumps session events JSON).
2. **Hypothesize.** Walk backwards from the failing assertion to the prompt, fixture, or harness wiring responsible. Use the `debugging` skill if the trail is long.
3. **Change one thing.** Patch the prompt OR the fixture OR the assertion — not all three. Keep variables isolated.
4. **Re-run with `--no-cache`.** Confirm green, then run the full suite to catch regressions in sibling scenarios.
5. **Decide.** Accept, revert, or dig deeper. Token + latency metrics ride on every result — check those alongside pass/fail.

## Scope

This skill covers daemon-spawning promptfoo scenarios — every scenario in `tools/qa/live-daemon/scenarios/` registers a workspace, triggers a signal, and asserts on session events / artifacts / logs.

## Where things live

- **Scaffold:** `tools/qa/live-daemon/promptfoo/` — `provider.cjs`, `promptfooconfig.yaml`, `tests.yaml`
- **Scenario file (today, only one wired in):** `tools/qa/live-daemon/scenarios/first-principles.ts` — append your function here, register in `main()`, add to `tests.yaml`
- **Harness API:** `tools/qa/live-daemon/harness.ts` — `registerWorkspace`, `triggerSignalSSE`, `fetchSessionEvents`, `listArtifactsForSession`, `materializeFixture`, `countLogMatches`
- **Fixtures:** `tools/qa/fixtures/*/workspace.yml` — templated with `__VAR__` placeholders, materialized into a tmpdir per run
- **Stub MCP servers:** `tools/qa/fixtures/stub-mcp/` — `fake-inbox-server.ts`, `big-string-server.ts`. Sentinel data, no auth.

## Common gotchas

- **Cache hides prompt edits.** Always `--no-cache` after editing a `prompt.txt` or scenario.
- **Env passthrough.** `provider.cjs` forwards `process.env`; export `ANTHROPIC_API_KEY` before invoking promptfoo.
- **One report per `eval` invocation.** The shim runs the Deno script once and dispatches all 20 test cases from the cached JSON. Different runs = different reports.
- **Fixture paths must template.** Workspace YAMLs use `__STUB_MCP_PATH__`-style placeholders that get replaced with absolute tmpdir paths. Don't hardcode.
- **Sentinel-based asserts > LLM rubrics** in this codebase. Friday scenarios plant marker strings (`CONSUMED_EMAIL_BATCH`, `VALIDATION_CONTRACT_OK`) in fixture prompts and assert exact-match. Use `llm-rubric` *only* for prose-quality grading.
- **Models default to `anthropic:claude-sonnet-4-6`.** For cross-model comparison, set `FRIDAY_EVAL_MODEL` in env per `eval` invocation and have the scenario read it. See [EXAMPLES.md](EXAMPLES.md).
- **Known-failing scenarios** stay in the suite with `metrics.knownFailing = true` — don't skip; they're regression alarms.

## Bootstrap a new scenario

```bash
deno run --allow-read --allow-write \
  .claude/skills/evaling-friday-agents/scripts/bootstrap-scenario.ts \
  --id my-new-thing --description "tests X behavior"
```

Prints a function stub + appends a tests.yaml entry. Copy the stub into `first-principles.ts`, wire it into `main()`'s scenarios list, then `--filter-pattern my-new-thing --no-cache` to iterate.

## Reusable assertion helpers

`scripts/assertions.ts` (in this skill kit) exports the patterns repeated across `first-principles.ts`:
- `parseJsonResponsePayload(text)` — strips code-fence wrappers from LLM JSON output
- `byteLen(value)` — JSON-serialized byte size (for compact-shape gates)
- `expectMarker(payload, expected)` — sentinel field equality
- `expectCompactShape(jobComplete)` — Phase 2.C `{artifactIds, summary}` check
- `expectToolCalls(events, names, opts?)` — present / absent / count assertions on `step:complete.toolCalls`

Import from scenarios (relative path is awkward by design — the helpers live with the skill, not the scaffold):
```typescript
import { expectMarker, expectCompactShape } from "../../../.claude/skills/evaling-friday-agents/scripts/assertions.ts";
```

## Deeper docs

- [REFERENCE.md](REFERENCE.md) — scaffold architecture, harness API surface, assertion-pattern catalog, gotcha list, future shim improvements
- [EXAMPLES.md](EXAMPLES.md) — 6 worked examples (scenario shape, sentinel, compact-shape, tool-call, cross-model, known-failing)
