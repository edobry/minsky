// Fire-log instrumentation — mt#2597 (evaluation-loop Phase 1, RFC Notion
// 392937f0-3cb4-8188-aad6-d7d041de814b, §Part 1).
//
// Every enforcement point (guard, pre-commit step, eventually a merge gate —
// Phase 3, out of scope here) appends a one-line JSONL record per
// evaluation: timestamp, guard id, decision (allow/warn/deny), override
// env-var + classification, duration. Emit-only, no behavior change,
// fail-open, sub-millisecond target.
//
// This is the "success half" of the enforcement corpus's observability —
// mt#2812's guard-health.ts (`recordGuardError`/`recordGuardCheckSkip`)
// already covers the FAILURE half (a guard throwing, or explicitly
// degrading past an unreachable dependency). This module is a deliberate
// SIBLING to guard-health.ts, not a refactor of it: same state-dir
// resolution (`MINSKY_STATE_DIR` override, `~/.local/state/minsky/`
// default), same fs-dependency-seam shape for testability, same
// best-effort/swallow-all posture (a fire-log write failure must never
// block the guarded operation), same "no in-memory state — every read
// re-parses the log fresh from disk" rationale (guard processes are
// short-lived, one fresh Bun process per hook event).
//
// Dependency-free (per `.minsky/hooks/SPEC.md`'s invariant): no `src/` or
// `packages/domain` imports. See `./known-override-env-vars.ts` for how the
// override-classification oracle is sourced without violating that
// invariant.
//
// @see mt#2597 — this task
// @see docs/architecture/evaluation-loop-fire-log.md — schema + storage-decision writeup
// @see .minsky/hooks/guard-health.ts — the sibling FAILURE-half tracker (architectural precedent)
// @see .minsky/hooks/dispatcher.ts — the primary integration point (runDispatcher's guard loop)
// @see .minsky/hooks/known-override-env-vars.ts — the override-classification oracle

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { KNOWN_OVERRIDE_ENV_VARS } from "./known-override-env-vars";

// ---------------------------------------------------------------------------
// Persisted event shape
// ---------------------------------------------------------------------------

/** The guarded operation's outcome as seen by the calling code — the tri-state RFC schema. */
export type FireLogDecision = "allow" | "warn" | "deny";

/**
 * RFC Part 1 override classification, computed against
 * {@link KNOWN_OVERRIDE_ENV_VARS} — the hooks-tree copy of
 * `OPERATOR_OVERRIDE_ENV_VARS`, held equal to it in both directions by
 * `known-override-env-vars.test.ts` (mt#3882). It is NOT a copy of the full
 * `HOOK_ONLY_ENV_VARS` registry, which also holds credentials, server config
 * and test fixtures that no operator ever authorized:
 *
 * - `authorized_exception` — the override env-var IS a documented,
 *   registered legitimate-use escape-hatch (present in the oracle).
 * - `unclassified` — an override env-var was used, but it is NOT present in
 *   the oracle (a not-yet-registered ad hoc var — shouldn't normally happen
 *   given the mt#1788 ESLint enforcement, but this is the honest fallback
 *   rather than silently mis-classifying it as authorized).
 * - `contested` — the guard's decision was overridden WITHOUT going through
 *   the documented env-var mechanism at all, AND without a TTL-bound,
 *   reason-mandatory grant either. As of the R1 fix below, the dispatcher's
 *   grant-file channel (`guard-grant-store.ts`, mt#2658) is classified
 *   `authorized_exception` directly at the call site — NOT via this
 *   function's `envVarName === undefined` fallback — because a grant is
 *   itself TTL-bound and reason-mandatory by construction (see
 *   `dispatcher.ts`'s `buildOverrideFireLogFields`). `contested` remains
 *   reserved for a hypothetical override channel that is neither the env
 *   var nor a grant — the RFC's "bypassed at another layer" framing, now
 *   scoped to that residual case rather than the grant channel.
 */
export type OverrideClassification = "authorized_exception" | "unclassified" | "contested";

