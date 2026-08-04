#!/usr/bin/env bun
/**
 * Tests for `.minsky/hooks/merge-gate-task-resolution.ts` — mt#3355.
 *
 * Two layers, deliberately:
 *
 *   1. UNIT — the resolver and the fire-log context plumbing, using the in-memory fs +
 *      injected-exit fixtures established by `merge-gate-fire-log.test.ts` (mt#3630
 *      replaced this layer's `process.exit` spy with an injected impl).
 *   2. SUBPROCESS — each gate executed as its own process, fed a real `ToolHookInput` on
 *      stdin, against a real throwaway git repository. mt#3355's Acceptance Tests 1 and 2
 *      require this explicitly ("verified by executing the hook and observing output, not by
 *      reading the code"), and it is the only layer that can catch the defect this task
 *      fixes: the bug was never in a pure function, it was in which branch the top-level
 *      entrypoint took. Same rationale, and the same scratch-repo-with-no-origin trick, as
 *      the sibling `merge-gates-git-path-regression.test.ts` (mt#2810) — no `origin` remote
 *      means `deriveRepoFromGit` fails fast with no network call, while the code path under
 *      test still runs for real.
 *
 * **Captured, not authored (mem#705).** The `tool_input` shapes come from
 * `fixtures/session-pr-merge-payloads.json`, whose provenance block records that its
 * structure was copied from real `session_pr_merge` returns. mt#3066's verification script
 * authored its own payload shape to match the reader it was testing, and passed while
 * production skipped every merge; a hand-written fixture tests the reader against itself.
 *
 * **Fire-log hygiene (mt#3355 AT5).** Every subprocess runs with `MINSKY_STATE_DIR` pointed
 * at a temp directory, so nothing here appends to the real
 * `~/.local/state/minsky/fire-log.jsonl`. That log is the measurement corpus this task exists
 * to make trustworthy — it already carries one synthetic `sessionId: "probe"` record from
 * this task's own authoring-time control, and these tests must not add more.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
// eslint-disable-next-line custom/no-real-fs-in-tests -- real-subprocess integration test by design (see module comment): the spawned gate processes read a real git repo and write a real fire log, neither of which a mock fs can provide. Same justification as merge-gates-git-path-regression.test.ts.
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
// eslint-disable-next-line custom/no-real-fs-in-tests -- same justification: a real OS temp dir, not a mock path, is required for the real subprocess spawns below
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMergeGateTaskId, unresolvedTaskWarning } from "./merge-gate-task-resolution";
import {
  makeMergeGateDecider,
  dispatchMergeGateDecision,
  type MergeGateDecider,
  type MergeGateFireLogContext,
} from "./merge-gate-fire-log";
import {
  readFireLogEntries,
  type FireLogDecision,
  type FireLogEntry,
  type FireLogFsDeps,
  type FireLogRecordOptions,
} from "./fire-log";
import type { ToolHookInput } from "./types";

// ---------------------------------------------------------------------------
// Shared constants (custom/no-magic-string-duplication)
// ---------------------------------------------------------------------------

const HOOKS_DIR = import.meta.dir;
const SESSION_PR_MERGE_TOOL = "mcp__minsky__session_pr_merge";
const REVIEW_GATE = "require-review-before-merge";
const EVIDENCE_GATE = "require-execution-evidence-before-merge";
const OOB_GATE = "block-out-of-band-merge";
const LOG_PATH = "/fake/state/fire-log.jsonl";

/** The load-bearing phrase in `unresolvedTaskWarning` — a non-evaluation must not read as a pass. */
const DID_NOT_EVALUATE = "did NOT evaluate";

const TASK_BRANCH = "task/mt-9999";
const EXPECTED_BRANCH_TASK_ID = "mt#9999";

