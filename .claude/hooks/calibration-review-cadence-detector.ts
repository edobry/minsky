#!/usr/bin/env bun
// UserPromptSubmit hook: warn when a hook-calibration JSONL log has crossed its
// review threshold (or has sat unreviewed for too long) so a calibration
// review cannot silently lapse again (mt#2619).
//
// Why this exists. `.minsky/calibration-review-watermarks.json` showed exactly
// ONE calibration review had ever occurred (retrospective-trigger, watermark
// stuck at count=12 since 2026-06-13) despite THREE detectors sitting
// permanently gated at INJECTION_ENABLED=false past their own documented
// "review after ~10 fires" thresholds (ask-routing-deferral: 43 fires;
// code-mechanism-assertion: 52 fires), and a fourth log
// (policy-coverage-calibration.jsonl) growing to 973KB / 1,457 lines with zero
// reviews. The `/calibration-review` skill and the
// `mcp__minsky__observability_calibration-review` command already do the
// mechanical sweep — but nothing PROMPTS an agent to run them. This is the
// same class of gap `skill-staleness-detector.ts` closed for stale
// skill/agent/rule files (mt#1622): the fix that exists is discoverable only
// if someone remembers to look for it.
//
// Two independent review-due conditions (mirrors calibration-sweep.ts's
// pure logic exactly, plus a time-based extension):
//   1. pastThreshold (existing count+diversity-aware bar from
//      calibration-sweep.ts): fires-since-last-review >= FIRES_THRESHOLD (10)
//      AND distinctPhrases >= DIVERSITY_THRESHOLD (3).
//   2. time-stale: the log HAS been reviewed before (a watermark exists), has
//      >= 1 new fire since that review, AND the review is >= STALE_DAYS_MS
//      old. This closes the exact gap that let retrospective-trigger sit
//      forgotten for 3+ weeks: 8 new fires since 2026-06-13 never crossed the
//      10-fire count bar, so the mechanical sweep alone would never flag it.
//
// Re-warning is suppressed via a small persisted last-warned state file
// (mirrors the skill-staleness-detector.ts `lastReported` pattern) so this
// doesn't nag every single turn once a log is due — only when the fire count
// grows further, or a cooldown period has elapsed while still unreviewed.
//
// INFORMATIONAL ONLY: always exits 0, never blocks the prompt (fail-open).
//
// Override: MINSKY_SKIP_CALIBRATION_CADENCE=1|true|yes skips the hook with an
// audit-log line to stdout.
//
// @see mt#2619 — this hook (Track-1 item of the mt#2607 tech-debt burndown).
//      The mt#2619 task spec documents two constraints discovered during
//      implementation: the mt#2304 hooks-compile-pipeline PR collision
//      (blocks detector .ts edits — INJECTION_ENABLED flips/pattern tuning
//      are recorded as dispositions, not code changes, in this PR) and the
//      live-registry chicken-and-egg (a newly-registered log's watermark
//      can't be `--ack`'d until the live MCP server has this PR's code).
// @see ask 483dbcb0-788a-4159-9d8a-ba718ba1f2b0 — the FP-classification +
//      flip/tune/retire disposition recommendations for the four
//      past-threshold logs found by this task's review pass.
// @see .claude/hooks/skill-staleness-detector.ts — architectural template
//      (re-warning suppression, per-turn UserPromptSubmit injection)
// @see .claude/hooks/inject-prod-state.ts — sibling cache-staleness framing
// @see src/domain/calibration/calibration-sweep.ts — the pure sweep logic
//      this hook reuses (CALIBRATION_LOG_REGISTRY, runSweep, computeLogResult)
// @see .claude/skills/calibration-review/SKILL.md — the skill this hook
//      points the agent at when a log is review-due

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readInput, writeOutput } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import {
  CALIBRATION_LOG_REGISTRY,
  runSweep,
  type CalibrationLogResult,
  type WatermarkStore,
} from "../../src/domain/calibration/calibration-sweep";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_CALIBRATION_CADENCE";

