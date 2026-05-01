#!/usr/bin/env bun
// PostToolUse hook: 2-strikes mechanical tracker (mt#1484).
//
// Records every tool error via the TwoStrikesTracker. Default mode is
// "observation" — the tracker accumulates would-have-fired events but does
// NOT invoke the second-strike handler. Calibration data from observations
// drives the heuristic refinement before mt#1476 flips the mode to "live".
//
// State is per-session, persisted to:
//   ~/.local/state/minsky/two-strikes/<session-id>.json     (active streaks)
//   ~/.local/state/minsky/two-strikes/observations.jsonl    (would-have-fired log)
//
// Mode is read from the MINSKY_TWO_STRIKES_MODE env var (defaults to
// "observation"). To flip to "live" once calibration settles:
//
//   export MINSKY_TWO_STRIKES_MODE=live
//
// Hook input contract (Claude Code PostToolUse): see `.claude/hooks/types.ts`.
//
// Latency / ordering contract (PR #926 R2 BLOCKING fix):
//   - PostToolUse hooks ARE blocking: the harness waits for command exit
//     or timeout. This hook is short-running by design — in-memory tracker
//     work plus one or two small fs writes (per-session state ~1KB,
//     observations.jsonl append). No network IO. Configured timeout: 5s.
//   - Registered LAST in `.claude/settings.json` PostToolUse so the
//     existing typecheck-on-edit / validate-task-spec / post-merge-pull /
//     post-session-start hooks run first and aren't penalized by this
//     hook's latency.
//   - Matcher is narrowed to high-traffic tool kinds (Bash, Edit, Write,
//     Read, Grep, Glob, mcp__.*) rather than `.*` so cumulative cost is
//     bounded to tools whose errors actually carry the calibration signal.
//   - Exits 0 on every error path so a hook bug never propagates failure
//     to the agent (failure here means a missed observation, not a broken
//     tool call).

import os from "os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { readInput } from "./types";
import type { ToolHookInput } from "./types";
import {
  TwoStrikesTracker,
  type TrackerSnapshot,
  type TrackerMode,
} from "../../src/domain/two-strikes/tracker";

// ---------------------------------------------------------------------------
// Hook dependencies (injected for tests; defaults wire to fs/os/env)
// ---------------------------------------------------------------------------

/**
 * Filesystem subset the hook uses. Tests inject an in-memory implementation;
 * production wires through to `node:fs`. Defining this as a structural type
 * (not casts) per `feedback_no_test_only_casts`.
 */
export interface HookFs {
  exists(path: string): boolean;
  mkdirP(path: string): void;
  readText(path: string): string;
  writeText(path: string, contents: string): void;
  appendText(path: string, contents: string): void;
}

/** Dependencies bundle. */
export interface HookDeps {
  stateDir: string;
  mode: TrackerMode;
  fs: HookFs;
}

/**
 * Three-way classification of a PostToolUse tool_result:
 *   - `error`  — explicit error signal; we record it and may strike.
 *   - `success` — explicit success signal; we reset the tool's streak.
 *   - `unknown` — no signal either way (missing tool_result, no recognised
 *     fields). We do NOT modify the streak. This preserves "consecutive
 *     identical errors" semantics when the harness emits a PostToolUse
 *     event without a result payload — a missing payload is not a
 *     confirmed success and must not silently reset.
 */
export type ToolOutcome =
  | { kind: "error"; error: unknown }
  | { kind: "success" }
  | { kind: "unknown" };

/**
 * Heuristic error/success detection across tool kinds.
 *
 * Reset semantics (per PR #926 R1 BLOCKING fix): only emit `success` on a
 * positive success signal — Bash `exit_code === 0`, or generic
 * `is_error === false`. Anything else is `unknown` (no streak change).
 *
 * Calibration TODO (per mt#1484 §Implementation Choice): inspect the
 * observation log and confirm this detector is neither over- nor
 * under-firing. Refine here before mt#1476 wires emission.
 */
export function detectOutcome(
  toolName: string,
  result: Record<string, unknown> | undefined
): ToolOutcome {
  if (!result) return { kind: "unknown" };

  // Bash: exit code is the signal.
  if (toolName === "Bash") {
    const exitCode = result.exit_code;
    if (typeof exitCode === "number") {
      if (exitCode === 0) return { kind: "success" };
      const stderr = typeof result.stderr === "string" ? result.stderr : "";
      const content = typeof result.content === "string" ? result.content : "";
      return { kind: "error", error: stderr || content || `exit code ${exitCode}` };
    }
    // No exit_code field — can't classify.
    return { kind: "unknown" };
  }

  // Generic is_error flag (Claude Code MCP tools and others).
  if (result.is_error === true) {
    const error = typeof result.error === "string" ? result.error : "";
    const content = typeof result.content === "string" ? result.content : "";
    return { kind: "error", error: error || content || "tool error" };
  }
  if (result.is_error === false) {
    return { kind: "success" };
  }

  // Generic error field — some tools surface errors via a string field.
  if (typeof result.error === "string" && result.error.length > 0) {
    return { kind: "error", error: result.error };
  }

  // No explicit signal either way.
  return { kind: "unknown" };
}