/** The env var `sessionsRoot()` reads first — pinned per-test so the real state dir is never touched. */
const STATE_DIR_ENV = "MINSKY_STATE_DIR";
/** The remaining two sources `sessionsRoot()` falls through to, in order. */
const XDG_STATE_HOME_ENV = "XDG_STATE_HOME";
const HOME_ENV = "HOME";

// ---------------------------------------------------------------------------
// Captured payload fixture (provenance lives in the JSON itself)
// ---------------------------------------------------------------------------

interface CapturedPayloads {
  taskInvoked: { toolName: string; toolInput: Record<string, unknown> };
  sessionIdInvoked: { toolName: string; toolInput: Record<string, unknown> };
}

const CAPTURED: CapturedPayloads = JSON.parse(
  // eslint-disable-next-line custom/no-real-fs-in-tests -- the captured-payload fixture is a real checked-in file; reading a mock of it would defeat the entire point of capturing it (mem#705)
  readFileSync(join(HOOKS_DIR, "fixtures", "session-pr-merge-payloads.json"), "utf-8")
) as CapturedPayloads;

const CAPTURED_SESSION_ID = CAPTURED.sessionIdInvoked.toolInput["sessionId"] as string;

/** Build a `ToolHookInput` around a captured `tool_input`, varying only `cwd`. */
function hookInput(toolInput: Record<string, unknown>, cwd: string): ToolHookInput {
  return {
    session_id: "00000000-0000-4000-8000-00000000000a",
    tool_name: SESSION_PR_MERGE_TOOL,
    tool_input: toolInput,
    cwd,
  } as ToolHookInput;
}

// ---------------------------------------------------------------------------
// Throwaway git repositories — a real `git rev-parse`, not a stubbed branch name
// ---------------------------------------------------------------------------

let taskBranchRepo: string;
let mainBranchRepo: string;
let nonGitDir: string;
/** A fake `MINSKY_STATE_DIR` whose `sessions/<CAPTURED sessionId>` is a task-branch repo. */
let stateDirWithSession: string;
/** A fake `MINSKY_STATE_DIR` containing no session workspaces at all. */
let emptyStateDir: string;

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
}

