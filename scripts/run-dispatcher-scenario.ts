#!/usr/bin/env bun
/**
 * Dispatcher scenario harness — mt#3756, ADR-028 Phase 6.
 *
 * Runs the REAL `runDispatcher` end to end against synthetic guards, inside an
 * isolated state directory. This is the contained replacement for the
 * hand-rolled harnesses that produced mt#3756: on 2026-08-03, verifying two
 * genuine dispatcher behaviors (mt#3612's `updatedInput`, mt#3625's
 * stdout-swallowing) meant temporarily registering fixture guards into the
 * live dispatcher on the operator's real state dir. That wrote 19 records into
 * the production fire-log and, more seriously, ran an unreviewed guard named
 * `denier` — returning `deny` — against real `Bash` calls in the operator's
 * own conversation.
 *
 * ADR-028 §Harder / new costs anticipated exactly this, and made the remedy
 * contingent: "debugging a single guard in isolation requires either keeping a
 * thin dev-only CLI wrapper or invoking it through a small in-repo test
 * harness. A CLI wrapper is a cheap, explicit Phase 6 deliverable **if this
 * friction proves real in practice**." Three hand-rolled harnesses in one day
 * is that evidence.
 *
 * WHY NOT JUST A UNIT TEST. `dispatcher.test.ts` injects `recordFireLogFn` and
 * `resolveDispatchContextFn`, so it never exercises the real writer or the
 * real context resolution — which is correct for a unit test and precisely why
 * it cannot answer the questions these scenarios ask. This harness leaves
 * those defaults ALONE and isolates the STATE instead, so the code under
 * observation is the code that runs in production.
 *
 * ISOLATION. `MINSKY_STATE_DIR` and `CLAUDE_PROJECT_DIR` are repointed at a
 * fresh temp directory for the whole process, set before any dispatcher module
 * is imported — the same discipline `scripts/run-guard-canaries.ts` applies,
 * for the same reason. Consequence worth stating: the synthetic guard names
 * below never reach the real fire-log, so they do NOT need an entry in
 * `known-guard-names.ts`. A scenario name showing up in
 * `scripts/audit-fire-log.ts` output means this isolation broke.
 *
 * Usage:
 *   bun scripts/run-dispatcher-scenario.ts --list
 *   bun scripts/run-dispatcher-scenario.ts                        # run all
 *   bun scripts/run-dispatcher-scenario.ts --scenario <name>
 *   bun scripts/run-dispatcher-scenario.ts --json
 *
 * Exit code: 0 = every run scenario met its expectation; 1 = at least one did
 * not (or an unknown scenario name was requested).
 *
 * @see mt#3756 — this task
 * @see docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md — Phase 6
 * @see scripts/run-guard-canaries.ts — the isolation pattern this follows
 * @see scripts/audit-fire-log.ts — the read-side half of mt#3756
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, sep } from "node:path";

// Isolate BEFORE importing anything that resolves a state path at module load
// or first invocation. Order is load-bearing (mt#2876 class).
const SCENARIO_STATE_DIR = mkdtempSync(join(tmpdir(), "mt3756-dispatcher-scenario-"));
process.env["MINSKY_STATE_DIR"] = SCENARIO_STATE_DIR;
process.env["CLAUDE_PROJECT_DIR"] = SCENARIO_STATE_DIR;

const { runDispatcher } = await import("../.minsky/hooks/dispatcher");
const { readFireLogEntries, getFireLogPath } = await import("../.minsky/hooks/fire-log");
type GuardRegistration = import("../.minsky/hooks/registry").GuardRegistration;
type HookOutput = import("../.minsky/hooks/types").HookOutput;

interface ScenarioRun {
  outputs: HookOutput[];
  stderr: string[];
  fireLogGuardNames: string[];
}

interface Scenario {
  name: string;
  /** What real behavior this observes, and which task established it. */
  describes: string;
  registrations: GuardRegistration[];
  toolName: string;
  /** Env vars to set for this scenario only; restored afterwards. */
  env?: Record<string, string>;
  expect: (run: ScenarioRun) => { ok: boolean; detail: string };
}

function guard(name: string, denyCapable: boolean, run: () => unknown): GuardRegistration {
  return {
    name,
    event: "PreToolUse",
    matcher: "Bash",
    module: () => Promise.resolve({ run: run as never }),
    timeoutMs: 1000,
    denyCapable,
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: "override-deny-precedence",
    describes:
      "mt#3625: a guard's audit line must not void a LATER guard's deny. " +
      "Pre-fix, audit lines went to stdout and Claude Code discarded the hook's entire " +
      "output when stdout carried anything besides the one JSON object.",
    toolName: "Bash",
    env: { MINSKY_HOOK_OVERRIDE: "scenario-overridden" },
    registrations: [
      guard("scenario-overridden", true, () => ({
        auditLines: ["[scenario-overridden] OVERRIDE: active for this call\n"],
      })),
      guard("scenario-denier", true, () => ({ deny: { reason: "scenario deny" } })),
    ],
    expect: (run) => {
      const decision = run.outputs[0]?.hookSpecificOutput?.permissionDecision;
      const auditOnStderr = run.stderr.some((s) => s.includes("scenario-overridden"));
      return {
        ok: decision === "deny" && auditOnStderr,
        detail: `permissionDecision=${decision ?? "(none)"}, auditLine on stderr=${auditOnStderr}`,
      };
    },
  },
  {
    name: "updated-input-first-wins",
    describes:
      "mt#3612: when two guards both rewrite the tool's arguments, the FIRST in " +
      "registry order wins and the later rewrite is discarded with a named audit line.",
    toolName: "Bash",
    registrations: [
      guard("scenario-rewriter-a", false, () => ({
        updatedInput: { command: "echo from-a" },
      })),
      guard("scenario-rewriter-b", false, () => ({
        updatedInput: { command: "echo from-b" },
      })),
    ],
    expect: (run) => {
      const updated = run.outputs[0]?.hookSpecificOutput?.updatedInput as
        | { command?: string }
        | undefined;
      const discardAudited = run.stderr.some((s) => s.includes("scenario-rewriter-b"));
      return {
        ok: updated?.command === "echo from-a" && discardAudited,
        detail: `updatedInput.command=${updated?.command ?? "(none)"}, discard audited=${discardAudited}`,
      };
    },
  },
];