/**
 * mt#3355 — which channel produced the task id a `session_pr_merge` merge gate evaluated
 * against. Persisted so that a gate which never evaluated the PR is distinguishable from
 * one that evaluated it and passed: before this field, both wrote `decision: "allow"` and
 * differed only in `durationMs`, and 11.5% of recorded merges took the silent path.
 *
 * `unresolved` means the gate could not identify the PR at all — always paired with
 * `decision: "warn"`, never `allow`. See `merge-gate-task-resolution.ts`, which is the
 * only producer of these values.
 */
export type TaskResolutionSource =
  | "tool_input"
  | "branch-fallback"
  | "session-workspace-branch"
  | "unresolved";

export interface FireLogEntry {
  timestamp: string;
  guardName: string;
  /** Lifecycle event or pipeline stage the guard ran under (e.g. "PreToolUse", "PreCommit"). */
  event: string;
  decision: FireLogDecision;
  /**
   * mt#3892 — whether this record reflects a guard that REACHED a decision, or
   * one whose evaluation FAILED and whose fail-open outcome is being recorded
   * anyway.
   *
   * `decision` alone cannot answer that: a crashed guard fails open, so the
   * dispatcher writes `decision: "allow"` for it (deliberately — override-rate
   * and attention-cost aggregation must not be missing every crashed
   * evaluation). That makes `allow` ambiguous between "checked and permitted"
   * and "crashed and permitted by default", which is precisely the reading
   * mem#884 recorded in the field: `standalone-duplicate-matcher`'s "recent
   * `allow`s reflect crashes, not verified checks."
   *
   * Consumers that only count evaluations (rationalization-review's override
   * rates, coverage-receipt's liveness join) are unaffected and may ignore it.
   * The consumer that must NOT ignore it is guard-health's recovery join, which
   * counts `"decided"` records only — otherwise a continuously crashing guard
   * reads as recovered, since each crash writes its own `allow` microseconds
   * after its own failure event.
   *
   * OPTIONAL, and absence is deliberately NOT read as `"decided"`: records
   * written before this field existed cannot distinguish the two cases, so the
   * join treats them as no evidence at all (dormant) rather than as a false
   * all-clear.
   */
  guardOutcome?: "decided" | "crashed" | "deadline-skipped";
  /** Milliseconds spent evaluating this guard (per-fire cost, not cumulative). */
  durationMs: number;
  /**
   * mt#3757 — the guard OVERRAN its declared `timeoutMs` but finished inside
   * the accumulated slack, so it was NOT skipped. Carries the declared budget
   * it crossed, in ms; `durationMs` beside it is what it actually cost.
   *
   * Deliberately a SEPARATE field rather than a `guardOutcome` value, and the
   * distinction is load-bearing: a guard that overran its soft budget still
   * DECIDED. Folding it into `guardOutcome` would drop it out of guard-health's
   * clean-run join (which counts `"decided"` only), so a guard that worked
   * correctly — merely slowly — would read as having produced no clean run.
   * The overrun is an additive fact about COST, not a different outcome.
   *
   * `"deadline-skipped"` above is the opposite case and IS a new outcome: that
   * guard produced no verdict at all, so it is correctly excluded from the
   * clean-run join by the existing `=== "decided"` filter.
   */
  budgetExceededMs?: number;
  /** The env-var name that produced the override, when the outcome was overridden. */
  overrideEnvVar?: string;
  overrideClassification?: OverrideClassification;
  /**
   * mt#2597 R1 fix — which `checkOverride()` channel actually decided the
   * override: the `MINSKY_HOOK_OVERRIDE` env var, or a grant-file match
   * (`guard-grant-store.ts`, mt#2658). Present whenever `overrideClassification`
   * is present. See `dispatcher.ts`'s `buildOverrideFireLogFields` for the
   * deterministic-attribution logic — the discriminator mirrors
   * `checkOverride()`'s own precedence (env decides first; the grant channel
   * is only ever consulted, and only ever populates `grantReason`, when the
   * env var did NOT already decide for this guard).
   */
  overrideSource?: "env" | "grant";
  /**
   * mt#2989 — the authorization Ask id backing a grant-channel override
   * (`overrideSource: "grant"`). Present only for guards whose grant carries an
   * Ask (currently the merge-review REQUEST_CHANGES override); lets the fire log
   * name the operator authorization the override rests on, not just its class.
   */
  overrideGrantAsk?: string;
  /** Tool context — the tool this guard was invoked for (PreToolUse/PostToolUse only). */
  toolName?: string;
  /**
   * mt#3381 — whether the PreToolUse payload carried `agent_type`, and its value.
   *
   * Recorded to settle an empirical question no in-repo code has ever answered:
   * the vendor documents `agent_type` on subagent hook calls, but nothing here
   * has observed it (see `ClaudeHookInput.agent_type`). A guard that wants to
   * check "does the caller actually hold the tool I'm redirecting it to?" needs
   * this field; whether it can be built at all depends on the answer.
   *
   * `agentTypeObserved` distinguishes the three states a single optional string
   * cannot: fired in a subagent WITH the field, fired in a subagent WITHOUT it
   * (the field is missing → the check is unbuildable), or fired on the main
   * thread (where its absence is expected and says nothing).
   */
  agentType?: string;
  agentTypeObserved?: "present" | "absent-in-subagent" | "not-a-subagent";
  sessionId?: string;
  /**
   * mt#3355 — see {@link TaskResolutionSource}. Present on `session_pr_merge` gates that
   * resolve a task id; absent on every other guard, which has no such selector.
   */
  taskResolutionSource?: TaskResolutionSource;
}

