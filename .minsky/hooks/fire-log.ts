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
 * {@link KNOWN_OVERRIDE_ENV_VARS} (mirroring `HOOK_ONLY_ENV_VARS`):
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

export interface FireLogEntry {
  timestamp: string;
  guardName: string;
  /** Lifecycle event or pipeline stage the guard ran under (e.g. "PreToolUse", "PreCommit"). */
  event: string;
  decision: FireLogDecision;
  /** Milliseconds spent evaluating this guard (per-fire cost, not cumulative). */
  durationMs: number;
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
  /** Tool context — the tool this guard was invoked for (PreToolUse/PostToolUse only). */
  toolName?: string;
  sessionId?: string;
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
  durationMs: number;
  overrideEnvVar?: string;
  overrideClassification?: OverrideClassification;
  /** mt#2597 R1 fix — see {@link FireLogEntry.overrideSource}. */
  overrideSource?: "env" | "grant";
  toolName?: string;
  sessionId?: string;
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
      durationMs: input.durationMs,
      ...(input.overrideEnvVar !== undefined ? { overrideEnvVar: input.overrideEnvVar } : {}),
      ...(input.overrideClassification !== undefined
        ? { overrideClassification: input.overrideClassification }
        : {}),
      ...(input.overrideSource !== undefined ? { overrideSource: input.overrideSource } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
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
    typeof r.durationMs === "number"
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
