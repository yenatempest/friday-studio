/**
 * Reusable assertion helpers for Friday eval scenarios.
 *
 * Each helper returns a structured result so scenarios can compose multiple
 * checks into one EvalResult and surface diffs in `notes`. Don't throw —
 * scenarios decide how to handle individual check failures.
 *
 * Patterns extracted from `tools/qa/live-daemon/scenarios/first-principles.ts`
 * where each was duplicated 3+ times. Keep this file lean; only generalize
 * patterns proven by repetition in the suite.
 */

/**
 * Result of a single assertion check. Composable into per-scenario rollups.
 */
export interface CheckResult {
  /** Human-readable name of the check. */
  name: string;
  /** True if the check passed. */
  ok: boolean;
  /** Reason for failure (empty when ok). */
  reason?: string;
  /** Detailed diffs for marker-style checks. */
  diffs?: string[];
}

/**
 * Strip code-fence wrappers (```json ... ```) and parse JSON.
 *
 * Friday agents are prompted to emit JSON only, but real models often wrap
 * output in fences. Use this before any sentinel/marker assertion to normalize.
 *
 * Returns null when the input isn't parseable JSON after fence stripping.
 */
export function parseJsonResponsePayload(text: string): unknown {
  if (!text) return null;

  let trimmed = text.trim();

  // Strip ```json ... ``` or ``` ... ``` wrappers
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch && fenceMatch[1] !== undefined) {
    trimmed = fenceMatch[1].trim();
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Byte length of a value when JSON-serialized.
 *
 * Used for compact-return gates (Phase 2.C: `jobComplete` < 2KB) and for
 * supervisor-flip reduction calculations. UTF-8 encoded.
 */
export function byteLen(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const json = typeof value === "string" ? value : JSON.stringify(value);
  return new TextEncoder().encode(json).length;
}

/**
 * Sentinel-marker check: assert that an LLM output payload contains
 * the expected marker fields with exact-match values.
 *
 * Pattern: fixture prompt instructs the agent to emit
 *   { "marker": "CONSUMED_EMAIL_BATCH", "count": 12, "firstId": "fake-001" }
 * Scenario calls expectMarker(payload, { marker: "...", count: 12, firstId: "..." }).
 *
 * Reports per-field diffs in `diffs` for actionable failure notes.
 */
export function expectMarker(
  payload: unknown,
  expected: Record<string, unknown>,
  name = "marker-match",
): CheckResult {
  if (typeof payload !== "object" || payload === null) {
    return {
      name,
      ok: false,
      reason: "payload is not an object",
      diffs: [`expected: ${JSON.stringify(expected)}`, `got: ${JSON.stringify(payload)}`],
    };
  }

  const obj = payload as Record<string, unknown>;
  const diffs: string[] = [];

  for (const [key, want] of Object.entries(expected)) {
    const got = obj[key];
    if (!Object.is(got, want) && JSON.stringify(got) !== JSON.stringify(want)) {
      diffs.push(`${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }

  return diffs.length === 0
    ? { name, ok: true, diffs: [] }
    : { name, ok: false, reason: `${diffs.length} field(s) mismatched`, diffs };
}

/**
 * Phase 2.C compact-shape check on a `job-complete` SSE payload.
 *
 * Compact: `{ artifactIds: string[], summary: string }` (post-Phase 2.C)
 * Legacy:  `{ output: Document[] }` (pre-Phase 2.C)
 *
 * Returns the kind so scenarios can distinguish "missing both" from
 * "stuck on legacy" in their notes.
 */
export function expectCompactShape(
  jobComplete: unknown,
): CheckResult & { kind: "compact" | "legacy" | "missing" } {
  if (!jobComplete || typeof jobComplete !== "object") {
    return {
      name: "compact-shape",
      ok: false,
      reason: "jobComplete missing",
      kind: "missing",
    };
  }

  const obj = jobComplete as Record<string, unknown>;
  const hasRefs = Array.isArray(obj.artifactIds) && (obj.artifactIds as unknown[]).length > 0;
  const hasSummary = typeof obj.summary === "string";
  const hasLegacyOutput = Array.isArray(obj.output);

  if (hasRefs && hasSummary) {
    return { name: "compact-shape", ok: true, kind: "compact" };
  }

  if (hasLegacyOutput) {
    return {
      name: "compact-shape",
      ok: false,
      reason: "legacy output: Document[] shape (pre-Phase 2.C)",
      kind: "legacy",
    };
  }

  return {
    name: "compact-shape",
    ok: false,
    reason: `missing both compact and legacy shapes; keys: ${Object.keys(obj).join(", ")}`,
    kind: "missing",
  };
}

/**
 * Minimal shape of session events as returned by `harness.fetchSessionEvents`.
 * Re-declared here to avoid a hard dep on the harness module from the skill.
 */
interface ToolCallLike {
  toolName: string;
  toolCallId?: string;
  result?: unknown;
}
interface SessionEventsLike {
  toolCalls: ToolCallLike[];
}

/**
 * Tool-call presence/absence/count assertion.
 *
 * Common Friday patterns:
 *   - "agent must call delegate at least once" → expectToolCalls(events, "delegate", { min: 1 })
 *   - "agent must call mark_as_read exactly once" → expectToolCalls(events, "mark_as_read", { count: 1 })
 *   - "agent must NOT call delegate" → expectToolCalls(events, "delegate", { count: 0 })
 *   - "agent must call lookup AND send" → expectToolCalls(events, ["lookup", "send"], { all: true })
 *
 * Pass either a single tool name or an array. Behavior:
 *   - Single name + count/min/max: count occurrences of that tool
 *   - Array + all: assert each name was called at least once
 *   - Array + any: assert at least one name was called
 */
export function expectToolCalls(
  events: SessionEventsLike,
  names: string | string[],
  opts: {
    count?: number;
    min?: number;
    max?: number;
    all?: boolean;
    any?: boolean;
    name?: string;
  } = {},
): CheckResult {
  const calledNames = events.toolCalls.map(tc => tc.toolName);
  const checkName = opts.name ?? `tool-calls(${Array.isArray(names) ? names.join(",") : names})`;

  if (Array.isArray(names)) {
    if (opts.all) {
      const missing = names.filter(n => !calledNames.includes(n));
      return missing.length === 0
        ? { name: checkName, ok: true }
        : { name: checkName, ok: false, reason: `missing tools: ${missing.join(", ")}` };
    }
    if (opts.any) {
      const present = names.some(n => calledNames.includes(n));
      return present
        ? { name: checkName, ok: true }
        : {
            name: checkName,
            ok: false,
            reason: `none of ${names.join(", ")} were called; saw: ${calledNames.join(", ") || "(none)"}`,
          };
    }
    return {
      name: checkName,
      ok: false,
      reason: "array names require opts.all or opts.any",
    };
  }

  const occurrences = calledNames.filter(n => n === names).length;

  if (opts.count !== undefined) {
    return occurrences === opts.count
      ? { name: checkName, ok: true }
      : {
          name: checkName,
          ok: false,
          reason: `expected count=${opts.count}, got ${occurrences}`,
        };
  }
  if (opts.min !== undefined && occurrences < opts.min) {
    return {
      name: checkName,
      ok: false,
      reason: `expected min=${opts.min}, got ${occurrences}`,
    };
  }
  if (opts.max !== undefined && occurrences > opts.max) {
    return {
      name: checkName,
      ok: false,
      reason: `expected max=${opts.max}, got ${occurrences}`,
    };
  }

  // No threshold provided → presence check (≥1)
  return occurrences > 0
    ? { name: checkName, ok: true }
    : {
        name: checkName,
        ok: false,
        reason: `not called; saw: ${calledNames.join(", ") || "(none)"}`,
      };
}
