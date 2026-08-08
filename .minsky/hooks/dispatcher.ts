// Guard-dispatcher framework core — ADR-028 D1, D3, D4, D6.
//
// One dispatcher process per lifecycle event replaces N per-hook process
// registrations (D1). This module provides the shared services every
// per-event entrypoint (`dispatch-pretooluse.ts`, and future
// `dispatch-posttooluse.ts` / `dispatch-userpromptsubmit.ts` / etc.) composes:
//
//   - `runDispatcher()`      — the D1 core loop: read stdin once, resolve
//                              context once (D6), run matched guards
//                              in-process, aggregate output.
//   - `checkOverride()`      — the D3 unified `MINSKY_HOOK_OVERRIDE` check.
//   - `logCalibrationRecord()` — the D4 shared calibration-logging service.
//   - `resolveDispatchContext()` — the D6 transcript/host-cap resolution
//                              that runs ONCE per invocation, before any
//                              guard executes.
//
// Dependency-free: only imports from `./types`, `./transcript`, and
// `./registry` (all sibling files in this same self-contained hooks tree —
// no `packages/domain` imports), per `.minsky/hooks/SPEC.md`'s invariant.
//
// @see docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md
// @see mt#2650 — this framework's tracking task (ADR-028 Phase 1)
// @see .minsky/hooks/registry.ts — the declarative registry this loop consumes
// @see .minsky/hooks/dispatch-pretooluse.ts — the PreToolUse pilot entrypoint
// @see .claude/hooks/block-subagent-bypass-merge.ts — the audit-line convention (non-JSON stdout)

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readInput, writeOutput, readHostCap, deriveBudgets, findRepoRoot } from "./types";
import type { ToolHookInput, HookOutput, HostCapInfo } from "./types";
import {
  parseTranscript,
  resolveParentTranscriptLines,
  resolveTranscriptCandidates,
} from "./transcript";
import type { TranscriptLine } from "./transcript";
import { readAnchor } from "./turn-anchor-store";
import type { RecordedTurnAnchor } from "./turn-anchor-store";
import { GUARD_REGISTRY, getGuardsForEvent } from "./registry";
import type {
  DispatchContext,
  GuardRegistration,
  GuardRunResult,
  LifecycleEvent,
} from "./registry";
import {
  getGuardGrantStorePath,
  readGuardGrantStore,
  findValidGuardGrant,
} from "./guard-grant-store";
import type { GuardGrant } from "./guard-grant-store";
import { recordGuardError } from "./guard-health";
import type { RecordGuardHealthInput } from "./guard-health";
import { recordFireLogEntry, classifyOverride } from "./fire-log";
import type { FireLogDecision, OverrideClassification, RecordFireLogInput } from "./fire-log";

// ---------------------------------------------------------------------------
// D3 — unified override mechanism
// ---------------------------------------------------------------------------

/**
 * The one env var that replaces the 34 bespoke `MINSKY_SKIP_*`/`MINSKY_ACK_*`/
 * `MINSKY_FORCE_*` vars (D3). Value is a comma-separated list of guard names,
 * or the literal `"all"`.
 */
export const HOOK_OVERRIDE_ENV_VAR = "MINSKY_HOOK_OVERRIDE";

export interface OverrideResult {
  overridden: boolean;
  /** The raw env var value, present whenever the var was set (regardless of match). */
  raw?: string;
  /**
   * Present when `overridden` came from a grant-file match (Phase-7 adjunct,
   * mt#2658) rather than the env var — the grant's MANDATORY `reason`, so
   * callers can fold it into their own audit line alongside (or instead of)
   * {@link buildOverrideAuditLine}.
   */
  grantReason?: string;
}