/** Create a throwaway repo on `branch` with one empty commit and NO origin remote. */
function initRepo(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mt3355-"));
  git(dir, "init", "-q", "-b", branch);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

beforeAll(() => {
  taskBranchRepo = initRepo(TASK_BRANCH);
  mainBranchRepo = initRepo("main");

  nonGitDir = mkdtempSync(join(tmpdir(), "mt3355-nogit-"));

  // mt#3380: the `sessionId` channel resolves `<state>/sessions/<id>`, so the fixture must be
  // a REAL repo at exactly that path — the same `git rev-parse` the cwd fallback runs.
  stateDirWithSession = mkdtempSync(join(tmpdir(), "mt3380-state-"));
  const sessionWorkspace = join(stateDirWithSession, "sessions", CAPTURED_SESSION_ID);
  // eslint-disable-next-line custom/no-real-fs-in-tests -- a real dir is the point: the channel reads a real branch
  mkdirSync(sessionWorkspace, { recursive: true });
  git(sessionWorkspace, "init", "-q", "-b", TASK_BRANCH);
  git(sessionWorkspace, "config", "user.email", "test@example.com");
  git(sessionWorkspace, "config", "user.name", "Test");
  git(sessionWorkspace, "commit", "-q", "--allow-empty", "-m", "init");

  emptyStateDir = mkdtempSync(join(tmpdir(), "mt3380-empty-"));
});

afterAll(() => {
  for (const d of [taskBranchRepo, mainBranchRepo, nonGitDir, stateDirWithSession, emptyStateDir]) {
    // eslint-disable-next-line custom/no-real-fs-in-tests -- cleanup of the real dirs created above
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

/** Run `fn` with `MINSKY_STATE_DIR` pinned, restoring the ambient value afterwards. */
function withStateDir<T>(stateDir: string, fn: () => T): T {
  const previous = process.env[STATE_DIR_ENV];
  process.env[STATE_DIR_ENV] = stateDir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = previous;
  }
}

// ---------------------------------------------------------------------------
// Unit — resolveMergeGateTaskId
// ---------------------------------------------------------------------------

describe("resolveMergeGateTaskId", () => {
  test("prefers tool_input.task and reports source 'tool_input'", () => {
    const result = resolveMergeGateTaskId(
      hookInput(CAPTURED.taskInvoked.toolInput, mainBranchRepo)
    );
    expect(result.source).toBe("tool_input");
    expect(result.taskId).toBe("mt#0000");
  });

  test("falls back to the task/mt-<id> branch when tool_input.task is absent", () => {
    // The captured `sessionId`-invoked form — the exact shape that produced a silent allow.
    const result = resolveMergeGateTaskId(
      hookInput(CAPTURED.sessionIdInvoked.toolInput, taskBranchRepo)
    );
    expect(result.source).toBe("branch-fallback");
    expect(result.taskId).toBe(EXPECTED_BRANCH_TASK_ID);
  });

  test("reports 'unresolved' when tool_input.task is absent, cwd is on main, and no session workspace exists", () => {
    const result = withStateDir(emptyStateDir, () =>
      resolveMergeGateTaskId(hookInput(CAPTURED.sessionIdInvoked.toolInput, mainBranchRepo))
    );
    expect(result.source).toBe("unresolved");
    expect(result.taskId).toBeNull();
  });

  test("reports 'unresolved' rather than throwing when cwd is not a git repository", () => {
    const result = resolveMergeGateTaskId(hookInput({}, nonGitDir));
    expect(result.source).toBe("unresolved");
    expect(result.taskId).toBeNull();
  });

  test("reports 'unresolved' rather than throwing when cwd does not exist", () => {
    const result = resolveMergeGateTaskId(hookInput({}, join(tmpdir(), "mt3355-does-not-exist")));
    expect(result.source).toBe("unresolved");
    expect(result.taskId).toBeNull();
  });

  test("ignores a whitespace-only tool_input.task and falls through to the branch", () => {
    const result = resolveMergeGateTaskId(hookInput({ task: "   " }, taskBranchRepo));
    expect(result.source).toBe("branch-fallback");
    expect(result.taskId).toBe(EXPECTED_BRANCH_TASK_ID);
  });

  // -------------------------------------------------------------------------
  // mt#3380 — the `sessionId` channel (AT1 / AT2 / AT3)
  // -------------------------------------------------------------------------

  test("AT1: resolves from the sessionId's workspace branch when cwd is on main", () => {
    const result = withStateDir(stateDirWithSession, () =>
      resolveMergeGateTaskId(hookInput(CAPTURED.sessionIdInvoked.toolInput, mainBranchRepo))
    );
    expect(result.source).toBe("session-workspace-branch");
    expect(result.taskId).toBe(EXPECTED_BRANCH_TASK_ID);
  });

  test("AT2: tool_input.task still wins when both selectors are present", () => {
    const result = withStateDir(stateDirWithSession, () =>
      resolveMergeGateTaskId(
        hookInput({ task: "mt#0000", sessionId: CAPTURED_SESSION_ID }, mainBranchRepo)
      )
    );
    expect(result.source).toBe("tool_input");
    expect(result.taskId).toBe("mt#0000");
  });

  test("AT3: reports 'unresolved' rather than throwing when the sessionId names no workspace", () => {
    const result = withStateDir(stateDirWithSession, () =>
      resolveMergeGateTaskId(
        hookInput({ sessionId: "00000000-0000-4000-8000-00000000dead" }, mainBranchRepo)
      )
    );
    expect(result.source).toBe("unresolved");
    expect(result.taskId).toBeNull();
  });

  test("the cwd branch still takes precedence over the sessionId workspace", () => {
    const result = withStateDir(stateDirWithSession, () =>
      resolveMergeGateTaskId(hookInput(CAPTURED.sessionIdInvoked.toolInput, taskBranchRepo))
    );
    expect(result.source).toBe("branch-fallback");
    expect(result.taskId).toBe(EXPECTED_BRANCH_TASK_ID);
  });

  // -------------------------------------------------------------------------
  // mt#3380 / PR #2431 R1 — the sessionId segment must not escape the root
  // -------------------------------------------------------------------------

  test("rejects a traversal sessionId even when the traversal would resolve to a real workspace", () => {
    // Negative control: this path NORMALIZES to the very workspace AT1 resolves, so an
    // unguarded `join` would return mt#9999 here. The guard must decline instead.
    const traversal = join("..", "sessions", CAPTURED_SESSION_ID);
    const result = withStateDir(stateDirWithSession, () =>
      resolveMergeGateTaskId(hookInput({ sessionId: traversal }, mainBranchRepo))
    );
    expect(result.source).toBe("unresolved");
    expect(result.taskId).toBeNull();
  });

  test("rejects a sessionId containing a path separator", () => {
    const result = withStateDir(stateDirWithSession, () =>
      resolveMergeGateTaskId(
        hookInput({ sessionId: `subdir/${CAPTURED_SESSION_ID}` }, mainBranchRepo)
      )
    );
    expect(result.source).toBe("unresolved");
    expect(result.taskId).toBeNull();
  });

  test("rejects an absolute-path sessionId pointing at a real task-branch repo", () => {
    const result = withStateDir(stateDirWithSession, () =>
      resolveMergeGateTaskId(hookInput({ sessionId: taskBranchRepo }, mainBranchRepo))
    );
    expect(result.source).toBe("unresolved");
    expect(result.taskId).toBeNull();
  });

  test("declines the sessionId channel when no state dir and no HOME can be resolved", () => {
    const saved = {
      state: process.env[STATE_DIR_ENV],
      xdg: process.env[XDG_STATE_HOME_ENV],
      home: process.env[HOME_ENV],
    };
    delete process.env[STATE_DIR_ENV];
    delete process.env[XDG_STATE_HOME_ENV];
    delete process.env[HOME_ENV];
    try {
      const result = resolveMergeGateTaskId(
        hookInput(CAPTURED.sessionIdInvoked.toolInput, mainBranchRepo)
      );
      expect(result.source).toBe("unresolved");
      expect(result.taskId).toBeNull();
    } finally {
      if (saved.state !== undefined) process.env[STATE_DIR_ENV] = saved.state;
      if (saved.xdg !== undefined) process.env[XDG_STATE_HOME_ENV] = saved.xdg;
      if (saved.home !== undefined) process.env[HOME_ENV] = saved.home;
    }
  });
});

describe("unresolvedTaskWarning", () => {
  test("names the guard and states the gate did not evaluate the PR", () => {
    const warning = unresolvedTaskWarning(REVIEW_GATE);
    expect(warning).toContain(REVIEW_GATE);
    expect(warning).toContain(DID_NOT_EVALUATE);
    expect(warning).toContain("NOT a clean pass");
  });
});

// ---------------------------------------------------------------------------
// Unit — the mutable fire-log context is read at EXIT time, not construction time
// ---------------------------------------------------------------------------

function makeInMemoryFs(): FireLogFsDeps & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    existsSync: (p: string) => p in files || Object.keys(files).some((k) => k.startsWith(p)),
    mkdirSync: () => {
      /* no-op — flat in-memory map */
    },
    appendFileSync: (p: string, data: string) => {
      files[p] = (files[p] ?? "") + data;
    },
    readFileSync: (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p] as string;
    },
  };
}