// ---------------------------------------------------------------------------
// Log path resolution (mirrors guard-health.ts's getGuardHealthStateDir/LogPath)
// ---------------------------------------------------------------------------

export function getFireLogStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const envDir = env["MINSKY_STATE_DIR"];
  if (envDir) return envDir;
  return join(homedir(), ".local", "state", "minsky");
}

export function getFireLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getFireLogStateDir(env), "fire-log.jsonl");
}

// ---------------------------------------------------------------------------
// Fs dependency seam (testability — no real fs touched in unit tests)
// ---------------------------------------------------------------------------

export interface FireLogFsDeps {
  existsSync: (p: string) => boolean;
  mkdirSync: (p: string, opts?: { recursive?: boolean }) => void;
  appendFileSync: (p: string, data: string) => void;
  readFileSync: (p: string, encoding: "utf-8") => string;
}

const REAL_FS: FireLogFsDeps = { existsSync, mkdirSync, appendFileSync, readFileSync };

export interface FireLogRecordOptions {
  logPath?: string;
  fs?: FireLogFsDeps;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /**
   * Injectable for tests — defaults to `process.stderr.write`. Used ONLY to
   * emit the best-effort "degraded" marker on a write failure (see
   * {@link recordFireLogEntry}'s acceptance test: "Kill the log destination
   * -> the guarded operation still completes; a degraded marker is
   * emitted"). Itself wrapped in a try/catch — a broken stderr stream can
   * never escalate into a thrown error either.
   */
  stderrWrite?: (s: string) => void;
}

