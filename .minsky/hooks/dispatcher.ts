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
import { readInput, writeOutput, readHostCap, deriveBudgets } from "./types";
import type { ToolHookInput, HookOutput, HostCapInfo } from "./types";
import { parseTranscript, resolveTranscriptCandidates } from "./transcript";
import type { TranscriptLine } from "./transcript";
import { GUARD_REGISTRY, getGuardsForEvent } from "./registry";
import type {
  DispatchContext,
  GuardRegistration,
  GuardRunResult,
  LifecycleEvent,
} from "./registry";

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
}

/**
 * Check whether `guardName` is named in `MINSKY_HOOK_OVERRIDE` — one shared,
 * tested override predicate (D3), replacing each guard's bespoke inline
 * truthy-parsing.
 *
 * Matching is case-INSENSITIVE on both sides — `guardName` and every
 * comma-delimited env token are lowercased before comparison. Registry names
 * are canonical lowercase-hyphenated, but an operator typing
 * `MINSKY_HOOK_OVERRIDE=Check-Guessed-Session-Path` (or `ALL`) should still
 * suppress the guard rather than silently no-op. Whitespace around each
 * comma-delimited token is still trimmed.
 *
 * Any token that is neither `"all"` nor a known guard name (per
 * `options.knownGuardNames`, case-insensitively) triggers a stderr warning —
 * the typo-detection signal ("did the operator mean a guard that doesn't
 * exist?") without changing the override decision for THIS guard.
 */
export function checkOverride(
  guardName: string,
  env: NodeJS.ProcessEnv = process.env,
  options?: CheckOverrideOptions
): OverrideResult {
  const raw = env[HOOK_OVERRIDE_ENV_VAR];
  if (!raw) return { overridden: false };

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
  const overridden = namesLower.includes("all") || namesLower.includes(guardNameLower);
  return { overridden, raw };
}

/**
 * Build the D3 audit-line format:
 * `[dispatcher:<event>] OVERRIDE: guard=<name> session=<id> ts=<iso>` — a
 * non-JSON stdout line Claude Code's hook-output parser ignores, matching
 * the existing sibling-hook audit convention (documented in CLAUDE.md).
 * `now` is injectable so tests can assert an exact timestamp.
 */
export function buildOverrideAuditLine(
  event: LifecycleEvent,
  guardName: string,
  sessionId: string | undefined,
  now: () => string = () => new Date().toISOString()
): string {
  return `[dispatcher:${event}] OVERRIDE: guard=${guardName} session=${sessionId ?? "unknown"} ts=${now()}\n`;
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
 */
export function calibrationLogPath(calibrationLogName: string, projectDir?: string): string {
  const root = projectDir ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();
  return join(root, ".minsky", `${calibrationLogName}-calibration.jsonl`);
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
  input: Pick<ToolHookInput, "transcript_path" | "agent_id">,
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
    transcriptLines = transcriptCandidates.flatMap((p) => parse(p));
  }

  return {
    event,
    hostCapSec: hostCap.hostCapSec,
    budgets,
    transcriptCandidates,
    transcriptLines,
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
  /** Injectable for tests — defaults to `writeOutput` from `./types`. */
  writeOutputFn?: (output: HookOutput) => void;
  /** Injectable for tests — defaults to `process.stdout.write`. */
  stdoutWrite?: (s: string) => void;
  /** Injectable for tests — defaults to `process.stderr.write`. */
  stderrWrite?: (s: string) => void;
  /** Injectable for tests — defaults to the real `logCalibrationRecord`. */
  logCalibrationRecordFn?: (name: string, record: Record<string, unknown>) => void;
  /** Injectable for tests — defaults to the real `resolveDispatchContext`. */
  resolveDispatchContextFn?: (
    event: LifecycleEvent,
    input: Pick<ToolHookInput, "transcript_path" | "agent_id">,
    opts: { hookFilename: string }
  ) => DispatchContext;
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
 *   4. `additionalContext` fragments from every guard are concatenated
 *      (registry order, one paragraph per guard) into a single consolidated
 *      `HookOutput`, written only if at least one guard contributed content
 *      — a matched-but-silent guard produces no stdout, matching today's
 *      "write nothing on allow" convention.
 */
export async function runDispatcher(
  event: LifecycleEvent,
  options: RunDispatcherOptions
): Promise<void> {
  const registrations = options.registrations ?? GUARD_REGISTRY;
  const readInputFn = options.readInputFn ?? (() => readInput<ToolHookInput>());
  const writeOutputFn = options.writeOutputFn ?? writeOutput;
  const stdoutWrite = options.stdoutWrite ?? ((s: string) => process.stdout.write(s));
  const stderrWrite = options.stderrWrite ?? ((s: string) => process.stderr.write(s));
  const logCalibration = options.logCalibrationRecordFn ?? logCalibrationRecord;
  const resolveContext =
    options.resolveDispatchContextFn ??
    ((evt, input, opts) => resolveDispatchContext(evt, input, opts));

  const input = await readInputFn();
  const matched = getGuardsForEvent(registrations, event, input.tool_name);
  if (matched.length === 0) return;

  const ctx = resolveContext(event, input, { hookFilename: options.hookFilename });

  const knownGuardNames = registrations.map((r) => r.name);
  const contextFragments: string[] = [];
  for (const reg of matched) {
    const override = checkOverride(reg.name, process.env, { knownGuardNames, stderrWrite });
    if (override.overridden) {
      stdoutWrite(buildOverrideAuditLine(event, reg.name, input.session_id));
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
      continue;
    }
    if (!outcome) continue;

    for (const line of outcome.auditLines ?? []) stdoutWrite(line);
    if (outcome.calibration && reg.calibrationLog) {
      logCalibration(reg.calibrationLog, outcome.calibration);
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
    if (outcome.additionalContext) contextFragments.push(outcome.additionalContext);
  }

  if (contextFragments.length > 0) {
    writeOutputFn({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: contextFragments.join("\n\n"),
      },
    });
  }
}