export interface CheckOverrideOptions {
  /**
   * Every registered guard name, used to detect typo'd override tokens (a
   * token that matches no guard and isn't `"all"` silently does nothing —
   * without this check the operator gets no signal that their override was
   * ineffective). Defaults to `GUARD_REGISTRY`'s names.
   */
  knownGuardNames?: readonly string[];
  /** Injectable for tests — defaults to `process.stderr.write`. */
  stderrWrite?: (s: string) => void;
  /**
   * Scope qualifier for a grant-file lookup (Phase-7 adjunct, mt#2658) — e.g.
   * a task id a guard's override should be scoped to. When supplied AND the
   * env var didn't already override this guard, `checkOverride` additionally
   * consults the guard-grant store (`.minsky/hooks/guard-grant-store.ts`) for
   * a valid, unexpired `(guardName, scope)` grant. Omitting `scope` (the
   * default) skips grant-file consultation entirely — every existing caller
   * that never passes `scope` sees zero behavior change.
   */
  scope?: string;
  /** Injectable — defaults to a real fs-backed guard-grant-store lookup. */
  findGuardGrant?: (guardName: string, scope: string, nowMs: number) => GuardGrant | null;
  /** Injectable clock for grant-expiry checks — defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Real fs-backed grant lookup — the default `findGuardGrant` implementation.
 * Reads via THIS module's own `readGuardGrantStore()` (`guard-grant-
 * store.ts`). On any non-`"ok"` result — a genuine store-read error
 * (malformed JSON, permission denied, etc.; an absent file is `"ok"` with
 * an empty `grants` array, per that function's own doc comment) — this
 * returns `null`, i.e. "no grant found via this channel," rather than
 * propagating the error or synthesizing an override.
 *
 * This is fail-CLOSED with respect to the override itself: a broken
 * grant-file channel can never spuriously GRANT an override — it can only
 * ever fail to find one, leaving the calling guard's own default posture
 * (allow or deny) entirely unaffected. `checkOverride()` treats a `null`
 * here identically to "no scope supplied" or "grant expired" — all three
 * collapse to the grant branch simply not firing. This posture is correct
 * BECAUSE `checkOverride()` is a secondary, additive channel behind the
 * `MINSKY_HOOK_OVERRIDE` env var, not a guard's sole gate — contrast with
 * `merge-grant-store.ts`'s `readGrantStore()`, whose caller
 * (`block-subagent-merge-without-grant.ts`) explicitly fails OPEN
 * (permits the merge) on a genuine read error, because for THAT guard the
 * grant store IS the sole gate and a broken store must not silently deny
 * every subagent merge. `checkOverride()` is never in that position — it
 * has no way to know what "fail open" should mean for an arbitrary
 * caller — so a broken store here always resolves to "no override
 * available," and the caller's own logic decides the actual outcome.
 */
function defaultFindGuardGrant(guardName: string, scope: string, nowMs: number): GuardGrant | null {
  const result = readGuardGrantStore(getGuardGrantStorePath());
  if (result.status !== "ok") return null;
  return findValidGuardGrant(result.grants, { guardName, scope }, nowMs);
}

/**
 * Check whether `guardName` is overridden — one shared, tested override
 * predicate (D3), replacing each guard's bespoke inline truthy-parsing. Two
 * channels are consulted, in order:
 *
 *   1. `MINSKY_HOOK_OVERRIDE` env var — the original D3 mechanism. Matching
 *      is case-INSENSITIVE on both sides — `guardName` and every
 *      comma-delimited env token are lowercased before comparison. Registry
 *      names are canonical lowercase-hyphenated, but an operator typing
 *      `MINSKY_HOOK_OVERRIDE=Check-Guessed-Session-Path` (or `ALL`) should
 *      still suppress the guard rather than silently no-op. Whitespace
 *      around each comma-delimited token is trimmed. Any token that is
 *      neither `"all"` nor a known guard name (per `options.knownGuardNames`,
 *      case-insensitively) triggers a stderr warning — the typo-detection
 *      signal ("did the operator mean a guard that doesn't exist?") without
 *      changing the override decision for THIS guard.
 *   2. **Grant-file channel (Phase-7 adjunct, mt#2658)** — consulted ONLY
 *      when `options.scope` is supplied and the env var didn't already
 *      override. Env vars are read from the harness's launch-time process
 *      env, which an agent mid-session cannot self-serve for MCP-tool-
 *      matched guards (a `Bash`-set env var never propagates to the sibling
 *      hook subprocess). The grant-file channel is the reachable
 *      alternative: an agent (or an issuance script on its behalf) writes a
 *      TTL-bound, reason-mandatory grant record to
 *      `.minsky/hooks/guard-grant-store.ts`'s store, and this function reads
 *      it at decision time. See that module's doc comment for the full
 *      rationale.
 */
export function checkOverride(
  guardName: string,
  env: NodeJS.ProcessEnv = process.env,
  options?: CheckOverrideOptions
): OverrideResult {
  const raw = env[HOOK_OVERRIDE_ENV_VAR];

  let overriddenByEnv = false;
  if (raw) {
    const knownGuardNames = options?.knownGuardNames ?? GUARD_REGISTRY.map((r) => r.name);
    const stderrWrite = options?.stderrWrite ?? ((s: string) => process.stderr.write(s));
    const knownLower = new Set(knownGuardNames.map((n) => n.toLowerCase()));

    const names = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const name of names) {
      const lower = name.toLowerCase();
      if (lower !== "all" && !knownLower.has(lower)) {
        stderrWrite(
          `[dispatcher] MINSKY_HOOK_OVERRIDE token "${name}" does not match any registered guard name (or "all") — possible typo; it will not suppress any guard.\n`
        );
      }
    }

    const namesLower = names.map((n) => n.toLowerCase());
    const guardNameLower = guardName.toLowerCase();
    overriddenByEnv = namesLower.includes("all") || namesLower.includes(guardNameLower);
  }

  if (overriddenByEnv) {
    return { overridden: true, raw };
  }

  // Phase-7 adjunct (mt#2658): grant-file channel, consulted only when the
  // caller supplies a scope qualifier — see this function's doc comment.
  if (options?.scope) {
    const findGrant = options.findGuardGrant ?? defaultFindGuardGrant;
    const nowFn = options.now ?? Date.now;
    const grant = findGrant(guardName, options.scope, nowFn());
    if (grant) {
      return raw
        ? { overridden: true, raw, grantReason: grant.reason }
        : { overridden: true, grantReason: grant.reason };
    }
  }

  return raw ? { overridden: false, raw } : { overridden: false };
}

/**
 * mt#2597 R1 fix (reviewer finding: "dispatcher override classification —
 * mixed env/grant scenarios") — map a `checkOverride()` result to the
 * fire-log's override fields, attributing deterministically to whichever
 * channel ACTUALLY decided rather than re-deriving `checkOverride()`'s own
 * precedence logic.
 *
 * `checkOverride()` guarantees `grantReason` is populated IF AND ONLY IF the
 * grant-file channel is what produced `overridden: true` for this call — the
 * env-var channel always returns early (see that function's doc comment)
 * BEFORE the grant branch ever runs. So `grantReason !== undefined` is a
 * sufficient discriminator even when `raw` is ALSO set (e.g.
 * `MINSKY_HOOK_OVERRIDE` configured for a different guard/token than the one
 * being evaluated right now) — "both channels present in the environment" is
 * not the same as "both channels decided." This function trusts that
 * invariant instead of re-implementing it.
 *
 * Grant-file overrides classify as `authorized_exception` directly — NOT via
 * `classifyOverride(undefined)`'s generic `contested` fallback — because a
 * grant is itself TTL-bound and reason-mandatory by construction
 * (`guard-grant-store.ts`), the same property that makes the env-var channel
 * an "authorized exception" in the first place.
 */