export interface FireLogReadOptions {
  logPath?: string;
  fs?: FireLogFsDeps;
  env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Override classification (RFC Part 1 — "using HOOK_ONLY_ENV_VARS as the oracle")
// ---------------------------------------------------------------------------

/**
 * Classify an override outcome per the RFC's three-way split. `envVarName`
 * is the SPECIFIC env-var name that produced the override (e.g.
 * `"MINSKY_HOOK_OVERRIDE"` for the dispatcher's unified D3 mechanism, or a
 * legacy per-guard var like `"MINSKY_SKIP_FRESHNESS"` for a standalone
 * hook). Pass `undefined` when the override did NOT go through any env-var
 * check at all (e.g. the dispatcher's grant-file channel) — this always
 * classifies as `"contested"` ("bypassed at another layer").
 */
export function classifyOverride(
  envVarName: string | undefined,
  knownOverrideEnvVars: ReadonlySet<string> = KNOWN_OVERRIDE_ENV_VARS
): OverrideClassification {
  if (envVarName === undefined) return "contested";
  return knownOverrideEnvVars.has(envVarName) ? "authorized_exception" : "unclassified";
}

// ---------------------------------------------------------------------------
// Recording (capture side) — best-effort, MUST NEVER throw into a guard
// ---------------------------------------------------------------------------

export interface RecordFireLogInput {
  guardName: string;
  event: string;
  decision: FireLogDecision;
  /** mt#3892 — see {@link FireLogEntry.guardOutcome}. */
  guardOutcome?: "decided" | "crashed" | "deadline-skipped";
  durationMs: number;
  /** mt#3757 — see {@link FireLogEntry.budgetExceededMs}. */
  budgetExceededMs?: number;
  overrideEnvVar?: string;
  overrideClassification?: OverrideClassification;
  /** mt#2597 R1 fix — see {@link FireLogEntry.overrideSource}. */
  overrideSource?: "env" | "grant";
  /** mt#2989 — see {@link FireLogEntry.overrideGrantAsk}. */
  overrideGrantAsk?: string;
  toolName?: string;
  /** mt#3381 — see {@link FireLogEntry.agentType}. */
  agentType?: string;
  /** mt#3381 — see {@link FireLogEntry.agentTypeObserved}. */
  agentTypeObserved?: "present" | "absent-in-subagent" | "not-a-subagent";
  sessionId?: string;
  /** mt#3355 — see {@link FireLogEntry.taskResolutionSource}. */
  taskResolutionSource?: TaskResolutionSource;
}

/**
 * Append one fire-log record. Best-effort: any fs failure (missing dir,
 * permission denied, disk full) is swallowed — recording must NEVER break
 * the guarded operation (RFC Part 1: "emit-only; no behavior change...
 * fail-open"; mirrors `guard-health.ts`'s `appendEvent` swallow-all posture).
 */
export function recordFireLogEntry(
  input: RecordFireLogInput,
  options?: FireLogRecordOptions
): void {
  try {
    const fs = options?.fs ?? REAL_FS;
    const now = options?.now ?? (() => new Date());
    const logPath = options?.logPath ?? getFireLogPath(options?.env);
    const dir = dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const ev: FireLogEntry = {
      timestamp: now().toISOString(),
      guardName: input.guardName,
      event: input.event,
      decision: input.decision,
      ...(input.guardOutcome !== undefined ? { guardOutcome: input.guardOutcome } : {}),
      durationMs: input.durationMs,
      ...(input.budgetExceededMs !== undefined ? { budgetExceededMs: input.budgetExceededMs } : {}),
      ...(input.overrideEnvVar !== undefined ? { overrideEnvVar: input.overrideEnvVar } : {}),
      ...(input.overrideClassification !== undefined
        ? { overrideClassification: input.overrideClassification }
        : {}),
      ...(input.overrideSource !== undefined ? { overrideSource: input.overrideSource } : {}),
      ...(input.overrideGrantAsk !== undefined ? { overrideGrantAsk: input.overrideGrantAsk } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.agentType ? { agentType: input.agentType } : {}),
      ...(input.agentTypeObserved !== undefined
        ? { agentTypeObserved: input.agentTypeObserved }
        : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.taskResolutionSource !== undefined
        ? { taskResolutionSource: input.taskResolutionSource }
        : {}),
    };
    fs.appendFileSync(logPath, `${JSON.stringify(ev)}\n`);
  } catch (err) {
    // Best-effort — recording must never break guard execution (fail-open,
    // verified by fire-log.test.ts's "throwing fs never propagates" case).
    // Still emit a non-JSON stderr "degraded" marker so the failure is
    // OBSERVABLE (per the acceptance test) without risking a second throw —
    // this inner try/catch has no further fallback, it just gives up.
    try {
      const stderrWrite = options?.stderrWrite ?? ((s: string) => process.stderr.write(s));
      stderrWrite(
        `[fire-log] degraded: failed to record guard=${input.guardName} event=${input.event} — ${err instanceof Error ? err.message : String(err)}\n`
      );
    } catch {
      // Truly nothing more we can do.
    }
  }
}

// ---------------------------------------------------------------------------
// Reading (pure read of the on-disk log — fail-safe, never throws)
// ---------------------------------------------------------------------------

function isValidEntry(item: unknown): item is FireLogEntry {
  if (!item || typeof item !== "object") return false;
  const r = item as Record<string, unknown>;
  return (
    typeof r.timestamp === "string" &&
    typeof r.guardName === "string" &&
    typeof r.event === "string" &&
    (r.decision === "allow" || r.decision === "warn" || r.decision === "deny") &&
    // mt#3892: `guardOutcome` is OPTIONAL, but when present it must be one of
    // the two known values — mirroring guard-health.ts's `causeClass`
    // validation, and for the same reason: an unrecognized string would
    // otherwise pass through as a validated entry carrying a value no consumer
    // has a branch for. The recovery join tests `=== "decided"`, so a bad value
    // already fails safe there; validating here keeps the parsed type honest for
    // every other reader.
    (r.guardOutcome === undefined ||
      r.guardOutcome === "decided" ||
      r.guardOutcome === "crashed" ||
      // mt#3757 — a guard skipped at its hard deadline. Produced no verdict, so
      // it is neither decided nor crashed; the recovery join's `=== "decided"`
      // filter already excludes it, and validating it here keeps the parsed
      // type honest for every other reader, per the paragraph above.
      r.guardOutcome === "deadline-skipped") &&
    typeof r.durationMs === "number" &&
    // mt#3757 — OPTIONAL, but a present value must be a number. Absence means
    // the guard stayed inside its declared budget, which is the common case.
    (r.budgetExceededMs === undefined || typeof r.budgetExceededMs === "number")
  );
}

/** Read + parse the JSONL log. Malformed lines are skipped. Missing file/read error -> []. */
export function readFireLogEntries(options?: FireLogReadOptions): FireLogEntry[] {
  try {
    const fs = options?.fs ?? REAL_FS;
    const logPath = options?.logPath ?? getFireLogPath(options?.env);
    if (!fs.existsSync(logPath)) return [];
    const raw = fs.readFileSync(logPath, "utf-8");
    const entries: FireLogEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isValidEntry(parsed)) entries.push(parsed);
      } catch {
        // Skip malformed line.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Aggregation — Phase-1 GATE support ("logs exist for all instrumented
// guards AND >=2 guards show >=5 fires") + canary/observability consumers.
// ---------------------------------------------------------------------------

export interface FireLogGuardSummary {
  fireCount: number;
  byDecision: Record<FireLogDecision, number>;
  overrideCount: number;
  overridesByClassification: Record<OverrideClassification, number>;
  lastFireTimestamp: string | null;
}

export interface FireLogSummary {
  byGuard: Record<string, FireLogGuardSummary>;
  totalFires: number;
}

/** Pure aggregation over a list of entries — no fs, the sole seam under test. */
export function summarizeFireLog(entries: readonly FireLogEntry[]): FireLogSummary {
  const byGuard: Record<string, FireLogGuardSummary> = {};

  for (const ev of entries) {
    let summary = byGuard[ev.guardName];
    if (!summary) {
      summary = {
        fireCount: 0,
        byDecision: { allow: 0, warn: 0, deny: 0 },
        overrideCount: 0,
        overridesByClassification: { authorized_exception: 0, unclassified: 0, contested: 0 },
        lastFireTimestamp: null,
      };
      byGuard[ev.guardName] = summary;
    }
    summary.fireCount++;
    summary.byDecision[ev.decision]++;
    if (ev.overrideClassification !== undefined) {
      summary.overrideCount++;
      summary.overridesByClassification[ev.overrideClassification]++;
    }
    if (!summary.lastFireTimestamp || ev.timestamp > summary.lastFireTimestamp) {
      summary.lastFireTimestamp = ev.timestamp;
    }
  }

  return { byGuard, totalFires: entries.length };
}

/** Convenience: read the log fresh from disk and compute the summary. Fail-safe — never throws. */
export function getFireLogSummary(options?: FireLogReadOptions): FireLogSummary {
  try {
    return summarizeFireLog(readFireLogEntries(options));
  } catch {
    return { byGuard: {}, totalFires: 0 };
  }
}