const WATERMARK_STORE_PATH = ".minsky/calibration-review-watermarks.json";
const LAST_WARNED_STORE_PATH = ".minsky/calibration-review-cadence-last-warned.json";

/**
 * Time-based staleness bar for a REVIEWED log with new-but-below-count-bar
 * fires. Grounded in CLAUDE.md `decision-defaults.mdc §Thresholds` — "10 days
 * for lynchpin tracking" is the nearest existing anchor; a calibration log
 * with unreviewed new fires is exactly a "tracking" concern (watching
 * detector calibration drift), not active in-flight work (which uses the
 * tighter 5-day bar). The retrospective-trigger incident this hook fixes sat
 * stale for 21+ days — well past this bar — so 10 days catches it with
 * margin while not firing on a log reviewed a few days ago.
 */
export const STALE_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * Re-warning cooldown: once a log is flagged review-due and the operator has
 * NOT acted (no new watermark advance), re-remind every COOLDOWN_MS even
 * without a fire-count change — so the warning doesn't evaporate into a
 * single easily-missed turn. 3 days matches the CLAUDE.md
 * `decision-defaults.mdc §Thresholds` calibration-window family (5-day budget
 * windows, 24h burst-detection) scaled down slightly since this is a repeat
 * nag rather than a single escalation.
 */
export const COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserPromptSubmitInput extends ClaudeHookInput {
  prompt: string;
}

export interface ReviewDueLog {
  name: string;
  path: string;
  firesSinceLastReview: number;
  totalFires: number;
  distinctPhrases: number;
  reason: "past-threshold" | "time-stale";
}

/** Per-log last-warned record, keyed by log path. */
export interface LastWarnedRecord {
  lastWarnedAt: string;
  lastWarnedFireCount: number;
}
export type LastWarnedStore = Record<string, LastWarnedRecord>;

// ---------------------------------------------------------------------------
// Pure logic (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Determine which logs are review-due per the two independent conditions
 * described in the header comment. Pure function over already-computed sweep
 * results + the watermark store.
 */
export function computeReviewDueLogs(
  results: CalibrationLogResult[],
  watermarks: WatermarkStore,
  nowMs: number,
  staleMs: number = STALE_DAYS_MS
): ReviewDueLog[] {
  const due: ReviewDueLog[] = [];
  for (const r of results) {
    if (r.pastThreshold) {
      due.push({
        name: r.entry.name,
        path: r.entry.path,
        firesSinceLastReview: r.firesSinceLastReview,
        totalFires: r.totalFires,
        distinctPhrases: r.distinctPhrases,
        reason: "past-threshold",
      });
      continue;
    }

    // Time-stale: only applies to a log that HAS a watermark (was reviewed
    // before) and has accrued at least one new fire since then. A log that
    // has never been reviewed and isn't past-threshold either simply hasn't
    // accumulated enough signal yet (e.g. causal-premise at 1 fire) — that's
    // "keep collecting," not "forgotten."
    const wm = watermarks[r.entry.path];
    if (!wm || r.firesSinceLastReview <= 0) continue;
    const reviewedMs = Date.parse(wm.lastReviewedAt);
    if (Number.isNaN(reviewedMs)) continue;
    if (nowMs - reviewedMs >= staleMs) {
      due.push({
        name: r.entry.name,
        path: r.entry.path,
        firesSinceLastReview: r.firesSinceLastReview,
        totalFires: r.totalFires,
        distinctPhrases: r.distinctPhrases,
        reason: "time-stale",
      });
    }
  }
  return due;
}

/**
 * Should this due log be (re-)warned about this turn? True when never
 * warned before, when new fires have arrived since the last warning, or when
 * the cooldown has elapsed while still unaddressed.
 */