export function buildOverrideFireLogFields(override: OverrideResult): {
  overrideSource: "env" | "grant";
  overrideEnvVar?: string;
  overrideClassification: OverrideClassification;
} {
  if (override.grantReason !== undefined) {
    return { overrideSource: "grant", overrideClassification: "authorized_exception" };
  }
  return {
    overrideSource: "env",
    overrideEnvVar: HOOK_OVERRIDE_ENV_VAR,
    overrideClassification: classifyOverride(HOOK_OVERRIDE_ENV_VAR),
  };
}

/**
 * Build the D3 audit-line format:
 * `[dispatcher:<event>] OVERRIDE: guard=<name> session=<id> ts=<iso>` — a
 * non-JSON stdout line Claude Code's hook-output parser ignores, matching
 * the existing sibling-hook audit convention (documented in CLAUDE.md).
 * `now` is injectable so tests can assert an exact timestamp.
 *
 * `reason` (Phase-7 adjunct, mt#2658) is optional and appended as a
 * ` reason="..."` segment only when supplied — a grant-file-sourced override
 * always carries one (grants require a mandatory `reason`); an env-var-
 * sourced override never does, so the documented format for that path is
 * byte-for-byte unchanged.
 */
export function buildOverrideAuditLine(
  event: LifecycleEvent,
  guardName: string,
  sessionId: string | undefined,
  now: () => string = () => new Date().toISOString(),
  reason?: string
): string {
  const reasonPart = reason ? ` reason="${reason}"` : "";
  return `[dispatcher:${event}] OVERRIDE: guard=${guardName} session=${sessionId ?? "unknown"}${reasonPart} ts=${now()}\n`;
}

/**
 * Audit line for an `updatedInput` rewrite the dispatcher DROPPED because an
 * earlier guard in registry order already supplied one (mt#3612).
 *
 * `updatedInput` is a replacement value, so two guards rewriting the same tool
 * call cannot both be honored — and the loser is invisible without this line.
 * Discarding it silently is the failure class the whole surrounding tree keeps
 * hitting, so the drop is recorded rather than inferred.
 *
 * Written to STDERR by the caller. Claude Code discards a PreToolUse hook's
 * entire output when stdout carries anything besides the single JSON object, so
 * an audit line on stdout would silently void the rewrite that won — turning a
 * visibility mechanism into the very failure it was added to prevent.
 */
export function buildDiscardedRewriteAuditLine(
  event: LifecycleEvent,
  discardedGuard: string,
  keptGuard: string,
  sessionId: string | undefined,
  now: () => string = () => new Date().toISOString()
): string {
  return `[dispatcher:${event}] REWRITE-DISCARDED: guard=${discardedGuard} kept=${keptGuard} session=${sessionId ?? "unknown"} ts=${now()}\n`;
}

// ---------------------------------------------------------------------------
// D4 — calibration logging as a framework service
// ---------------------------------------------------------------------------

/** Injectable fs surface for `logCalibrationRecord` (keeps the function pure-testable, no real fs touched in tests). */
export interface CalibrationWriteDeps {
  existsSync: (p: string) => boolean;
  mkdirSync: (p: string, opts?: { recursive?: boolean }) => void;
  appendFileSync: (p: string, data: string) => void;
}

const defaultCalibrationDeps: CalibrationWriteDeps = { existsSync, mkdirSync, appendFileSync };

/**
 * Resolve the JSONL path for a calibration-log name, preserving the EXACT
 * filenames `CALIBRATION_LOG_REGISTRY`
 * (`src/domain/calibration/calibration-sweep.ts`) already expects — e.g.
 * `"causal-premise"` -> `.minsky/causal-premise-calibration.jsonl`. No
 * changes are needed to that registry when a guard migrates onto this
 * service (per the task's "read it; do not change it" constraint).
 *
 * mt#2710: `root` (whichever of `projectDir` / `CLAUDE_PROJECT_DIR` /
 * `process.cwd()` resolved) is passed through `findRepoRoot` before joining
 * `.minsky/` — this is the ACTUAL production write path for every
 * dispatcher-migrated calibration writer (`runDispatcher` calls
 * `logCalibrationRecord(reg.calibrationLog, outcome.calibration)` with no
 * `projectDir`, so it falls all the way to `process.cwd()`, which mirrors
 * the hook subprocess's shell cwd — routinely a repo SUBDIRECTORY). Without
 * this, fixing only the individual guards' now-unreachable standalone-CLI
 * `appendCalibrationRecord()` fallbacks would leave the real D4 write path
 * still scattering `.minsky/` into whatever subdirectory the shell cwd sat
 * in. `findRepoRoot` degrades to its input unchanged when no `.git` is
 * found up the tree (e.g. the synthetic `/repo`-style paths this module's
 * own tests use), so this is a no-op for every existing caller that already
 * passes a real repo root.
 */
export function calibrationLogPath(calibrationLogName: string, projectDir?: string): string {
  const root = projectDir ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();
  return join(findRepoRoot(root), ".minsky", `${calibrationLogName}-calibration.jsonl`);
}

/**
 * Append one calibration record for `calibrationLogName` — the D4 framework
 * service that replaces the 6+ hand-rolled `appendCalibrationRecord()`
 * implementations. Best-effort: any fs failure is swallowed (calibration
 * logging must never break a guard's actual decision, mirroring every
 * existing calibration-writer's try/catch posture).
 */
export function logCalibrationRecord(
  calibrationLogName: string,
  record: Record<string, unknown>,
  options?: { projectDir?: string; deps?: CalibrationWriteDeps }
): void {
  try {
    const deps = options?.deps ?? defaultCalibrationDeps;
    const logPath = calibrationLogPath(calibrationLogName, options?.projectDir);
    const dir = dirname(logPath);
    if (!deps.existsSync(dir)) deps.mkdirSync(dir, { recursive: true });
    deps.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  } catch {
    // best-effort — calibration logging must never break a guard's decision
  }
}