class ExitCalled extends Error {}

/**
 * Injected stand-in for `process.exit` (mt#3630) — records nothing, just unwinds so the
 * `never` contract holds without terminating the runner. Replaces the previous
 * spy patch on `process.exit`, which mutated the global for the whole process.
 */
function throwingExit(): never {
  throw new ExitCalled();
}

/** Run one gate exit point through the real decide → dispatch composition. */
function runExitPoint(
  decide: MergeGateDecider,
  decision: FireLogDecision,
  recordOptions: FireLogRecordOptions
): void {
  try {
    dispatchMergeGateDecision(decide(decision), recordOptions, throwingExit);
  } catch (err) {
    if (!(err instanceof ExitCalled)) throw err;
  }
}

describe("makeMergeGateDecider + MergeGateFireLogContext", () => {
  test("records a taskResolutionSource assigned AFTER the decider was built", () => {
    // The design property under test: a gate resolves the task id downstream of building
    // its decider, so a value captured at construction time would always be undefined.
    // Threading it per-exit-point instead would make "forgot to pass it at exit point N" a
    // live failure mode — the same shape as the bug this task fixes.
    const fs = makeInMemoryFs();
    const context: MergeGateFireLogContext = {};
    const decide = makeMergeGateDecider(
      EVIDENCE_GATE,
      Date.now(),
      { tool_name: SESSION_PR_MERGE_TOOL, session_id: "s1" },
      context
    );

    context.taskResolutionSource = "branch-fallback";
    // Asserted twice, deliberately: on the PURE return value (the field is read at
    // decide() time, not construction time) and on the RECORD the dispatch shell wrote.
    expect(decide("allow").record.taskResolutionSource).toBe("branch-fallback");

    runExitPoint(decide, "allow", { fs, logPath: LOG_PATH });

    const entries = readFireLogEntries({ fs, logPath: LOG_PATH });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.taskResolutionSource).toBe("branch-fallback");
  });

  test("omits taskResolutionSource entirely when the gate never assigned one", () => {
    // Guards that are not `session_pr_merge` gates must not gain a spurious field.
    const fs = makeInMemoryFs();
    const decide = makeMergeGateDecider(
      "check-branch-fresh",
      Date.now(),
      { tool_name: "mcp__minsky__session_commit", session_id: "s2" },
      {}
    );

    expect("taskResolutionSource" in decide("allow").record).toBe(false);

    runExitPoint(decide, "allow", { fs, logPath: LOG_PATH });

    expect(fs.files[LOG_PATH] ?? "").not.toContain("taskResolutionSource");
  });

  test("records 'unresolved' alongside a warn decision", () => {
    const fs = makeInMemoryFs();
    const context: MergeGateFireLogContext = {};
    const decide = makeMergeGateDecider(
      REVIEW_GATE,
      Date.now(),
      { tool_name: SESSION_PR_MERGE_TOOL, session_id: "s3" },
      context
    );

    context.taskResolutionSource = "unresolved";
    runExitPoint(decide, "warn", { fs, logPath: LOG_PATH });

    const entries = readFireLogEntries({ fs, logPath: LOG_PATH });
    expect(entries[0]?.decision).toBe("warn");
    expect(entries[0]?.taskResolutionSource).toBe("unresolved");
  });
});