export function shouldReWarn(
  due: ReviewDueLog,
  lastWarned: LastWarnedStore,
  nowMs: number,
  cooldownMs: number = COOLDOWN_MS
): boolean {
  const prior = lastWarned[due.path];
  if (!prior) return true;
  if (due.totalFires > prior.lastWarnedFireCount) return true;
  const warnedMs = Date.parse(prior.lastWarnedAt);
  if (Number.isNaN(warnedMs)) return true;
  return nowMs - warnedMs >= cooldownMs;
}

/** Build the additionalContext warning message for a set of due logs. */
export function formatCadenceWarning(due: ReviewDueLog[]): string {
  const lines: string[] = [
    "[calibration-review-cadence-detector] Calibration log(s) are review-due (mt#2619):",
    "",
  ];
  for (const d of due) {
    const reasonLabel =
      d.reason === "past-threshold"
        ? "past review threshold (fires + diversity)"
        : `unreviewed for >= ${Math.floor(STALE_DAYS_MS / (24 * 60 * 60 * 1000))} days`;
    lines.push(
      `  - ${d.name}: ${d.firesSinceLastReview} new fire(s) since last review ` +
        `(${d.totalFires} total, ${d.distinctPhrases} distinct) — ${reasonLabel}`
    );
  }
  lines.push("");
  lines.push(
    "Run the /calibration-review skill (or " +
      "mcp__minsky__observability_calibration-review) to classify false " +
      "positives and record a flip/tune/keep disposition before this drifts " +
      "further out of review."
  );
  lines.push(`Override: ${OVERRIDE_ENV_VAR}=1 suppresses this warning.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function readJsonOrDefault<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeLastWarnedStore(path: string, store: LastWarnedStore): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[calibration-review-cadence-detector] failed to write last-warned store: ${msg}\n`
    );
  }
}

function isOverrideTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  if (isOverrideTruthy(process.env[OVERRIDE_ENV_VAR])) {
    process.stdout.write(
      `[calibration-review-cadence-detector] override active: ${OVERRIDE_ENV_VAR}=${process.env[OVERRIDE_ENV_VAR]} at ${new Date().toISOString()}\n`
    );
    process.exit(0);
  }

  let input: UserPromptSubmitInput;
  try {
    input = await readInput<UserPromptSubmitInput>();
  } catch {
    process.exit(0);
  }

  const repoRoot = resolve(input.cwd ?? process.cwd());
  const watermarkPath = join(repoRoot, WATERMARK_STORE_PATH);
  const lastWarnedPath = join(repoRoot, LAST_WARNED_STORE_PATH);

  try {
    const watermarks = readJsonOrDefault<WatermarkStore>(watermarkPath, {});
    const readContent = async (relPath: string): Promise<string | null> => {
      try {
        return readFileSync(join(repoRoot, relPath), "utf-8");
      } catch {
        return null;
      }
    };
    const results = await runSweep(CALIBRATION_LOG_REGISTRY, readContent, watermarks);

    const now = Date.now();
    const due = computeReviewDueLogs(results, watermarks, now);
    if (due.length === 0) process.exit(0);

    const lastWarned = readJsonOrDefault<LastWarnedStore>(lastWarnedPath, {});
    const toWarn = due.filter((d) => shouldReWarn(d, lastWarned, now));
    if (toWarn.length === 0) process.exit(0);

    const updated: LastWarnedStore = { ...lastWarned };
    for (const d of toWarn) {
      updated[d.path] = {
        lastWarnedAt: new Date(now).toISOString(),
        lastWarnedFireCount: d.totalFires,
      };
    }
    writeLastWarnedStore(lastWarnedPath, updated);

    const output: HookOutput = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: formatCadenceWarning(toWarn),
      },
    };
    writeOutput(output);
  } catch (err) {
    process.stderr.write(
      `[calibration-review-cadence-detector] error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(0);
  }
}

if (import.meta.main) {
  await main();
}
