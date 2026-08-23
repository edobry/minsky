/**
 * Fire-log instrumentation for the pre-commit pipeline — mt#2597
 * (evaluation-loop Phase 1, RFC Notion 392937f0-3cb4-8188-aad6-d7d041de814b,
 * Part 1).
 *
 * The RFC calls for TWO shared fire-log helpers: "one for the hook runtime,
 * one for the pre-commit pipeline." `.minsky/hooks/fire-log.ts` is the
 * hook-runtime side (dependency-free, wired into the guard dispatcher). This
 * module is the pre-commit-pipeline side, wired into `PreCommitHook.run()`
 * (`./pre-commit.ts`).
 *
 * Same schema shape and state-dir resolution as the hook-runtime sibling
 * (same `~/.local/state/minsky/fire-log.jsonl` file — a pre-commit STEP and
 * a guard EVALUATION are both "an enforcement point firing," so they share
 * one corpus-wide log rather than two disjoint files an operator would have
 * to merge by hand), same fail-open/best-effort posture. UNLIKE the
 * hook-runtime side, this module lives inside `src/` (part of the root
 * tsconfig program) and so can import `OPERATOR_OVERRIDE_ENV_VARS` directly
 * from `packages/domain` — no hand-maintained mirror needed here (contrast
 * `.minsky/hooks/known-override-env-vars.ts`, which exists ONLY because the
 * dependency-free hooks tree cannot import across that boundary, and which
 * mt#3882 made a checked equal of that same slice rather than a hand-copy).
 *
 * @see mt#2597 — this task
 * @see mt#3882 — the oracle both sides now share (see `classifyOverride` below)
 * @see .minsky/hooks/fire-log.ts — the hook-runtime sibling (schema this mirrors)
 * @see ./pre-commit.ts — the sole caller (PreCommitHook.run()'s step wrapper)
 * @see packages/domain/src/configuration/sources/environment.ts — OPERATOR_OVERRIDE_ENV_VARS, the override-classification oracle
 */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { OPERATOR_OVERRIDE_ENV_VARS } from "@minsky/domain/configuration/sources/environment";

export type FireLogDecision = "allow" | "warn" | "deny";
export type OverrideClassification = "authorized_exception" | "unclassified" | "contested";

export interface PreCommitFireLogEntry {
  timestamp: string;
  guardName: string;
  event: "PreCommit";
  decision: FireLogDecision;
  durationMs: number;
  overrideEnvVar?: string;
  overrideClassification?: OverrideClassification;
}

export function getPreCommitFireLogStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const envDir = env["MINSKY_STATE_DIR"];
  if (envDir) return envDir;
  return join(homedir(), ".local", "state", "minsky");
}

export function getPreCommitFireLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getPreCommitFireLogStateDir(env), "fire-log.jsonl");
}

/**
 * Classify an override outcome against {@link OPERATOR_OVERRIDE_ENV_VARS} —
 * the SAME three-way split, over the SAME oracle, as the hook-runtime
 * sibling's `classifyOverride`. Pass `undefined` when no env-var was consulted
 * at all.
 *
 * **The oracle changed in mt#3882, and the docblock above is the reason.** It
 * claimed "the SAME three-way split as the hook-runtime sibling" while this
 * side defaulted to the FULL registry (159 entries) and the hooks side to the
 * hand-maintained mirror (97) — so the two agreed on the split and disagreed
 * on the input. Both now read the operator-escape-hatch slice, which is what
 * `authorized_exception` was always meant to denote.
 *
 * Behaviour-preserving on every record ever written: across 577,694 fire-log
 * entries, exactly six distinct `overrideEnvVar` values appear
 * (`MINSKY_SKIP_AT_COVERAGE`, `MINSKY_SKIP_SIZE_BUDGET`,
 * `MINSKY_SKIP_RELATED_TESTS`, `MINSKY_HOOK_OVERRIDE`,
 * `MINSKY_SKIP_IMMUTABLE_MIGRATION_CHECK`, and the retired
 * `MINSKY_POLICY_COVERAGE_MODE`) — five are `operator-override` and the sixth
 * no longer exists. A guard's override var is an escape hatch by
 * construction, so a `tunable` never reaches this field.
 */
export function classifyOverride(
  envVarName: string | undefined,
  knownOverrideEnvVars: ReadonlySet<string> = OPERATOR_OVERRIDE_ENV_VARS
): OverrideClassification {
  if (envVarName === undefined) return "contested";
  return knownOverrideEnvVars.has(envVarName) ? "authorized_exception" : "unclassified";
}

export interface PreCommitFireLogFsDeps {
  existsSync: (p: string) => boolean;
  mkdirSync: (p: string, opts?: { recursive?: boolean }) => void;
  appendFileSync: (p: string, data: string) => void;
}

const REAL_FS: PreCommitFireLogFsDeps = { existsSync, mkdirSync, appendFileSync };

export interface RecordPreCommitFireLogInput {
  guardName: string;
  decision: FireLogDecision;
  durationMs: number;
  overrideEnvVar?: string;
  overrideClassification?: OverrideClassification;
}

export interface PreCommitFireLogRecordOptions {
  logPath?: string;
  fs?: PreCommitFireLogFsDeps;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Injectable — defaults to `process.stderr.write`. Fires only on a write failure ("degraded" marker). */
  stderrWrite?: (s: string) => void;
}

/**
 * Append one fire-log record for a pre-commit step. Best-effort: any fs
 * failure is swallowed (the commit must never be blocked by a broken
 * fire-log destination) — but a non-throwing "degraded" stderr marker is
 * still emitted so the failure is observable, per the RFC's acceptance
 * test ("kill the log destination -> the guarded operation still
 * completes; a degraded marker is emitted").
 */
export function recordPreCommitFireLogEntry(
  input: RecordPreCommitFireLogInput,
  options?: PreCommitFireLogRecordOptions
): void {
  try {
    const fs = options?.fs ?? REAL_FS;
    const now = options?.now ?? (() => new Date());
    const logPath = options?.logPath ?? getPreCommitFireLogPath(options?.env);
    const dir = dirname(logPath);
    fs.mkdirSync(dir, { recursive: true });

    const ev: PreCommitFireLogEntry = {
      timestamp: now().toISOString(),
      guardName: input.guardName,
      event: "PreCommit",
      decision: input.decision,
      durationMs: input.durationMs,
      ...(input.overrideEnvVar !== undefined ? { overrideEnvVar: input.overrideEnvVar } : {}),
      ...(input.overrideClassification !== undefined
        ? { overrideClassification: input.overrideClassification }
        : {}),
    };
    fs.appendFileSync(logPath, `${JSON.stringify(ev)}\n`);
  } catch (err) {
    try {
      const stderrWrite = options?.stderrWrite ?? ((s: string) => process.stderr.write(s));
      stderrWrite(
        `[pre-commit-fire-log] degraded: failed to record guard=${input.guardName} — ${err instanceof Error ? err.message : String(err)}\n`
      );
    } catch {
      // Truly nothing more we can do.
    }
  }
}