/**
 * Hard-fail if the isolation did not actually take.
 *
 * Without this the harness has the exact defect it exists to prevent: if
 * `MINSKY_STATE_DIR` were ignored — a changed resolution order, an env var
 * clobbered by a later import, a future `getFireLogPath` that consults
 * something else first — every scenario would write to the operator's REAL
 * fire-log and still report PASS, because nothing downstream inspects WHERE
 * the records landed. A probe that cannot fail carries no information
 * (mem#704), and "the records went somewhere" is not evidence they went
 * somewhere safe.
 *
 * Checked before any scenario runs, so a broken isolation costs zero writes
 * rather than one per scenario.
 */
function assertIsolationHeld(): void {
  // Compare normalized paths at a separator boundary, not raw prefixes: a
  // sibling directory (`/tmp/scenario-abc-evil` against a root of
  // `/tmp/scenario-abc`) satisfies a bare `startsWith` and would be waved
  // through by the very check meant to catch it. PR #2664 R2, non-blocking —
  // taken anyway, because an assertion that can be fooled is the failure mode
  // this whole PR is about.
  const root = resolvePath(SCENARIO_STATE_DIR);
  const resolved = resolvePath(getFireLogPath());
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    console.error(
      `ISOLATION FAILED — refusing to run.\n` +
        `  MINSKY_STATE_DIR: ${SCENARIO_STATE_DIR}\n` +
        `  fire-log resolves to: ${resolved}\n` +
        `This harness would have written to a log outside its temp state dir, which is the ` +
        `mt#3756 defect itself. Fix the resolution before running any scenario.`
    );
    rmSync(SCENARIO_STATE_DIR, { recursive: true, force: true });
    process.exit(1);
  }
}

async function runScenario(scenario: Scenario): Promise<ScenarioRun> {
  const outputs: HookOutput[] = [];
  const stderr: string[] = [];

  const restore: Array<[string, string | undefined]> = [];
  for (const [key, value] of Object.entries(scenario.env ?? {})) {
    restore.push([key, process.env[key]]);
    process.env[key] = value;
  }

  const before = readFireLogEntries().length;

  try {
    await runDispatcher("PreToolUse", {
      hookFilename: "dispatch-pretooluse.ts",
      registrations: scenario.registrations,
      readInputFn: () =>
        Promise.resolve({
          session_id: "dispatcher-scenario",
          transcript_path: "",
          cwd: SCENARIO_STATE_DIR,
          hook_event_name: "PreToolUse",
          tool_name: scenario.toolName,
          tool_input: { command: "echo original" },
        } as never),
      writeOutputFn: (output) => outputs.push(output),
      stderrWrite: (s) => stderr.push(s),
      // recordFireLogFn and resolveDispatchContextFn are deliberately NOT
      // injected — the real ones run, against the isolated state dir. That is
      // the whole point of this harness relative to dispatcher.test.ts.
    });
  } finally {
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const after = readFireLogEntries();
  return {
    outputs,
    stderr,
    fireLogGuardNames: after.slice(before).map((e) => e.guardName),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes("--json");

  if (argv.includes("--list")) {
    for (const s of SCENARIOS) console.log(`${s.name}\n  ${s.describes}\n`);
    process.exit(0);
  }

  const nameIndex = argv.indexOf("--scenario");
  const requested = nameIndex >= 0 ? argv[nameIndex + 1] : undefined;
  const selected = requested ? SCENARIOS.filter((s) => s.name === requested) : SCENARIOS;

  if (selected.length === 0) {
    console.error(
      `Unknown scenario "${requested}". Known: ${SCENARIOS.map((s) => s.name).join(", ")}`
    );
    process.exit(1);
  }

  assertIsolationHeld();

  const results: Array<{ name: string; ok: boolean; detail: string; guardNames: string[] }> = [];

  try {
    for (const scenario of selected) {
      const run = await runScenario(scenario);
      const verdict = scenario.expect(run);
      results.push({
        name: scenario.name,
        ok: verdict.ok,
        detail: verdict.detail,
        guardNames: run.fireLogGuardNames,
      });
    }

    const allOk = results.every((r) => r.ok);

    if (jsonMode) {
      process.stdout.write(
        `${JSON.stringify({ stateDir: SCENARIO_STATE_DIR, fireLogPath: getFireLogPath(), results, allOk }, null, 2)}\n`
      );
    } else {
      console.log(`Isolated state dir: ${SCENARIO_STATE_DIR}`);
      console.log(`Isolated fire-log:  ${getFireLogPath()}`);
      console.log("");
      for (const r of results) {
        console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
        console.log(`      ${r.detail}`);
        console.log(`      fire-log records written: [${r.guardNames.join(", ")}]`);
      }
      console.log("");
      console.log(
        allOk
          ? "PASS — every scenario met its expectation, and every record landed in the isolated log."
          : "FAIL — at least one scenario did not behave as expected (see FAIL lines above)."
      );
    }

    process.exit(allOk ? 0 : 1);
  } finally {
    rmSync(SCENARIO_STATE_DIR, { recursive: true, force: true });
  }
}

await main();
