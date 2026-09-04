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
// `./registry` (all sibling files in this same hooks tree). The dispatcher does
// not need `packages/domain`, so it does not import it — a fact about this file,
// not a rule: mt#4373 retired the SPEC.md invariant that forbade it. Individual
// guards the dispatcher loads may import domain freely — EXCEPT the tier-2
// observability baseline (`record-conversation-run-state.ts`,
// `transcript-ingest-on-session-end.ts`, `types.ts`), which must stay
// node-stdlib-only per SPEC.md because it runs from an arbitrary install path.
// That carve-out survives the reversal and is enforced by
// `self-containment.test.ts`.
//
// @see docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md
// @see mt#2650 — this framework's tracking task (ADR-028 Phase 1)
// @see .minsky/hooks/registry.ts — the declarative registry this loop consumes
// @see .minsky/hooks/dispatch-pretooluse.ts — the PreToolUse pilot entrypoint
// @see .claude/hooks/block-subagent-bypass-merge.ts — the audit-line convention (non-JSON stdout)

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { getMinskyStateDir } from "@minsky/shared/paths";
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
 * Derive a stable, filesystem-safe key for a repo root so calibration/
 * evaluation streams from DIFFERENT Minsky-managed projects never collide in
 * the shared, machine-local state dir (mt#4748 SC1). Deterministic sha256
 * over the resolved absolute path — the same shape VS Code's
 * `workspaceStorage` keying uses, for the same reason.
 *
 * Duplicated (not imported) in
 * `packages/domain/src/guard-events/ingest-runtime.ts` — the sweep that
 * reads these files back for DB ingest, which must derive the identical key
 * from the identical `repoRoot` to ever find what this file wrote. Each
 * module tree stays free of a dependency on the other by convention (mirrors
 * why `fire-log.ts` and `guard-health.ts` each carry their own
 * `getXStateDir` rather than sharing one); this function's whole contract is
 * "same input -> same output", which a 3-line pure function duplicated
 * twice satisfies exactly as well as a shared import would.
 */
export function projectStateKey(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
}

/**
 * Resolve the JSONL path for a calibration-log name, preserving the EXACT
 * filenames `CALIBRATION_LOG_REGISTRY`
 * (`src/domain/calibration/calibration-sweep.ts`) already expects — e.g.
 * `"causal-premise"` -> `<state dir>/projects/<key>/causal-premise-calibration.jsonl`.
 * No changes are needed to that registry when a guard migrates onto this
 * service (per the task's "read it; do not change it" constraint).
 *
 * mt#4748 (SC1): rooted on `getMinskyStateDir()`, NOT the repo, and keyed by
 * project via {@link projectStateKey} — before this, EVERY Minsky-managed
 * project's working tree received this file, and only THIS repo's own
 * `.gitignore` (retired by SC6) ever ignored it. `root` (whichever of
 * `projectDir` / `CLAUDE_PROJECT_DIR` / `fallbackCwd` / `process.cwd()`
 * resolved) is still passed through `findRepoRoot` first — the repo root is
 * no longer where the file LIVES, but it is still what makes the project KEY
 * stable across the many different cwds (a repo subdirectory, a session
 * workspace) a hook subprocess can be invoked from (mt#2710's original
 * rationale for this same `findRepoRoot` call, preserved here). `findRepoRoot`
 * degrades to its input unchanged when no `.git` is found up the tree (e.g.
 * the synthetic `/repo`-style paths this module's own tests use).
 *
 * **`projectDir` and `fallbackCwd` are NOT interchangeable (mt#4752).** This
 * mirrors `evaluationLogPath`'s split, added by mt#3745 for the same reason and
 * omitted here only because no calibration caller needed it at the time.
 * `projectDir` is an ALREADY-RESOLVED authoritative directory and outranks
 * everything; `fallbackCwd` is a guard's raw `input.cwd`, which is routinely a
 * session workspace or a repo subdirectory, so it ranks BELOW
 * `CLAUDE_PROJECT_DIR`.
 *
 * The migrating writers are why the parameter exists: each hand-rolled
 * `resolve(findRepoRoot(input.cwd), <literal>)`, which silently treats the raw
 * cwd as authoritative. Passing that cwd as `projectDir` would preserve the
 * bug through the migration — the whole point is that it lands in the lower
 * tier.
 */
export function calibrationLogPath(
  calibrationLogName: string,
  options?: { projectDir?: string; fallbackCwd?: string }
): string {
  const root =
    options?.projectDir ??
    process.env["CLAUDE_PROJECT_DIR"] ??
    options?.fallbackCwd ??
    process.cwd();
  const repoRoot = findRepoRoot(root);
  return join(
    getMinskyStateDir(),
    "projects",
    projectStateKey(repoRoot),
    `${calibrationLogName}-calibration.jsonl`
  );
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
  options?: { projectDir?: string; fallbackCwd?: string; deps?: CalibrationWriteDeps }
): void {
  try {
    const deps = options?.deps ?? defaultCalibrationDeps;
    const logPath = calibrationLogPath(calibrationLogName, {
      ...(options?.projectDir !== undefined ? { projectDir: options.projectDir } : {}),
      ...(options?.fallbackCwd !== undefined ? { fallbackCwd: options.fallbackCwd } : {}),
    });
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
 *
 * mt#4748 (SC1): rooted on `getMinskyStateDir()`, project-keyed via
 * {@link projectStateKey} — same move as `calibrationLogPath` above, same
 * reason (this was the other half of every managed project's working-tree
 * landmine; see that function's docblock for the full rationale).
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
  const repoRoot = findRepoRoot(root);
  return join(
    getMinskyStateDir(),
    "projects",
    projectStateKey(repoRoot),
    `${evaluationLogName}-evaluations.jsonl`
  );
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
  /**
   * Records a PreToolUse guard denial into the 2-strikes stream (mt#3802).
   *
   * Injected rather than imported so this module keeps its no-`packages/domain`
   * invariant; the entrypoint supplies the real recorder.
   */
  recordGuardDenialFn?: (denial: {
    sessionId?: string;
    toolName: string;
    guardName: string;
    reason: unknown;
    toolInput: unknown;
  }) => void;
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
 *
 * **Why it went UP a third time, 6156 -> 7206 (mt#3533).** `operator-deferral-detector`
 * was annotated 600 and its saturated render measures **1609** — a correction of
 * an understatement, not a growth in what it emits. Two thirds of the gap
 * predates the change that found it: the guard's TWO-prose-match worst case
 * already measured 1049 before mt#3533 added a fourth surface. It went unseen
 * because `guard-feedback-shape.test.ts` measures a guard's live
 * `additionalContext`, and a calibration-first guard (`INJECTION_ENABLED =
 * false`) returns none — so its ceiling has been enforced against an empty
 * string since it shipped. That blind spot is **mt#4002**; until it closes,
 * `operator-deferral-detector.test.ts` pins this guard's render directly.
 *
 * The annotation is now 1650 and the top-five sum moves 4950 -> 6000, so the
 * budget moves by exactly the same +1050. This is the mt#3705 pattern again:
 * not a bigger budget for the same corpus, but the same corpus with one member
 * finally counted.
 *
 * **And why it came straight back DOWN, 7206 -> 6156 (mt#4002).** The move above
 * was the wrong half of a correct diagnosis. The annotation WAS understated — so
 * were four others, by up to 3.6x, none of them visible because
 * `guard-feedback-shape.test.ts` measures a guard's live `additionalContext` and
 * a calibration-first guard emits none. But a guard whose `INJECTION_ENABLED` is
 * false contributes ZERO chars to any turn, so putting it in the top-five bucket
 * models a turn that cannot occur and sizes a shared per-turn budget for text
 * that is never sent. mt#3997 faced the identical choice hours earlier and took
 * the other branch, trimming its guard rather than growing this number.
 *
 * The bucket now excludes any guard declaring `renderProbe` — the marker for
 * renders-but-does-not-inject — so it holds the five heaviest guards that
 * ACTUALLY inject: dispatch-watchdog 1750, guard-health 1300, substrate-bypass
 * 650, pre-narration 650, code-mechanism-assertion 600 = 4950, plus the 1190
 * always-on floor and 16 chars of separators. That the total lands back on
 * exactly the pre-mt#3533 number is arithmetic, not coincidence: the same five
 * injecting guards were always the real bucket.
 *
 * **And DOWN again, 6156 -> 6106 (mt#4286), for the reason the paragraph below
 * anticipated — read in the other direction.** `pre-narration` was quieted to
 * log-only per ask#9219 and now declares a `renderProbe`, so the exclusion rule
 * above drops it out of the bucket. The fifth slot goes to the next-heaviest
 * ACTUAL injector, `ask-routing-deferral` at 600 (it was already tied with
 * `code-mechanism-assertion`), so the top five become dispatch-watchdog 1750,
 * guard-health 1300, substrate-bypass 650, code-mechanism-assertion 600,
 * ask-routing-deferral 600 = 4900, plus the same 1190 floor and 16 separators.
 *
 * **The re-entry cost is 1753, NOT the 650 named above.** `pre-narration`'s
 * declared annotation was measured against its ONE-match canary; its `renderProbe`
 * measures the saturated render — 4 categories, each phrase at the 200-char cap —
 * at 1753, and the annotation was corrected to 1800. So if that guard is ever
 * un-quieted, this bucket does not simply revert to 6156: it becomes
 * 1190 + (1750 + 1753 + 1300 + 650 + 600) + 16. Re-derive rather than reverting.
 *
 * **This constant is HAND-SET, and the exclusion above describes the DERIVATION,
 * not a computation performed here (PR #2889 R2).** Nothing reads `renderProbe`
 * at runtime to size the budget; the filter lives in `dispatcher.test.ts`, which
 * asserts that the modelled turn fits this number. That split is deliberate and
 * predates this change — the constant is meant to trend DOWN as guard text is
 * trimmed, which an auto-sum would silently prevent (mt#3796 records the same
 * reasoning, and explicitly rules auto-computation out of scope). The practical
 * consequence for an editor: changing a top-five annotation does NOT move this
 * number by itself. Re-derive it and edit it here, then run
 * `dispatcher.test.ts` — the pre-commit gated runner excludes `.minsky/hooks/**`
 * and will not catch the mismatch locally.
 *
 * A guard re-enters the bucket the day its posture flips and its `renderProbe`
 * is deleted — at which point this number must be re-derived by hand again.
 *
 * **And UP, 6106 -> 6627 (mt#4234), because a bucket member's annotation was
 * never a ceiling.** No guard entered or left this time — `ask-routing-deferral`
 * was already the fifth slot per the paragraph above. What changed is its
 * declared size, 600 -> 1121, and the paragraph above is exactly why that number
 * was wrong: it was measured against a canary posing ONE match when the guard
 * renders a directive per CLASS and both classes are reachable from one message.
 * Worse, its rendered evidence line interpolated `m[0]` — a regex span bounded
 * only by the next sentence terminator in the agent's own prose — so the render
 * grew 1:1 with what the agent wrote and had no finite worst case at all: 2350
 * chars from a single run-on sentence, against a declared 600.
 *
 * So this is NOT the mt#3533 shape (a bigger budget for text that is never
 * sent), and it is not the mt#3705 shape (a member finally counted) either. It
 * is a member whose declared size was a SAMPLE the whole time. The guard now
 * caps its rendered phrase and poses a `worstCaseCanary` that saturates both
 * classes at once, so 1121 is a measurement: the top five become
 * dispatch-watchdog 1750, guard-health 1300, ask-routing-deferral 1121,
 * substrate-bypass 650, code-mechanism-assertion 600 = 5421, plus the same 1190
 * floor and 16 separators.
 *
 * The cheaper alternative — trimming that guard's two directive paragraphs
 * instead — was considered and declined at its own site; its 879-char two-class
 * body is the floor no phrase cap can lower, and the reasoning is recorded in
 * `registry-prompt-scan-guards.ts` beside the annotation rather than here.
 */
export const MERGED_CONTEXT_BUDGET_CHARS = 6627;

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
// ---------------------------------------------------------------------------
// Per-guard deadlines (mt#3757)
// ---------------------------------------------------------------------------

/**
 * Priority for the notice a hard-deadline skip contributes to the merged block.
 *
 * Above {@link DEFAULT_CONTEXT_PRIORITY} deliberately. Every other fragment
 * says something a guard DECIDED; this one says a guard's verdict is MISSING,
 * and a reader who does not learn that will read the turn's silence as an
 * all-clear. If the budget forces a drop, dropping the notice that explains a
 * gap in favour of the reminders that survived inverts the point.
 */
export const DEADLINE_NOTICE_PRIORITY = 100;

/** Injectable timer seam, so a test need not wait real wall-clock time. */
export interface DeadlineTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const REAL_TIMERS: DeadlineTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type DeadlineResult<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * Await `work`, giving up after `deadlineMs`.
 *
 * WHAT THIS DOES NOT DO, because the difference decides which failures it can
 * bound at all: it does not CANCEL. `Promise.race` has no such power — the
 * losing promise keeps running in this process until it settles or the process
 * exits. The dispatcher stops WAITING on a guard; it does not stop the guard.
 *
 * And it cannot bound a SYNCHRONOUS hang. A guard that spins without yielding
 * blocks the event loop, so the timer below never gets to fire and the host cap
 * kills the whole process exactly as it does today. What it does bound is an
 * ASYNC hang — an awaited DB connect, fetch, or subprocess that never settles —
 * which is the case this task was filed for. Both limits are enumerated in
 * mt#3757's `### Does NOT cover`; bounding the synchronous case needs subprocess
 * isolation and is explicitly out of scope.
 *
 * The timer is ALWAYS cleared, including on the fast path. A pending
 * `setTimeout` keeps the runtime alive, so leaking one here would delay the exit
 * of every hook process by up to its slowest guard's deadline.
 */
export async function runWithDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  timers: DeadlineTimers = REAL_TIMERS
): Promise<DeadlineResult<T>> {
  let handle: unknown;
  try {
    return await Promise.race<DeadlineResult<T>>([
      work.then((value) => ({ timedOut: false as const, value })),
      new Promise<DeadlineResult<T>>((resolve) => {
        handle = timers.setTimeout(() => resolve({ timedOut: true }), deadlineMs);
      }),
    ]);
  } finally {
    if (handle !== undefined) timers.clearTimeout(handle);
  }
}

/**
 * The deadline a guard is actually cut off at: its own declared budget plus
 * whatever earlier guards on this event left unspent.
 *
 * Why slack rather than a flat per-guard cut, measured (mt#3757): the 25
 * `UserPromptSubmit` guards declare 210s in total — which IS settings.json's
 * derived 215s cap — while nearly all of them return in under 2s. Ten of 56
 * registered guards have ALREADY exceeded their declared budget in production,
 * `memory-search` on 25 of 35 active days with a 132s maximum against a 10s
 * declaration. A flat cut at the declared value would newly kill memory
 * injection on 1-2% of turns in the quiet regime and 10-35% on its worst days.
 * The slack is real, large, and is what lets a legitimately slow guard finish
 * today without starving anyone — so it is what the deadline is built on.
 *
 * BOUNDED BY THE EVENT'S REMAINING HOST BUDGET (PR #3213 R1). Slack alone is a
 * claim about what the guards LEFT; it says nothing about what the HOST will
 * still wait for. Without the cap a late guard could be handed
 * `declared + slack` with only a fraction of that left before Claude Code
 * SIGKILLs the process — reintroducing, at the tail of the event, exactly the
 * silent total loss this task exists to end. Capping converts that into a
 * NAMED skip: the guards that already answered are still delivered, and the one
 * that could not fit says so.
 *
 * The cap can drive the deadline to zero when the budget is spent, and that is
 * the intended terminal behaviour rather than an edge case to soften — a guard
 * skipped with a notice is strictly better than a process killed without one.
 */
export function computeHardDeadlineMs(
  declaredMs: number,
  slackMs: number,
  remainingHostBudgetMs: number = Number.POSITIVE_INFINITY
): number {
  return Math.max(0, Math.min(declaredMs + Math.max(0, slackMs), remainingHostBudgetMs));
}

/**
 * Slack after a guard has run: unspent budget accrues, overrun draws it down.
 *
 * Clamped at zero. It cannot go negative while the caller respects the deadline
 * — a guard admitted at `declared + slack` can overdraw by at most `slack` —
 * but the clamp keeps that an invariant of THIS function rather than of its
 * caller, so a future call site cannot silently create negative slack and hand
 * a later guard a deadline shorter than its own declared budget.
 */
export function nextSlackMs(slackMs: number, declaredMs: number, durationMs: number): number {
  return Math.max(0, slackMs + (declaredMs - durationMs));
}

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
  // Defaults to a no-op because this module may not reach the tracker (see the
  // deny branch). `dispatch-pretooluse.ts` supplies the real one — and
  // `dispatcher-guard-denial.test.ts` asserts that it does, so the wiring
  // cannot silently regress to the no-op.
  const recordGuardDenialFn = options.recordGuardDenialFn ?? (() => {});
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
  // mt#3757: budget left unspent by the guards that already ran on this event.
  // Guards run SERIALLY, so an earlier guard finishing under its declaration
  // genuinely frees that time for a later one — see computeHardDeadlineMs.
  let slackMs = 0;
  // mt#3757 / PR #3213 R1: the wall-clock the EVENT has consumed, against the
  // budget derived from the host cap. `ctx.budgets.overallBudgetMs` is
  // deriveBudgets()'s share of `hostCapSec` — the same figure every standalone
  // hook already sizes itself against. A context without it (a test stub that
  // omits `budgets`) leaves the deadline unbounded by the host, which is the
  // pre-R1 behaviour and is safe: the cap only ever SHORTENS a deadline.
  const dispatchStartMs = nowMs();
  const hostBudgetMs = ctx.budgets?.overallBudgetMs ?? Number.POSITIVE_INFINITY;
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
      // mt#3892: `guardOutcome` is deliberately UNSET here, and that is neither
      // value. An overridden guard did not run at all, so this record is
      // evidence of neither a clean decision nor a crash — leaving it unset
      // keeps it out of the recovery join, which is correct: an override says
      // nothing about whether the guard would have worked.
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
      // mt#3757: an overridden guard did not run, so its whole declared budget
      // is unspent and accrues to the guards behind it.
      slackMs = nextSlackMs(slackMs, reg.timeoutMs, nowMs() - evalStartMs);
      continue;
    }

    const declaredMs = reg.timeoutMs;
    const remainingHostBudgetMs = Math.max(0, hostBudgetMs - (nowMs() - dispatchStartMs));
    const hardDeadlineMs = computeHardDeadlineMs(declaredMs, slackMs, remainingHostBudgetMs);
    // Set on the success path when the guard crossed its SOFT budget; threaded
    // to the fire-log record below so a slow-but-correct guard is visible
    // without being reclassified away from `decided`.
    let budgetExceededMs: number | undefined;

    let outcome: GuardRunResult;
    try {
      // The module LOAD is inside the deadline too, not just `run()`. A guard
      // whose dynamic import hangs costs the turn exactly as much as one whose
      // body hangs, and bounding only the half after the import would leave the
      // cold path — the one that actually touches the filesystem — unbounded.
      const raced = await runWithDeadline(
        (async () => {
          const mod = await reg.module();
          return await mod.run(input, ctx);
        })(),
        hardDeadlineMs
      );

      if (raced.timedOut) {
        const durationMs = nowMs() - evalStartMs;
        stderrWrite(
          `[dispatcher:${event}] guard=${reg.name} exceeded its ${hardDeadlineMs}ms deadline ` +
            `(declared ${declaredMs}ms + ${slackMs}ms slack) and was SKIPPED\n`
        );
        // Guard-health's FAILURE half, same call the crash branch below makes.
        // A guard that never answers is unhealthy in the sense that tracker
        // measures — the streak is the point — so it is recorded, not merely
        // logged. `recordError` never throws (mt#2812).
        recordError({
          guardName: reg.name,
          event,
          error: new Error(
            `guard exceeded its ${hardDeadlineMs}ms hard deadline and was skipped (mt#3757)`
          ),
          toolName: input.tool_name,
          sessionId: input.session_id,
        });
        recordFireLog({
          guardName: reg.name,
          event,
          decision: "allow",
          guardOutcome: "deadline-skipped",
          durationMs,
          // budgetExceededMs is deliberately ABSENT here (PR #3213 R3). Its
          // documented meaning is "crossed the declared budget and FINISHED
          // ANYWAY" — the soft signal. A skipped guard did not finish, so
          // setting it here contradicted the schema this PR itself wrote, and
          // made the field ambiguous at every reader: present would have meant
          // either "slow but fine" or "cut off". `guardOutcome` already carries
          // the skip, and `durationMs` already carries what it cost.
          toolName: input.tool_name,
          sessionId: input.session_id,
        });
        // NAMED, never silent — the same contract renderMergedBlock's omission
        // notice keeps. A skipped guard's silence is otherwise indistinguishable
        // from a guard that ran and had nothing to say.
        contextFragments.push({
          guardName: reg.name,
          priority: DEADLINE_NOTICE_PRIORITY,
          text:
            `[dispatcher] guard \`${reg.name}\` exceeded its ${hardDeadlineMs}ms deadline and was ` +
            `skipped. Its verdict is MISSING from this turn — absent because it never answered, ` +
            `not because it had nothing to say.`,
        });
        // It consumed the whole pool, so nothing is left for the guards behind
        // it. Not merely `nextSlackMs(...)`: that would clamp to 0 anyway here,
        // but stating it makes the intent legible rather than incidental.
        slackMs = 0;
        continue;
      }

      outcome = raced.value;
      const durationMs = nowMs() - evalStartMs;
      if (durationMs > declaredMs) budgetExceededMs = declaredMs;
      slackMs = nextSlackMs(slackMs, declaredMs, durationMs);
    } catch (err) {
      // mt#3757: a crashed guard still consumed real time; account for it so a
      // guard that throws slowly does not hand its unspent budget onward.
      slackMs = nextSlackMs(slackMs, declaredMs, nowMs() - evalStartMs);
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
      //
      // mt#3892: marked `crashed` so a reader can tell this `allow` apart from
      // one the guard actually decided. Without the marker the two are
      // indistinguishable, and guard-health's recovery join would read a
      // continuously crashing guard as recovered — this record is written
      // microseconds AFTER the recordError() above, so "an invocation later
      // than the last failure" is true on every single crash.
      recordFireLog({
        guardName: reg.name,
        event,
        decision: "allow",
        guardOutcome: "crashed",
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
      // mt#3892: the guard returned an outcome, so this record is evidence the
      // guard ran cleanly — the only kind guard-health's recovery join counts.
      guardOutcome: "decided",
      durationMs: nowMs() - evalStartMs,
      // mt#3757: present ONLY when the guard crossed its declared budget and
      // finished anyway. It stays `decided` on purpose — see
      // {@link FireLogEntry.budgetExceededMs} for why an overrun is a fact
      // about cost rather than a different outcome.
      ...(budgetExceededMs !== undefined ? { budgetExceededMs } : {}),
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
      // mt#3802: the 2-strikes tracker was registered PostToolUse only, and a
      // denial means the tool never runs — so the class an agent is MOST likely
      // to retry blindly was the one class nothing was watching. Recorded here,
      // once, on the dispatcher's single deny branch, per ADR-028: a
      // cross-cutting concern belongs to the dispatcher rather than to each of
      // the denying guards.
      //
      // INJECTED, not imported: the tracker lives in `packages/domain`, and
      // this file's own invariant is that it imports only siblings. The real
      // recorder is wired at the entrypoint (`dispatch-pretooluse.ts`), which
      // is allowed to reach the domain — same shape as `recordFireLogFn`.
      // The recorder swallows its own failures (SC4); a tracker problem must
      // never change the decision this branch is about to emit.
      //
      // Wrapped HERE, not just inside the default recorder (PR #2770 R1). The
      // production recorder swallows its own failures, but that is a property
      // of the current INJECTION, not of this seam — the parameter takes an
      // arbitrary callback, and SC4's "a tracker failure never converts into a
      // denied or failed tool call" has to hold for every one of them.
      try {
        recordGuardDenialFn({
          sessionId: input.session_id,
          toolName: input.tool_name,
          guardName: reg.name,
          reason: outcome.deny.reason,
          toolInput: input.tool_input,
        });
      } catch (err) {
        stderrWrite(
          `[dispatcher] two-strikes denial recording failed (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }\n`
        );
      }
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