/**
 * Resolve an evaluation stream's path — the D4 sibling of `calibrationLogPath`
 * for the "every evaluated turn, fired or not" streams (ADR-024's 2026-08-03
 * amendment).
 *
 * **The two roots are NOT interchangeable, and conflating them is the defect
 * this helper exists to prevent (mt#3745).** `projectDir` is an ALREADY-RESOLVED
 * authoritative directory — the dispatcher has one, and it outranks everything.
 * `fallbackCwd` is a guard's raw `input.cwd`, which is routinely a session
 * workspace or a repo subdirectory, so it ranks BELOW `CLAUDE_PROJECT_DIR`.
 *
 * Two of the three hand-rolled writers passed the raw cwd as though it were
 * authoritative (`resolve(findRepoRoot(cwd), …)`), which scattered 12 stray
 * `.minsky/*-evaluations.jsonl` files across 6 session workspaces while the
 * calibration log — routed through `calibrationLogPath` — landed correctly in
 * the repo. Same failure `calibrationLogPath`'s own docblock describes for the
 * D4 write path, on the stream that did not exist when that fix shipped.
 *
 * Separate parameters rather than one `root` argument on purpose: a single
 * parameter is exactly what let the raw cwd be supplied where an authoritative
 * dir was meant, and nothing in the type system objected.
 */
export function evaluationLogPath(
  evaluationLogName: string,
  options?: { projectDir?: string; fallbackCwd?: string }
): string {
  const root =
    options?.projectDir ??
    process.env["CLAUDE_PROJECT_DIR"] ??
    options?.fallbackCwd ??
    process.cwd();
  return join(findRepoRoot(root), ".minsky", `${evaluationLogName}-evaluations.jsonl`);
}

/**
 * Append one evaluation record for `evaluationLogName`, replacing the three
 * hand-rolled `appendEvaluationRecord()` implementations (mt#3745) the way D4's
 * `logCalibrationRecord` replaced the hand-rolled calibration writers.
 *
 * Fail-open like its calibration sibling — a measurement stream must never break
 * the guard whose behavior it measures — but unlike `logCalibrationRecord` the
 * failure is REPORTED to stderr rather than swallowed, preserving the posture
 * every existing evaluation writer already had.
 */
