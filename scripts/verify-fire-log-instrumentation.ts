#!/usr/bin/env bun
/**
 * mt#5081 — live-verify that every guard ruled `instrumented` writes a fire-log
 * row when invoked.
 *
 * Runs each guard's SOURCE entrypoint (`.minsky/hooks/<name>.ts`) as a
 * subprocess with a minimal synthetic payload and `MINSKY_STATE_DIR` pointed at
 * a scratch directory, then reads the scratch fire-log back and asserts one row
 * per guard, keyed by `guardName`. The payload is deliberately the guard's
 * cheapest early-exit path — a tool it does not act on — because the claim
 * under test is "this guard RECORDS when it runs", not "its deep path works".
 * An early-exit row is precisely the signal that was missing for these 29.
 *
 * Exit 0 = every instrumented guard produced exactly one row. Exit 1 = at least
 * one did not (the finding). Exit 2 = the check could not run.
 *
 * @see .minsky/hooks/canary-dispositions.ts — FIRE_LOG_INSTRUMENTATION
 * @see .minsky/hooks/fire-log.ts — getFireLogPath, MINSKY_STATE_DIR
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeTruncate } from "@minsky/shared/safe-truncate";
import { FIRE_LOG_INSTRUMENTATION } from "../.minsky/hooks/canary-dispositions";

const REPO_ROOT = join(import.meta.dir, "..");
const HOOKS_DIR = join(REPO_ROOT, ".minsky", "hooks");
const SESSION_ID = "mt5081-verify";
const PER_GUARD_TIMEOUT_MS = 20_000;

/** A payload that reaches every guard's cheapest exit. `Bash` is acted on by none of the 14. */
function payloadFor(guardName: string): Record<string, unknown> {
  const base = {
    session_id: SESSION_ID,
    cwd: REPO_ROOT,
    tool_name: "Bash",
    tool_input: { command: "true" },
    tool_response: {},
  };
  // Stop-event hook: no tool fields, and a state file naming a root that does
  // not exist so it skips the typecheck rather than running one.
  if (guardName === "typecheck-on-stop") {
    writeFileSync(`/tmp/claude-typecheck-roots-${SESSION_ID}-main.txt`, "/nonexistent-root\n");
    return { session_id: SESSION_ID, cwd: REPO_ROOT, hook_event_name: "Stop" };
  }
  return base;
}

interface GuardRun {
  guardName: string;
  exitCode: number | null;
  rows: number;
  decision?: string;
  stderr: string;
}

async function main(): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "mt5081-fire-log-"));
  const fireLogPath = join(stateDir, "fire-log.jsonl");
  const instrumented = [...FIRE_LOG_INSTRUMENTATION.entries()]
    .filter(([, r]) => r.status === "instrumented")
    .map(([name]) => name)
    .sort();

  if (instrumented.length === 0) {
    console.error(
      "[verify-fire-log-instrumentation] no guards ruled instrumented — nothing to check"
    );
    process.exit(2);
  }

  const runs: GuardRun[] = [];
  for (const guardName of instrumented) {
    const entry = join(HOOKS_DIR, `${guardName}.ts`);
    if (!existsSync(entry)) {
      runs.push({ guardName, exitCode: null, rows: 0, stderr: `no source at ${entry}` });
      continue;
    }
    const before = existsSync(fireLogPath)
      ? readFileSync(fireLogPath, "utf8").split("\n").filter(Boolean).length
      : 0;
    // Async spawn, as `verify-conversation-pid-mapping.ts` does: the sync
    // variant's types accept no stdin data.
    const proc = Bun.spawn(["bun", entry], {
      cwd: REPO_ROOT,
      stdin: new TextEncoder().encode(JSON.stringify(payloadFor(guardName))),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MINSKY_STATE_DIR: stateDir },
      timeout: PER_GUARD_TIMEOUT_MS,
    });
    const exitCode = await proc.exited;
    const stderrText = await new Response(proc.stderr).text();
    const lines = existsSync(fireLogPath)
      ? readFileSync(fireLogPath, "utf8").split("\n").filter(Boolean)
      : [];
    const mine = lines
      .slice(before)
      .map((l) => JSON.parse(l) as { guardName?: string; decision?: string });
    const ours = mine.filter((r) => r.guardName === guardName);
    runs.push({
      guardName,
      exitCode,
      rows: ours.length,
      ...(ours[0]?.decision === undefined ? {} : { decision: ours[0].decision }),
      stderr: safeTruncate(stderrText.trim(), 200, "head"),
    });
  }

  rmSync(stateDir, { recursive: true, force: true });
  // The Stop-hook sentinel `payloadFor` wrote (PR #3715 R1) — leave nothing in /tmp.
  rmSync(`/tmp/claude-typecheck-roots-${SESSION_ID}-main.txt`, { force: true });

  const failures = runs.filter((r) => r.rows !== 1);
  for (const r of runs) {
    const mark = r.rows === 1 ? "PASS" : "FAIL";
    console.log(
      `[${mark}] ${r.guardName.padEnd(36)} rows=${r.rows} decision=${r.decision ?? "-"} exit=${r.exitCode ?? "spawn-error"}`
    );
    if (r.rows !== 1 && r.stderr) console.log(`       stderr: ${r.stderr}`);
  }
  console.log(
    `\n${runs.length - failures.length}/${runs.length} instrumented guards wrote exactly one fire-log row`
  );
  console.log(
    JSON.stringify({
      total: runs.length,
      passed: runs.length - failures.length,
      failed: failures.map((f) => f.guardName),
    })
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

if (import.meta.main) await main();