// ---------------------------------------------------------------------------
// Subprocess — each gate executed for real (mt#3355 AT1 / AT2 / AT5)
// ---------------------------------------------------------------------------

/**
 * The four gates whose task resolution runs BEFORE any repo derivation or `gh` call, so a
 * subprocess run reaches the resolution branch with no network and no auth.
 *
 * `block-out-of-band-merge.ts` is covered separately below: it derives owner/repo FIRST and
 * only resolves the task id inside its `session_pr_merge` branch, so it needs a remote
 * configured before it reaches the code under test.
 */
const PRE_REPO_GATES = [
  EVIDENCE_GATE,
  REVIEW_GATE,
  "require-deploy-verification-before-merge",
  "require-growth-justification-before-merge",
] as const;

interface GateRun {
  stdout: string;
  entries: FireLogEntry[];
}

/** Run one gate as its own process against an isolated state dir. Returns stdout + fire log. */
function runGate(gate: string, input: ToolHookInput): GateRun {
  const stateDir = mkdtempSync(join(tmpdir(), "mt3355-state-"));
  try {
    const result = Bun.spawnSync(["bun", join(HOOKS_DIR, `${gate}.ts`)], {
      stdin: Buffer.from(JSON.stringify(input)),
      env: { ...process.env, MINSKY_STATE_DIR: stateDir },
    });
    const logPath = join(stateDir, "fire-log.jsonl");
    // eslint-disable-next-line custom/no-real-fs-in-tests -- reads the real log the real subprocess just wrote
    const entries = existsSync(logPath) ? readFireLogEntries({ logPath }) : [];
    return { stdout: result.stdout.toString(), entries };
  } finally {
    // eslint-disable-next-line custom/no-real-fs-in-tests -- cleanup of the isolated state dir
    rmSync(stateDir, { recursive: true, force: true });
  }
}