/**
 * Sanitize a session id to a safe filesystem-safe filename.
 *
 * Defends against directory traversal (`../etc/passwd`) and unexpected path
 * separators in the session id. Conservative allow-list: alphanumeric, dash,
 * and underscore. Anything else becomes `_`. Per PR #926 R1 BLOCKING fix.
 */
export function sanitizeSessionId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * The hook's pure logic, separated from process-level wiring so tests can
 * drive it with synthetic input + an in-memory fs without touching disk.
 *
 * Behaviour:
 *   - No tool name → no-op.
 *   - Tool error → recordError on the tracker (may fire 2-strikes).
 *   - Tool success → recordSuccess on the tool's streak.
 *   - Drains observations to the JSONL file after recording.
 *   - Persists the tracker snapshot to per-session state file.
 */
export function runHook(input: ToolHookInput, deps: HookDeps): void {
  const rawSessionId = input.session_id ?? "default";
  const sessionId = sanitizeSessionId(rawSessionId);
  const toolName = input.tool_name;
  const toolResult = input.tool_result;

  if (!toolName) return;

  const stateFile = join(deps.stateDir, `${sessionId}.json`);
  const observationsFile = join(deps.stateDir, "observations.jsonl");

  // Defensively ensure the state file's parent directory exists. Today this
  // is always deps.stateDir (sanitizeSessionId strips path separators), but
  // guarding here makes future sharding (e.g., per-day directories) safe
  // without revisiting the hook (per PR #926 R1 BLOCKING fix).
  const stateFileDir = dirname(stateFile);
  if (!deps.fs.exists(stateFileDir)) {
    deps.fs.mkdirP(stateFileDir);
  }

  // Load or initialise tracker state, overriding mode from deps.
  let snapshot: TrackerSnapshot;
  if (deps.fs.exists(stateFile)) {
    try {
      const raw = deps.fs.readText(stateFile);
      const parsed = JSON.parse(raw) as TrackerSnapshot;
      snapshot = { ...parsed, mode: deps.mode };
    } catch {
      // Corrupt state file — start fresh, don't crash the hook.
      snapshot = { mode: deps.mode, streaks: [], observations: [] };
    }
  } else {
    snapshot = { mode: deps.mode, streaks: [], observations: [] };
  }

  const tracker = TwoStrikesTracker.fromSnapshot(snapshot);

  const outcome = detectOutcome(toolName, toolResult);
  switch (outcome.kind) {
    case "error":
      tracker.recordError(toolName, outcome.error);
      break;
    case "success":
      tracker.recordSuccess(toolName);
      break;
    case "unknown":
      // No-op: missing/ambiguous tool_result must not modify the streak.
      // Preserves "consecutive identical errors" semantics — only an
      // explicit success signal can break a streak.
      break;
  }

  // Drain new observations and append them to the global JSONL log so they
  // survive the hook's exit.
  const newObservations = tracker.drainObservations();
  if (newObservations.length > 0) {
    const lines = newObservations
      .map((o) => JSON.stringify({ sessionId, mode: deps.mode, ...o }))
      .join("\n");
    deps.fs.appendText(observationsFile, `${lines}\n`);
  }

  deps.fs.writeText(stateFile, JSON.stringify(tracker.snapshot(), null, 2));
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

/** Build a HookDeps backed by node:fs. */
export function defaultDeps(): HookDeps {
  const stateDir =
    process.env.MINSKY_TWO_STRIKES_STATE_DIR ??
    join(os.homedir(), ".local/state/minsky/two-strikes");

  const mode: TrackerMode = process.env.MINSKY_TWO_STRIKES_MODE === "live" ? "live" : "observation";

  const fs: HookFs = {
    exists: (path) => existsSync(path),
    mkdirP: (path) => mkdirSync(path, { recursive: true }),
    readText: (path) => readFileSync(path, "utf-8"),
    writeText: (path, contents) => writeFileSync(path, contents),
    appendText: (path, contents) => appendFileSync(path, contents),
  };

  return { stateDir, mode, fs };
}

// Run the hook only when invoked as a script (not when imported by tests).
// `import.meta.main` is the idiomatic Bun entrypoint check (Bun >= 0.4) —
// stable across versions per Bun docs (PR #926 R2 BLOCKING fix replaced
// the brittle `import.meta.path === Bun.main` form).
if (import.meta.main) {
  const input = await readInput<ToolHookInput>();
  runHook(input, defaultDeps());
  process.exit(0);
}
