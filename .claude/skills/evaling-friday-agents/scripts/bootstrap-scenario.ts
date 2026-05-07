#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Bootstrap a new Friday eval scenario.
 *
 * Generates a daemon-spawning scenario function stub printed to stdout and
 * appends a matching test case to tools/qa/live-daemon/promptfoo/tests.yaml.
 *
 * Usage:
 *   deno run --allow-read --allow-write \
 *     .claude/skills/evaling-friday-agents/scripts/bootstrap-scenario.ts \
 *     --id my-scenario --description "tests X behavior"
 *
 * Next steps after running:
 *   1. Paste the printed function into tools/qa/live-daemon/scenarios/first-principles.ts
 *   2. Wire it into main()'s scenarios list
 *   3. cd tools/qa/live-daemon/promptfoo && npx promptfoo eval \
 *        --filter-pattern <id> --no-cache
 *
 * For hermetic prompt-only iteration without a daemon, use tools/evals/ —
 * this skill is for daemon-spawning promptfoo scenarios.
 */

interface Args {
  id: string;
  description: string;
}

function parseArgs(): Args {
  const args: Partial<Args> = {};
  const argv = Deno.args.slice();

  while (argv.length) {
    const flag = argv.shift();
    const value = argv.shift();
    if (!flag || value === undefined) {
      throw new Error(`Malformed flag near "${flag}"`);
    }
    switch (flag) {
      case "--id":
        args.id = value;
        break;
      case "--description":
        args.description = value;
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }

  if (!args.id || !args.description) {
    throw new Error(`Required: --id <kebab-case-id> --description "..."`);
  }

  if (!/^[a-z0-9-]+$/.test(args.id)) {
    throw new Error(
      `--id must be kebab-case (lowercase, digits, hyphens). Got: ${args.id}`,
    );
  }

  return args as Args;
}

function toCamelCase(kebab: string): string {
  return kebab.replace(/-(.)/g, (_, c) => c.toUpperCase());
}

function toPascalCase(kebab: string): string {
  const camel = toCamelCase(kebab);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

function generateStub(args: Args): string {
  const fnName = `run${toPascalCase(args.id)}Scenario`;
  return `// ${args.description}
// Cost: ~$0.05 of LLM calls, ~10s wall time
export async function ${fnName}(d: DaemonHandle): Promise<EvalResult[]> {
  const startedAt = Date.now();

  // TODO: point at the right fixture
  const FIXTURE_DIR = "tools/qa/fixtures/TODO";
  const ws = await registerWorkspace(d, FIXTURE_DIR, {
    name: "${args.id}-eval",
    description: "${args.description.replace(/"/g, '\\"')}",
  });

  const result = await triggerSignalSSE(d, ws.id, "TODO-signal-id", {
    payload: { /* TODO: signal payload */ },
    timeoutMs: 4 * 60 * 1000,
  });

  if (!result.sessionId) {
    return [{
      id: "${args.id}",
      pass: false,
      notes: ["no sessionId — signal trigger failed", result.jobError?.error ?? ""],
      metrics: { wallTimeMs: Date.now() - startedAt, workspaceId: ws.id },
    }];
  }

  const events = await fetchSessionEvents(d, result.sessionId);

  // TODO: replace with your assertion logic. Common patterns:
  //   - sentinel marker: parseJsonResponsePayload + expectMarker
  //   - compact shape: expectCompactShape(result.jobComplete)
  //   - tool calls: expectToolCalls(events, "tool_name", { count: 1 })
  //   - daemon log: countLogMatches(d, "expected log line")
  //   - artifacts: listArtifactsForSession(d, ws.id, result.sessionId)
  const pass = events.stepCompletes.length > 0;

  return [{
    id: "${args.id}",
    pass,
    notes: [
      \`workspace: \${ws.id}\`,
      \`session: \${result.sessionId}\`,
      \`step:complete count: \${events.stepCompletes.length}\`,
      pass ? "ok" : "FAIL: TODO describe failure",
    ],
    metrics: {
      wallTimeMs: Date.now() - startedAt,
      sessionId: result.sessionId,
      workspaceId: ws.id,
      toolCalls: events.toolCalls.map(tc => tc.toolName),
      usage: events.totalUsage,
    },
  }];
}

// In main(): add to scenarios array (passes daemon handle)
//   { id: "${args.id}", run: () => ${fnName}(daemon) },
`;
}

async function appendTestEntry(args: Args): Promise<string> {
  const testsPath = "tools/qa/live-daemon/promptfoo/tests.yaml";
  const existing = await Deno.readTextFile(testsPath);
  const trimmed = existing.endsWith("\n") ? existing : existing + "\n";
  const block = `\n- description: ${args.description}\n  vars:\n    scenarioId: ${args.id}\n`;

  if (existing.includes(`scenarioId: ${args.id}`)) {
    return `(skipped — ${testsPath} already references scenarioId: ${args.id})`;
  }

  await Deno.writeTextFile(testsPath, trimmed + block);
  return `appended to ${testsPath}`;
}

async function main() {
  let args: Args;
  try {
    args = parseArgs();
  } catch (err) {
    console.error(`error: ${(err as Error).message}\n`);
    console.error(
      `usage:\n  deno run --allow-read --allow-write \\\n` +
        `    .claude/skills/evaling-friday-agents/scripts/bootstrap-scenario.ts \\\n` +
        `    --id my-scenario --description "..."`,
    );
    Deno.exit(1);
  }

  const stub = generateStub(args);
  const yamlStatus = await appendTestEntry(args);

  console.log("─── scenario stub ───────────────────────────────────");
  console.log(stub);
  console.log("─── tests.yaml ──────────────────────────────────────");
  console.log(yamlStatus);
  console.log("\n─── next steps ──────────────────────────────────────");
  console.log(`1. Paste the stub above into:`);
  console.log(`     tools/qa/live-daemon/scenarios/first-principles.ts`);
  console.log(`2. Wire it into main()'s scenarios array (see comment in stub)`);
  console.log(`3. Iterate:`);
  console.log(
    `     cd tools/qa/live-daemon/promptfoo && \\\n       npx promptfoo eval --filter-pattern ${args.id} --no-cache`,
  );
}

if (import.meta.main) {
  await main();
}
