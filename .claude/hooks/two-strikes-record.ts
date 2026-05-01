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
// This hook never blocks tool execution — exits 0 unconditionally so the
// agent proceeds normally regardless of what we record.

import os from "os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
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
 * Heuristic error detection across tool kinds. Returns the error value when
 * the tool result indicates an error, or `null` for success.
 *
 * Calibration TODO (per mt#1484 §Implementation Choice): inspect the
 * observation log and confirm this detector is neither over- nor
 * under-firing. Refine here before mt#1476 wires emission.
 */
export function detectError(
  toolName: string,
  result: Record<string, unknown> | undefined
): unknown | null {
  if (!result) return null;

  // Bash: non-zero exit code → error.
  if (toolName === "Bash") {
    const exitCode = result.exit_code;
    if (typeof exitCode === "number" && exitCode !== 0) {
      const stderr = typeof result.stderr === "string" ? result.stderr : "";
      const content = typeof result.content === "string" ? result.content : "";
      return stderr || content || `exit code ${exitCode}`;
    }
    return null;
  }

  // Generic is_error flag (Claude Code MCP tools and others).
  if (result.is_error === true) {
    const error = typeof result.error === "string" ? result.error : "";
    const content = typeof result.content === "string" ? result.content : "";
    return error || content || "tool error";
  }

  // Generic error field — some tools surface errors via a string field.
  if (typeof result.error === "string" && result.error.length > 0) {
    return result.error;
  }

  return null;
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
  const sessionId = input.session_id ?? "default";
  const toolName = input.tool_name;
  const toolResult = input.tool_result;

  if (!toolName) return;

  const stateFile = join(deps.stateDir, `${sessionId}.json`);
  const observationsFile = join(deps.stateDir, "observations.jsonl");

  if (!deps.fs.exists(deps.stateDir)) {
    deps.fs.mkdirP(deps.stateDir);
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

  const errorValue = detectError(toolName, toolResult);
  if (errorValue !== null) {
    tracker.recordError(toolName, errorValue);
  } else {
    tracker.recordSuccess(toolName);
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
// Bun.main is the entrypoint path; comparing against import.meta.path picks
// out direct invocation. Imports leave Bun.main pointing at the test runner.
if (import.meta.path === Bun.main) {
  const input = await readInput<ToolHookInput>();
  runHook(input, defaultDeps());
  process.exit(0);
}