describe("gate subprocess behavior (AT1 / AT2 / AT5)", () => {
  test.each(PRE_REPO_GATES)(
    "%s: a sessionId-only merge from a task branch resolves and does NOT exit silently",
    (gate) => {
      // AT1 negative control. Before mt#3355 this input produced a bare `allow` with no
      // output at all. The discriminating assertion is the recorded resolution source: the
      // gate got past the early exit and identified the PR it should evaluate.
      const { entries } = runGate(
        gate,
        hookInput(CAPTURED.sessionIdInvoked.toolInput, taskBranchRepo)
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.taskResolutionSource).toBe("branch-fallback");
      expect(entries[0]?.decision).not.toBe("allow");
    }
  );

  test.each(PRE_REPO_GATES)(
    "%s: neither selector, cwd on main -> operator-visible warning and decision 'warn'",
    (gate) => {
      // AT2 unresolvable control. Asserts on the fire-log line, not just stdout — the whole
      // defect was that the LOG could not distinguish a non-evaluation from a clean pass.
      const { stdout, entries } = runGate(gate, hookInput({}, mainBranchRepo));
      expect(stdout).toContain(DID_NOT_EVALUATE);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.decision).toBe("warn");
      expect(entries[0]?.taskResolutionSource).toBe("unresolved");
    }
  );

  test.each(PRE_REPO_GATES)(
    "%s: an explicit tool_input.task still records source 'tool_input' (regression floor)",
    (gate) => {
      // AT4 / AT5 positive control: the resolver is additive and must not change behavior
      // when `task` IS present, which is how ~88% of recorded merges are invoked.
      const { entries } = runGate(gate, hookInput(CAPTURED.taskInvoked.toolInput, mainBranchRepo));
      expect(entries).toHaveLength(1);
      expect(entries[0]?.taskResolutionSource).toBe("tool_input");
    }
  );

  test(`${OOB_GATE}: unresolvable id warns instead of allowing silently`, () => {
    // This gate derives owner/repo before resolving, so it needs a remote to reach the
    // branch under test. Its pre-mt#3355 defect was subtler than the other four: it passed
    // `""` to `resolvePrBodyFromTask`, which returns `null` on an empty task, and `null` was
    // treated as "no PR exists for this branch — legitimate, allow silently". The
    // non-evaluation was therefore indistinguishable from a genuine no-PR result.
    const repoWithRemote = initRepo("main");
    try {
      git(repoWithRemote, "remote", "add", "origin", "https://github.com/edobry/minsky.git");

      const { stdout, entries } = runGate(OOB_GATE, hookInput({}, repoWithRemote));
      expect(stdout).toContain(DID_NOT_EVALUATE);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.decision).toBe("warn");
      expect(entries[0]?.taskResolutionSource).toBe("unresolved");
    } finally {
      // eslint-disable-next-line custom/no-real-fs-in-tests -- cleanup of the real repo created above
      rmSync(repoWithRemote, { recursive: true, force: true });
    }
  });
});
