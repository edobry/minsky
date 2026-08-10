/**
 * Shared test harness for the dispatcher test files (mt#3640).
 *
 * `dispatcher.test.ts` and `dispatcher-output-contract.test.ts` were split
 * along concern boundaries in PR #2576, but each kept its own copy of the small
 * harness they both need. This module is the single definition; the duplication
 * it replaces was already drifting toward a third copy.
 *
 * ## Why this lives in a subdirectory
 *
 * `.minsky/hooks/*.ts` is the SOURCE tree the compile pipeline copies into
 * `.claude/hooks/`, and `discoverHookSourceFiles`
 * (`packages/domain/src/compile/targets/claude-hooks.ts`) excludes exactly one
 * thing: `*.test.ts`. A `dispatcher-harness.ts` sitting beside the hooks would
 * therefore be emitted as if it were a hook. That discovery reads the directory
 * top level only, so a SUBDIRECTORY is skipped — the same reason the existing
 * `fixtures/` and `__fixtures__/` directories in this tree are not compiled.
 *
 * `tsconfig.hooks.json` includes `.minsky/hooks` as a directory, which
 * TypeScript resolves recursively, so this file is still typechecked.
 */

/* The real-fs use below (`useIsolatedStateDir`) is deliberate: runDispatcher's
   default recordFireLogEntry wiring writes through MINSKY_STATE_DIR, so a mock
   fs cannot substitute — and the output-contract file's subprocess tests spawn
   a real `bun` that does its own real writes.

   Note this file carries NO `custom/no-real-fs-in-tests` disable, unlike the
   two test files it serves. That rule is scoped to `*.test.ts`, so it does not
   reach a `.ts` module in this directory — adding a disable here reports as an
   unused directive. The consequence is worth stating plainly rather than
   leaving implicit: moving the temp-dir creation here moves it out of that
   rule's reach. It is the right home anyway (one definition instead of two),
   but the lint backstop no longer covers it, so future fs use added to this
   module is on review to catch. */

import { beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolHookInput } from "../types";

/** The dispatcher's own compiled filename, used throughout as `hookFilename`. */
export const DISPATCH_HOOK_FILENAME = "dispatch-pretooluse.ts";

/** A minimal PreToolUse input; override only the fields a test cares about. */
export function baseInput(overrides: Partial<ToolHookInput> = {}): ToolHookInput {
  return {
    session_id: "sess-1",
    cwd: "/tmp",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    ...overrides,
  };
}

/** A resolved dispatch context with fixed budgets, for tests that inject one. */
export function stubContext() {
  return {
    event: "PreToolUse" as const,
    hostCapSec: 15,
    budgets: { overallBudgetMs: 9000, fetchTimeoutMs: 4950, gitTimeoutMs: 1530 },
    transcriptCandidates: [],
    transcriptLines: [],
  };
}

/** Collects stderr writes for assertion without touching the real process.stderr. */
export function makeStderrSpy(): { writes: string[]; write: (s: string) => void } {
  const writes: string[] = [];
  return { writes, write: (s) => writes.push(s) };
}

/**
 * Point `MINSKY_STATE_DIR` at an isolated temp directory for the calling file's
 * whole duration, and restore it afterwards.
 *
 * This is NOT incidental hygiene. `runDispatcher` fire-logs every matched
 * guard's outcome through the real `recordFireLogEntry` whenever a test does
 * not inject `recordFireLogFn` (mt#2597). Without this isolation, every such
 * run appends to the developer's live `~/.local/state/minsky/fire-log.jsonl`
 * — the mt#2876 class, which previously leaked fixture rows into an operator's
 * real log.
 *
 * Call it at module scope in each test file; `beforeAll`/`afterAll` register
 * against that file's own suite. Every file that runs the dispatcher needs its
 * own call — importing this module is not enough, and the call site is what
 * makes the isolation visible when reading the file.
 *
 * @param prefix mkdtemp prefix, so a leaked directory names the file that made it.
 * @returns a getter for the temp directory path. Tests that spawn a SUBPROCESS
 *   must pass it through explicitly (`env: { ...process.env, MINSKY_STATE_DIR:
 *   getStateDir() }`) — mutating this process's `process.env` does not isolate
 *   a child that builds its own env. It is a getter rather than a value because
 *   the directory does not exist until `beforeAll` runs, which is after this
 *   function returns.
 */
export function useIsolatedStateDir(prefix: string): () => string {
  let stateDir: string;
  let prevStateDir: string | undefined;

  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), prefix));
    prevStateDir = process.env.MINSKY_STATE_DIR;
    process.env.MINSKY_STATE_DIR = stateDir;
  });

  afterAll(() => {
    if (prevStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
    else process.env.MINSKY_STATE_DIR = prevStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  });

  return () => stateDir;
}