export function logEvaluationRecord(
  evaluationLogName: string,
  record: Record<string, unknown>,
  options?: { projectDir?: string; fallbackCwd?: string; deps?: CalibrationWriteDeps }
): void {
  try {
    const deps = options?.deps ?? defaultCalibrationDeps;
    const logPath = evaluationLogPath(evaluationLogName, {
      projectDir: options?.projectDir,
      fallbackCwd: options?.fallbackCwd,
    });
    const dir = dirname(logPath);
    if (!deps.existsSync(dir)) deps.mkdirSync(dir, { recursive: true });
    deps.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[${evaluationLogName}] Failed to write evaluation log: ${msg}\n`);
  }
}

// ---------------------------------------------------------------------------
// D6 — transcript + host-cap resolution at the dispatcher boundary
// ---------------------------------------------------------------------------

export interface ResolveDispatchContextOptions {
  /** The dispatcher's own compiled filename (e.g. `"dispatch-pretooluse.ts"`) — used for the `readHostCap` matcher lookup. */
  hookFilename: string;
  projectDir?: string;
  events?: readonly string[];
  /** Injectable for tests — defaults to the real `readHostCap` from `./types`. */
  readHostCapFn?: (
    hookFilename: string,
    projectDir?: string,
    options?: { events?: readonly string[] }
  ) => HostCapInfo;
  /** Injectable for tests — defaults to the real `parseTranscript` from `./transcript`. */
  parseTranscriptFn?: (path: string) => TranscriptLine[];
  /** Injectable for tests — defaults to the real `resolveTranscriptCandidates` from `./transcript`. */
  resolveTranscriptCandidatesFn?: (transcriptPath: string, agentId?: string) => string[];
  /**
   * Injectable for tests — defaults to `readAnchor` from `./turn-anchor-store`
   * (mt#3490). Injected rather than patched: ADR-036 bans in-place patching of
   * a collaborator the code reaches itself.
   */
  readAnchorFn?: (sessionId: string) => RecordedTurnAnchor | undefined;
}

/**
 * Resolve the D6 shared context ONCE per invocation: host-cap budget +
 * transcript candidates/lines. Individual guards never call `readHostCap`
 * or `resolveTranscriptCandidates` themselves — this closes the entire class
 * of "guard written against `transcript_path` naively, breaks for
 * background-dispatched subagents" bugs (mt#2637) at the framework boundary.
 */
export function resolveDispatchContext(
  event: LifecycleEvent,
  input: Pick<ToolHookInput, "transcript_path" | "agent_id" | "session_id">,
  options: ResolveDispatchContextOptions
): DispatchContext {
  const readHostCapFn = options.readHostCapFn ?? readHostCap;
  const parse = options.parseTranscriptFn ?? parseTranscript;
  const resolveCandidates = options.resolveTranscriptCandidatesFn ?? resolveTranscriptCandidates;

  const hostCap = readHostCapFn(options.hookFilename, options.projectDir, {
    events: options.events ?? [event],
  });
  const budgets = deriveBudgets(hostCap.hostCapSec);

  let transcriptCandidates: string[] = [];
  let transcriptLines: TranscriptLine[] = [];
  if (input.transcript_path) {
    transcriptCandidates = resolveCandidates(input.transcript_path, input.agent_id);
    // PARENT-ONLY BY CONSTRUCTION (mt#3293). `transcriptCandidates.flatMap(parse)` — what this
    // used to be — concatenates the parent transcript with EVERY sibling subagent transcript,
    // subagents always ordered after the parent, with no per-line file-origin marker. Turn
    // extraction over that array (`findRealPromptIndices`, `extractLastAssistantTurn`,
    // `extractFinalTurn`) can anchor inside a static, already-completed subagent segment and
    // re-measure the same frozen turn forever. mt#3003 fixed that for two detectors by having
    // each call `resolveParentTranscriptLines` itself; this hoists it to the shared D6 field so
    // every consumer — including ones not yet written — gets the guarantee without opting in.
    //
    // Only flatten when there is at most one candidate: `resolveParentTranscriptLines` discards
    // `flatLines` entirely in the multi-candidate branch (it re-parses the parent alone), so
    // eagerly parsing every subagent transcript would be pure wasted I/O. Mirrors
    // `resolveParentTranscriptLinesForPath`'s own lazy-flatten for the same reason.
    const flatLines =
      transcriptCandidates.length > 1 ? [] : transcriptCandidates.flatMap((p) => parse(p));
    transcriptLines = resolveParentTranscriptLines(
      input.transcript_path,
      transcriptCandidates,
      flatLines,
      parse
    );
  }

  // The Stop-recorded turn anchor (mt#3490, ADR-031), resolved ONCE here for the
  // same reason transcript lines are: so no guard reaches for the store itself.
  // Only meaningful alongside lines to slice, so it is skipped when there is no
  // transcript — an anchor with nothing to anchor INTO is not useful, and the
  // read is not free.
  let recordedAnchor: RecordedTurnAnchor | undefined;
  if (input.session_id && transcriptLines.length > 0) {
    const readAnchorFn = options.readAnchorFn ?? readAnchor;
    recordedAnchor = readAnchorFn(input.session_id);
  }

  return {
    event,
    hostCapSec: hostCap.hostCapSec,
    budgets,
    transcriptCandidates,
    transcriptLines,
    recordedAnchor,
  };
}

// ---------------------------------------------------------------------------
// D1 — dispatcher core loop
// ---------------------------------------------------------------------------

export interface RunDispatcherOptions {
  /** The dispatcher's own compiled filename (e.g. `"dispatch-pretooluse.ts"`) — passed through to `resolveDispatchContext`. */
  hookFilename: string;
  /** Defaults to the live `GUARD_REGISTRY` — injectable so tests can supply a synthetic registry. */
  registrations?: GuardRegistration[];
  /** Injectable for tests — defaults to `readInput<ToolHookInput>()` from `./types`. */
  readInputFn?: () => Promise<ToolHookInput>;
  /**
   * Injectable for tests — defaults to `writeOutput` from `./types`.
   *
   * The ONLY writer of stdout in the dispatcher (mt#3625). There is deliberately
   * no general-purpose `stdoutWrite` seam beside it: Claude Code discards a
   * PreToolUse hook's entire output when stdout carries anything besides the one
   * JSON object, so any second stdout writer is a latent way to void a guard's
   * decision. Diagnostics go to `stderrWrite`.
   */
  writeOutputFn?: (output: HookOutput) => void;
  /** Injectable for tests — defaults to `process.stderr.write`. */
  stderrWrite?: (s: string) => void;
  /** Injectable for tests — defaults to the real `logCalibrationRecord`. */
  logCalibrationRecordFn?: (name: string, record: Record<string, unknown>) => void;
  /** Injectable for tests — defaults to the real `resolveDispatchContext`. */
  resolveDispatchContextFn?: (
    event: LifecycleEvent,
    input: Pick<ToolHookInput, "transcript_path" | "agent_id" | "session_id">,
    opts: { hookFilename: string }
  ) => DispatchContext;
  /**
   * Injectable for tests — defaults to the real `recordGuardError` from
   * `./guard-health` (mt#2812). Called from the guard-loop catch block
   * whenever a matched guard's `mod.run()` throws, IN ADDITION to the
   * existing stderr line — the automatic, zero-per-guard-changes capture
   * path for every guard registered in `GUARD_REGISTRY`.
   */
  recordGuardErrorFn?: (input: RecordGuardHealthInput & { error: unknown }) => void;
  /**
   * Injectable for tests — defaults to the real `recordFireLogEntry` from
   * `./fire-log` (mt#2597, evaluation-loop Phase 1). Called once per matched
   * guard for EVERY outcome — override-suppressed, thrown, denied,
   * additionalContext-only, or silently allowed — the single integration
   * point that instruments all guards registered in `GUARD_REGISTRY` without
   * any per-guard changes.
   */
  recordFireLogFn?: (input: RecordFireLogInput) => void;
  /** Injectable clock for fire-log duration measurement — defaults to `Date.now`. */
  nowMsFn?: () => number;
}

// ---------------------------------------------------------------------------
// Merged-context composition (mt#3394)
// ---------------------------------------------------------------------------

/** One guard's `additionalContext` contribution, tagged for ordering. */
export interface ContextFragment {
  guardName: string;
  priority: number;
  text: string;
}

/**
 * Priority used for a guard that declares no `contextPriority`. Every fragment
 * sitting at this value keeps registry order relative to its peers, so an
 * unannotated registry produces exactly the block it produced before mt#3394.
 */
export const DEFAULT_CONTEXT_PRIORITY = 0;

/**
 * Char budget for the MERGED block, derived from the registry's own
 * `attentionCost.denialMessageSizeChars` annotations rather than picked round
 * (`decision-defaults.mdc §Thresholds` — observed cadence, not round numbers).
 *
 * Measured across the 22 `UserPromptSubmit` registrations (all 22 annotated):
 *
 *   - Always-on injectors, which both fire AND emit on essentially every turn,
 *     and whose absence would make the agent assert stale facts:
 *     inject-current-time 90 + inject-git-state 300 + inject-prod-state 250 +
 *     memory-search 550 = **1190**.
 *   - The five largest conditional detectors: inject-dispatch-watchdog 1750 +
 *     guard-health-escalation 1300 + substrate-bypass 650 + pre-narration 650 +
 *     code-mechanism-assertion 600 = **4950**. (ask-routing-deferral, also 600,
 *     is now sixth and drops out of the bucket.)
 *
 * 1190 + 4950 = 6140 chars of fragment TEXT. The budget bounds the emitted
 * BLOCK, which also carries the `\n\n` separators between fragments: 9
 * fragments means 8 separators at 2 chars = 16. So 6140 + 16 = **6156**.
 *
 * (That separator term is not pedantry — the first draft of this constant
 * omitted it and the "measured turn is not truncated" test below failed by
 * exactly one dropped fragment. The test is what caught it.)
 *
 * **Why this fell from 7508 (mt#3485), and why the buckets changed.** Two
 * corrections, both grounded in rendered output rather than estimate:
 *
 *   1. The three heaviest guards were trimmed to the authoring standard
 *      (`.minsky/rules/guard-feedback-authoring.mdc`): dispatch-watchdog
 *      1668 -> 866 measured (and now CAPPED, so 1488 bounds any flag count at
 *      any field width), substrate-bypass 1518 -> 563, pre-narration
 *      1029 -> 581. Their annotations came down 1800/1600/1100 -> 1550/650/650.
 *   2. `inject-dispatch-watchdog` moved OUT of the always-on bucket, where the
 *      mt#3479 derivation had placed it. It is registered always-on and does
 *      run every turn, but `formatDispatchWatchdogState` returns null for both
 *      a missing cache and an empty flag set — the overwhelmingly common
 *      healthy case — so it CONTRIBUTES no chars on an ordinary turn. Counting
 *      its full annotation in the per-turn floor inflated that floor by its
 *      entire size. It is now counted where it belongs: as the largest
 *      conditional detector.
 *
 * The prior grow-from-4538 correction still stands as the reason this
 * derivation is trustworthy at all: before mt#3479 nothing compared an
 * annotation to real output and 14 of 26 understated it, so the budget bound on
 * ORDINARY turns and silently dropped reminders — the exact opposite of the
 * intent stated below. `guard-feedback-shape.test.ts` now fails if any guard's
 * output exceeds its annotation, so this input cannot silently drift again.
 *
 * A turn where everything always-on fires AND the five heaviest detectors all
 * fire at once therefore still fits. The budget does not bind on any realistic
 * turn; it binds on the pathological tail, where the annotated all-22 total is
 * 11440. That is the intent: bound unbounded growth as detectors graduate,
 * without truncating ordinary turns.
 *
 * This number should keep coming DOWN as more guard text is trimmed to the
 * authoring standard — it is sized by what the corpus currently emits, not by
 * what it ought to emit.
 *
 * **Why it went UP once, 5256 -> 5956 (mt#3705).** The sentence above is the
 * right expectation and this is the exception that proves what the number
 * means. `guard-health-escalation-detector` was annotated 600, measured off a
 * one-guard canary — but its banner had two UNBOUNDED axes (an uncapped guard
 * list, and an interpolated `Error.message` belonging to whatever threw) and
 * really rendered 1649 at six failing guards. So the old 5256 was not a
 * smaller budget for the same corpus; it was the same corpus with one member
 * mis-measured, and the guard's true output was never counted at all. mt#3705
 * CAPPED both axes (worst case now 1113, bounded by construction rather than by
 * luck) and set the annotation to 1300, which promotes it into the top-five
 * conditional bucket and moves this derivation with it. The trade is a
 * knowingly larger budget for a corpus with no unbounded members left in it —
 * `guard-feedback-shape.test.ts`'s classification receipt is what keeps that
 * true.
 *
 * **Why it went UP again, 5956 -> 6156 (mt#3121).** `inject-dispatch-watchdog`
 * gained a `contested` status branch, raising its measured worst case (and its
 * annotation) 1550 -> 1750. It is the heaviest conditional detector, so it sits in
 * the top-five bucket this derivation sums — the budget moves with it, +200.
 */
export const MERGED_CONTEXT_BUDGET_CHARS = 6156;

/** Separator between merged fragments — preserved from the pre-mt#3394 join. */
const FRAGMENT_SEPARATOR = "\n\n";

/**
 * Merge guard fragments into the single `additionalContext` string.
 *
 * Ordering: priority DESC, registry order within equal priority. `Array.sort`
 * is specified stable (ES2019), so equal-priority fragments cannot be
 * reshuffled — that is what keeps the unannotated case byte-identical to the
 * previous `fragments.join("\n\n")`.
 *
 * Budget: the rendered block — INCLUDING the omission notice — stays within
 * `budgetChars`, with exactly one documented exception: when the budget cannot
 * fit even the single highest-priority fragment plus its notice, the block
 * overshoots rather than truncating. Truncating the most important reminder to
 * satisfy a budget would invert the whole point. Anything dropped is named in
 * the trailing notice, so a reader never silently receives a partial block.
 * Both the in-budget case and the floor-overshoot case are pinned by tests.
 *
 * Pure — no I/O, no clock — so the dispatcher's merge policy is unit-testable
 * without standing up a registry or a transcript.
 *
 * Returns `undefined` when there is nothing to emit, which the caller treats
 * as "write no additionalContext key at all".
 */
export function composeAdditionalContext(
  fragments: ContextFragment[],
  budgetChars: number = MERGED_CONTEXT_BUDGET_CHARS
): string | undefined {
  if (fragments.length === 0) return undefined;

  // Index-decorated sort rather than relying on `Array.prototype.sort` being
  // stable (PR #2476 R1). ES2019 does specify stability and Bun honours it, but
  // the ordering guarantee this function advertises should not be inherited
  // from an engine promise a reader has to go look up — the explicit index
  // tiebreak makes equal-priority-keeps-registry-order true by construction.
  const ordered = fragments
    .map((fragment, index) => ({ fragment, index }))
    .sort((a, b) => b.fragment.priority - a.fragment.priority || a.index - b.index)
    .map((entry) => entry.fragment);

  // Admit a PREFIX of the priority-ordered list, shrinking until the rendered
  // block fits. Iteration is required rather than a running char total: the
  // omission notice names each dropped guard, so its own length depends on how
  // many were dropped, and a block that computed the body against the budget
  // then appended the notice on top could exceed the very cap it claims to
  // enforce (PR #2476 R1 — the notice was unbudgeted).
  //
  // A prefix (rather than a greedy best-fit) is also the semantics the field
  // advertises: never skip a higher-priority fragment in order to squeeze in a
  // lower-priority one that happens to be smaller.
  let admittedCount = ordered.length;
  let rendered = renderMergedBlock(ordered, admittedCount, budgetChars);
  while (admittedCount > 1 && rendered.length > budgetChars) {
    admittedCount -= 1;
    rendered = renderMergedBlock(ordered, admittedCount, budgetChars);
  }
  return rendered;
}

/**
 * Render the first `admittedCount` fragments as the merged block, appending the
 * omission notice when anything was left out.
 *
 * The floor is one fragment: the highest-priority fragment is always emitted
 * intact, even when it alone exceeds the budget. Truncating the most important
 * reminder to satisfy a budget would invert the point of having priorities, so
 * in that case the block deliberately overshoots and the notice says so.
 */
function renderMergedBlock(
  ordered: ContextFragment[],
  admittedCount: number,
  budgetChars: number
): string {
  const admitted = ordered.slice(0, admittedCount);
  const dropped = ordered.slice(admittedCount);
  const body = admitted.map((f) => f.text).join(FRAGMENT_SEPARATOR);
  if (dropped.length === 0) return body;

  const names = dropped.map((f) => f.guardName).join(", ");
  return `${body}${FRAGMENT_SEPARATOR}[dispatcher] ${dropped.length} lower-priority reminder(s) omitted to stay within the ${budgetChars}-char context budget: ${names}. Each still wrote its own calibration record.`;
}

/**
 * Core dispatcher loop (D1). Reads stdin ONCE, resolves shared context ONCE
 * (D6), filters the registry to guards matching `event` + `tool_name`, and
 * runs each matched guard's pure function in sequence — mirroring
 * `PreCommitHook.run()`'s step-by-step shape:
 *
 *   1. Check the unified override (D3) before invoking the guard; on a hit,
 *      emit the audit line and skip the guard entirely (it never runs).
 *   2. Invoke the guard's `run()`. A thrown error is caught, logged to
 *      stderr, and treated as "no outcome" — one guard failing must never
 *      disable the rest (fail-open per guard).
 *   3. `denyCapable` guards short-circuit the loop on the first `deny` (D1's
 *      first-deny-wins ordering — now an explicit registry-order property).
 *   4. `additionalContext` fragments from every guard are merged by
 *      `composeAdditionalContext` (priority order, then registry order within
 *      a priority, bounded by a char budget) into a single consolidated
 *      `HookOutput`, written only if at least one guard contributed content
 *      — a matched-but-silent guard produces no stdout, matching today's
 *      "write nothing on allow" convention.
 *   5. mt#2597 (evaluation-loop Phase 1): every matched guard's outcome is
 *      fire-logged exactly once — override-suppressed, thrown, denied,
 *      additionalContext-only, or silently allowed all produce a record.
 *      This is the "success half" of the enforcement corpus's observability
 *      (guard-health.ts / mt#2812 already covers the failure/crash half);
 *      recording happens AFTER the guard's outcome is known but BEFORE any
 *      early-continue, so a "matched but produced nothing" silent-allow is
 *      captured too, per the RFC's fire-log schema.
 */
export async function runDispatcher(
  event: LifecycleEvent,
  options: RunDispatcherOptions
): Promise<void> {
  const registrations = options.registrations ?? GUARD_REGISTRY;
  const readInputFn = options.readInputFn ?? (() => readInput<ToolHookInput>());
  const writeOutputFn = options.writeOutputFn ?? writeOutput;
  const stderrWrite = options.stderrWrite ?? ((s: string) => process.stderr.write(s));
  const logCalibration = options.logCalibrationRecordFn ?? logCalibrationRecord;
  const resolveContext =
    options.resolveDispatchContextFn ??
    ((evt, input, opts) => resolveDispatchContext(evt, input, opts));
  const recordError = options.recordGuardErrorFn ?? recordGuardError;
  const recordFireLog = options.recordFireLogFn ?? recordFireLogEntry;
  const nowMs = options.nowMsFn ?? Date.now;

  const input = await readInputFn();
  const matched = getGuardsForEvent(registrations, event, input.tool_name);
  if (matched.length === 0) return;

  const ctx = resolveContext(event, input, { hookFilename: options.hookFilename });

  const knownGuardNames = registrations.map((r) => r.name);
  const contextFragments: ContextFragment[] = [];
  let sessionTitle: string | undefined;
  // mt#3612: first-in-registry-order wins for `updatedInput`. `keptBy` records
  // WHICH guard won so a later guard's discarded rewrite can name it.
  let updatedInput: Record<string, unknown> | undefined;
  let updatedInputKeptBy: string | undefined;
  for (const reg of matched) {
    const evalStartMs = nowMs();
    const override = checkOverride(reg.name, process.env, { knownGuardNames, stderrWrite });
    if (override.overridden) {
      // STDERR (mt#3625). This used to go to stdout, ahead of the dispatch's
      // JSON — which meant overriding THIS guard silently voided a LATER
      // guard's deny, because Claude Code drops a PreToolUse hook's whole
      // output when stdout holds anything but the one JSON object. Live on the
      // shared `Bash|mcp__minsky__session_exec` matcher, where an override of
      // check-guessed-session-path disabled block-secret-file-read's deny.
      stderrWrite(
        buildOverrideAuditLine(event, reg.name, input.session_id, undefined, override.grantReason)
      );
      // mt#2597 R1 fix: attribute the fire-log record to whichever channel
      // actually decided (env vs grant-file) and classify grant-channel
      // overrides as authorized_exception — see buildOverrideFireLogFields's
      // doc comment for the full rationale.
      const { overrideSource, overrideEnvVar, overrideClassification } =
        buildOverrideFireLogFields(override);
      recordFireLog({
        guardName: reg.name,
        event,
        decision: "allow",
        durationMs: nowMs() - evalStartMs,
        overrideEnvVar,
        overrideSource,
        overrideClassification,
        toolName: input.tool_name,
        sessionId: input.session_id,
      });
      continue;
    }

    let outcome: GuardRunResult;
    try {
      const mod = await reg.module();
      outcome = await mod.run(input, ctx);
    } catch (err) {
      stderrWrite(
        `[dispatcher:${event}] guard=${reg.name} threw: ${err instanceof Error ? err.message : String(err)}\n`
      );
      // mt#2812: capture the crash for guard-health aggregation, in addition
      // to the stderr line above. Best-effort — recordGuardError never
      // throws, so a broken guard-health log can never disable a guard or
      // block the dispatcher loop.
      recordError({
        guardName: reg.name,
        event,
        error: err,
        toolName: input.tool_name,
        sessionId: input.session_id,
      });
      // mt#2597: a thrown guard fails OPEN (the operation proceeds as if
      // allowed) — record that outcome on the fire-log's "success half" too,
      // so override-rate/attention-cost aggregation over this guard isn't
      // silently missing every crashed evaluation. guard-health.ts already
      // owns the FAILURE-half record above; this is the complementary
      // decision-outcome record.
      recordFireLog({
        guardName: reg.name,
        event,
        decision: "allow",
        durationMs: nowMs() - evalStartMs,
        toolName: input.tool_name,
        sessionId: input.session_id,
      });
      continue;
    }

    const decision: FireLogDecision = outcome?.deny
      ? "deny"
      : outcome?.additionalContext
        ? "warn"
        : "allow";
    recordFireLog({
      guardName: reg.name,
      event,
      decision,
      durationMs: nowMs() - evalStartMs,
      toolName: input.tool_name,
      sessionId: input.session_id,
    });

    if (!outcome) continue;

    // STDERR (mt#3625) — same reason as the override line above. A guard's
    // audit line is a diagnostic; stdout belongs to the single JSON object.
    for (const line of outcome.auditLines ?? []) stderrWrite(line);
    // mt#3519: a registration may declare several logs. The dispatcher writes
    // the one record it has to the PRIMARY log — the first declared — never to
    // all of them, which would duplicate the record across logs and inflate
    // every fire count downstream. Additional entries name logs the guard
    // writes ITSELF (e.g. through a module it calls in-process); they exist so
    // the coverage-receipt join can find the guard's invocations, not so the
    // dispatcher can write to them.
    //
    // Gated on the RESOLVED primary rather than on `reg.calibrationLog` (PR
    // #2543 R1): the declaration is truthy for `[]` too, so gating on it would
    // enter this branch and then write nothing. The type forbids `[]`, and
    // this gate means a hand-authored one still cannot produce a silent skip.
    const primaryLog = Array.isArray(reg.calibrationLog)
      ? reg.calibrationLog[0]
      : reg.calibrationLog;
    if (outcome.calibration && primaryLog) {
      logCalibration(primaryLog, outcome.calibration);
    }
    if (outcome.deny && reg.denyCapable) {
      writeOutputFn({
        hookSpecificOutput: {
          hookEventName: event,
          permissionDecision: "deny",
          permissionDecisionReason: outcome.deny.reason,
        },
      });
      return;
    }
    if (outcome.additionalContext) {
      contextFragments.push({
        guardName: reg.name,
        priority: reg.contextPriority ?? DEFAULT_CONTEXT_PRIORITY,
        text: outcome.additionalContext,
      });
    }
    if (outcome.sessionTitle !== undefined) sessionTitle = outcome.sessionTitle;
    // mt#3612: first-in-registry-order wins. A second rewrite cannot be merged
    // with the first (each guard builds its object from the ORIGINAL input, so
    // a merge would resurrect fields the first guard deliberately changed), so
    // it is dropped — but named, never silently.
    if (outcome.updatedInput !== undefined) {
      if (updatedInput === undefined) {
        updatedInput = outcome.updatedInput;
        updatedInputKeptBy = reg.name;
      } else {
        // STDERR, not stdout. Claude Code discards a PreToolUse hook's ENTIRE
        // output when stdout carries anything besides the one JSON object
        // (ADR-028 D1's "exactly one JSON object", confirmed live in PR #2573:
        // an identical run with one junk stdout line ahead of the JSON executed
        // the ORIGINAL command instead of the rewrite). Writing this line to
        // stdout would therefore void the winning guard's rewrite in precisely
        // the multi-guard case the line exists to make visible.
        stderrWrite(
          buildDiscardedRewriteAuditLine(
            event,
            reg.name,
            updatedInputKeptBy ?? "unknown",
            input.session_id
          )
        );
      }
    }
  }

  const additionalContext = composeAdditionalContext(contextFragments);
  if (additionalContext !== undefined || sessionTitle !== undefined || updatedInput !== undefined) {
    writeOutputFn({
      hookSpecificOutput: {
        hookEventName: event,
        ...(additionalContext !== undefined ? { additionalContext } : {}),
        ...(sessionTitle !== undefined ? { sessionTitle } : {}),
        ...(updatedInput !== undefined ? { updatedInput } : {}),
      },
    });
  }
}
