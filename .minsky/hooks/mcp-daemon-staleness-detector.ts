#!/usr/bin/env bun
// UserPromptSubmit hook: detect when the MCP daemon started on a stale commit
// and inject context so the agent expects the staleness_exit + proxy respawn
// (retry the next call, do not block on a manual /mcp).
//
// **Why this exists.** When a new commit lands in the Minsky repo (e.g., a PR
// merges and you pull), the running MCP daemon was built at an older commit.
// Rather than serve stale logic, the daemon's `staleness_exit` (mt#1315/mt#1322)
// makes it exit on the next call; the stdio respawn proxy (mt#1714) then respawns
// it at the new HEAD transparently, so the next call retries cleanly. This hook
// surfaces the drift as context so the agent expects the one transient transport
// error and retries — rather than blocking on a manual `/mcp`. It compares the
// daemon's start-commit (written by `writeDaemonState()` in `src/mcp/server.ts`
// on startup) against the current HEAD of the Minsky working tree, and warns when
// `src/` files have changed.
//
// **Why this reads the state file inline.** The hook runs as a fresh
// Bun subprocess. It cannot import from `src/mcp/daemon-state.ts` (which may
// not be built, and the import path would be wrong). Instead, it reads the
// JSON state file directly and validates the shape inline — the same logic as
// `readDaemonState()` in daemon-state.ts, inlined here for self-containment.
//
// **Opt-out.** Set `MINSKY_SKIP_DAEMON_STALENESS=1` in the environment to
// disable the hook entirely.
//
// @see mt#1717 — this hook
// @see src/mcp/daemon-state.ts — writes the daemon state file on startup
// @see src/mcp/server.ts — calls writeDaemonState("minsky") in start()

import { readInput, writeOutput, execWithPath } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DispatchContext, GuardOutcome } from "./registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserPromptSubmitInput extends ClaudeHookInput {
  prompt: string;
}

/** Shape of the daemon state file written by server.ts on startup. */
export interface DaemonState {
  startCommit: string;
  startTimestamp: string;
  pid: number;
  serverName: string;
  /**
   * The resolved Minsky working tree directory used to compute startCommit.
   * Embedded by the daemon so the hook uses the exact same path — eliminates
   * resolver-mismatch (BLOCKING 1, PR #1035 R1).
   */
  minskyHomeDir: string;
  /**
   * Transport type at daemon startup. "http" causes the hook to skip —
   * HTTP reconnects via Claude Code backoff; /mcp is stdio-specific
   * (BLOCKING 2, PR #1035 R1).
   */
  transport: "stdio" | "http";
}

/** Reported commit pair used for re-warn suppression. */
export interface CommitPair {
  startCommit: string;
  currentHead: string;
}

/** Per-session tracker stored under ~/.claude/mcp-daemon-staleness/ */
export interface SessionTracker {
  /** Last pair that was reported in a warning. Null = never reported. */
  lastReportedPair: CommitPair | null;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Env var that disables the hook when set to a truthy value. */
export const OPT_OUT_ENV = "MINSKY_SKIP_DAEMON_STALENESS";

/**
 * Prefix that file paths must match to be counted as changed. Only changes
 * under src/ warrant a warning — docs/, tests/, etc. are not relevant.
 */
export const SRC_PREFIX = "src/";

/** Max number of changed file paths to list inline in the warning. */
export const MAX_PATHS_LISTED = 5;

// ---------------------------------------------------------------------------
// Filesystem dependency surface (for testability)
// ---------------------------------------------------------------------------

export interface FsDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf8") => string;
  writeFileSync: (path: string, data: string, encoding: "utf8") => void;
  mkdirSync: (path: string, options: { recursive: true }) => void;
  renameSync: (from: string, to: string) => void;
}

const REAL_FS: FsDeps = {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
};

// ---------------------------------------------------------------------------
// Git subprocess surface (for testability)
// ---------------------------------------------------------------------------

export interface GitDeps {
  /**
   * Run `git rev-parse HEAD` in `repoDir`.
   * Returns the full SHA string or null on failure.
   */
  resolveHead: (repoDir: string) => string | null;
  /**
   * Run `git diff --name-only <from>..<to>` in `repoDir`.
   * Returns array of changed file paths or null on failure.
   */
  diffNames: (repoDir: string, from: string, to: string) => string[] | null;
}

export const REAL_GIT: GitDeps = {
  resolveHead(repoDir: string): string | null {
    try {
      const result = execWithPath(["git", "rev-parse", "HEAD"], {
        cwd: repoDir,
        timeout: 5000,
      });
      if (result.exitCode !== 0) return null;
      const sha = result.stdout.trim();
      if (/^[0-9a-f]{7,}$/i.test(sha)) return sha;
      return null;
    } catch {
      return null;
    }
  },

  diffNames(repoDir: string, from: string, to: string): string[] | null {
    try {
      const result = execWithPath(["git", "diff", "--name-only", `${from}..${to}`], {
        cwd: repoDir,
        timeout: 5000,
      });
      if (result.exitCode !== 0) return null;
      const text = result.stdout.trim();
      if (text === "") return [];
      return text.split("\n").filter((p) => p.length > 0);
    } catch {
      return null;
    }
  },
};

// ---------------------------------------------------------------------------
// Inline daemon-state reader (mirrors readDaemonState in src/mcp/daemon-state.ts)
// ---------------------------------------------------------------------------

/**
 * Resolve the daemon state file path. Mirrors daemon-state.ts's
 * getDaemonStatePath(). Reads from MINSKY_STATE_DIR env override when set.
 */
export function getDaemonStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const envDir = env["MINSKY_STATE_DIR"];
  if (envDir) return join(envDir, "mcp-daemon-state.json");
  return join(homedir(), ".local", "state", "minsky", "mcp-daemon-state.json");
}

/**
 * Read and validate the daemon state file. Returns null if missing,
 * unreadable, or shape-invalid. Mirrors readDaemonState() in daemon-state.ts
 * (inlined here to avoid a cross-boundary src/ import).
 */
export function readDaemonStateFile(statePath: string, fs: FsDeps = REAL_FS): DaemonState | null {
  if (!fs.existsSync(statePath)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj["startCommit"] !== "string" ||
    typeof obj["startTimestamp"] !== "string" ||
    typeof obj["pid"] !== "number" ||
    typeof obj["serverName"] !== "string" ||
    typeof obj["minskyHomeDir"] !== "string" ||
    (obj["transport"] !== "stdio" && obj["transport"] !== "http")
  ) {
    return null;
  }
  return {
    startCommit: obj["startCommit"] as string,
    startTimestamp: obj["startTimestamp"] as string,
    pid: obj["pid"] as number,
    serverName: obj["serverName"] as string,
    minskyHomeDir: obj["minskyHomeDir"] as string,
    transport: obj["transport"] as "stdio" | "http",
  };
}

// ---------------------------------------------------------------------------
// Minsky home dir resolver (mirrors resolveMinskyHomeDir in daemon-state.ts)
// ---------------------------------------------------------------------------

/**
 * Resolve the Minsky working tree directory. Mirrors resolveMinskyHomeDir()
 * in daemon-state.ts (inlined here to avoid a cross-boundary src/ import).
 *
 * Priority:
 *   1. $MINSKY_HOME env var
 *   2. Standard bun global install symlink (~/.bun/install/global/node_modules/minsky)
 *   3. Fallback: null (caller must handle)
 */
export function resolveMinskyHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  fs: FsDeps = REAL_FS
): string | null {
  const envOverride = env["MINSKY_HOME"];
  if (envOverride) return envOverride;

  const bunGlobal = join(homedir(), ".bun", "install", "global", "node_modules", "minsky");
  if (fs.existsSync(bunGlobal)) return bunGlobal;

  return null;
}

// ---------------------------------------------------------------------------
// Tracker file helpers
// ---------------------------------------------------------------------------

/**
 * Encode a project directory path into a stable directory name.
 * Mirrors the pattern used by skill-staleness-detector.ts.
 */
export function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[/\\]/g, "-").replace(/^-/, "");
}

/**
 * Resolve the per-session tracker file path.
 * Layout: ~/.claude/mcp-daemon-staleness/<encoded-cwd>/<session_id>.json
 */
export function resolveTrackerPath(
  projectDir: string,
  sessionId: string,
  home: string = homedir()
): string {
  const encoded = encodeProjectDir(projectDir);
  return join(home, ".claude", "mcp-daemon-staleness", encoded, `${sessionId}.json`);
}

/**
 * Read the session tracker, or null if missing/invalid.
 */
export function readTracker(trackerPath: string, fs: FsDeps = REAL_FS): SessionTracker | null {
  if (!fs.existsSync(trackerPath)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(trackerPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const lrp = obj["lastReportedPair"];
  if (lrp === null) return { lastReportedPair: null };
  if (
    lrp &&
    typeof lrp === "object" &&
    typeof (lrp as Record<string, unknown>)["startCommit"] === "string" &&
    typeof (lrp as Record<string, unknown>)["currentHead"] === "string"
  ) {
    return {
      lastReportedPair: {
        startCommit: (lrp as Record<string, unknown>)["startCommit"] as string,
        currentHead: (lrp as Record<string, unknown>)["currentHead"] as string,
      },
    };
  }
  return null;
}

/**
 * Write the session tracker atomically (write-then-rename).
 * Failures are swallowed — the hook is informational.
 */
export function writeTracker(
  trackerPath: string,
  tracker: SessionTracker,
  fs: FsDeps = REAL_FS
): void {
  try {
    fs.mkdirSync(dirname(trackerPath), { recursive: true });
    const tmp = `${trackerPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(tracker), "utf8");
    fs.renameSync(tmp, trackerPath);
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Warning construction
// ---------------------------------------------------------------------------

/**
 * Build the warning message injected as additionalContext.
 */
export function buildWarning(
  startCommit: string,
  startTimestamp: string,
  currentHead: string,
  changedSrcPaths: string[]
): string {
  const n = changedSrcPaths.length;
  const head = changedSrcPaths.slice(0, MAX_PATHS_LISTED);
  const overflow = n - head.length;

  const pathLines = head.map((p) => `  - ${p}`);
  if (overflow > 0) {
    pathLines.push(`  + ${overflow} more`);
  }

  const lines = [
    `⚠️ Minsky MCP daemon is stale. Daemon started at commit ${startCommit.slice(0, 9)} (${startTimestamp}); HEAD is now ${currentHead.slice(0, 9)}. ${n} file${n === 1 ? "" : "s"} under src/ have changed since startup.`,
    ...pathLines,
    `The next MCP tool call may return a single transport error as the stale daemon exits rather than serve stale code; the stdio respawn proxy then respawns it at the new HEAD automatically — just retry the call. Run \`/mcp\` only if retries keep failing. Do not block work waiting on a manual reconnect.`,
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Pure decision core (exported for tests)
// ---------------------------------------------------------------------------

export interface DecideResult {
  /** Warning to inject, or null for no injection. */
  injection: string | null;
  /** Updated tracker to write, or null if no update needed. */
  newTracker: SessionTracker | null;
  /** The resolved tracker path. */
  trackerPath: string;
  /** Log summary for debugging. */
  log: {
    sessionId: string;
    skipped: boolean;
    skipReason?: string;
    warned?: boolean;
    changedSrcCount?: number;
  };
}

export function decideAndUpdate(args: {
  projectDir: string;
  sessionId: string;
  env: NodeJS.ProcessEnv;
  fs?: FsDeps;
  git?: GitDeps;
  homeOverride?: string;
  trackerPathOverride?: string;
}): DecideResult {
  const fs = args.fs ?? REAL_FS;
  const git = args.git ?? REAL_GIT;
  const home = args.homeOverride ?? homedir();
  const trackerPath =
    args.trackerPathOverride ?? resolveTrackerPath(args.projectDir, args.sessionId, home);

  // Opt-out short-circuit.
  const optOut = (args.env[OPT_OUT_ENV] ?? "").toLowerCase();
  if (optOut === "1" || optOut === "true" || optOut === "yes") {
    return {
      injection: null,
      newTracker: null,
      trackerPath,
      log: { sessionId: args.sessionId, skipped: true, skipReason: "opt-out" },
    };
  }

  // Read daemon state file.
  const statePath = getDaemonStatePath(args.env);
  const daemonState = readDaemonStateFile(statePath, fs);
  if (!daemonState) {
    return {
      injection: null,
      newTracker: null,
      trackerPath,
      log: { sessionId: args.sessionId, skipped: true, skipReason: "no-daemon-state" },
    };
  }

  // HTTP transport: skip staleness detection. HTTP sessions reconnect
  // automatically via Claude Code's exponential backoff; the /mcp click is
  // stdio-specific. State file field missing = pre-fix daemon = treat as stdio.
  if (daemonState.transport === "http") {
    return {
      injection: null,
      newTracker: null,
      trackerPath,
      log: { sessionId: args.sessionId, skipped: true, skipReason: "http-transport-out-of-scope" },
    };
  }

  // Use the minskyHomeDir embedded by the daemon — same path it used for
  // startCommit, so the comparison is symmetric (BLOCKING 1, PR #1035 R1).
  // If the field is absent (pre-fix daemon wrote the file), skip gracefully.
  const minskyHomeDir = daemonState.minskyHomeDir;
  if (!minskyHomeDir) {
    return {
      injection: null,
      newTracker: null,
      trackerPath,
      log: { sessionId: args.sessionId, skipped: true, skipReason: "no-minsky-home" },
    };
  }

  // Resolve current HEAD.
  const currentHead = git.resolveHead(minskyHomeDir);
  if (!currentHead) {
    return {
      injection: null,
      newTracker: null,
      trackerPath,
      log: { sessionId: args.sessionId, skipped: true, skipReason: "no-current-head" },
    };
  }

  // If commits match, nothing to do.
  if (currentHead === daemonState.startCommit) {
    return {
      injection: null,
      newTracker: null,
      trackerPath,
      log: { sessionId: args.sessionId, skipped: true, skipReason: "no-drift" },
    };
  }

  // Get changed file names between startCommit and currentHead.
  const changedPaths = git.diffNames(minskyHomeDir, daemonState.startCommit, currentHead);
  if (!changedPaths) {
    return {
      injection: null,
      newTracker: null,
      trackerPath,
      log: { sessionId: args.sessionId, skipped: true, skipReason: "diff-failed" },
    };
  }

  // Filter to src/ paths only.
  const changedSrcPaths = changedPaths.filter((p) => p.startsWith(SRC_PREFIX));
  if (changedSrcPaths.length === 0) {
    return {
      injection: null,
      newTracker: null,
      trackerPath,
      log: { sessionId: args.sessionId, skipped: true, skipReason: "no-src-changes" },
    };
  }

  // Check re-warn suppression.
  const existing = readTracker(trackerPath, fs);
  const pair: CommitPair = { startCommit: daemonState.startCommit, currentHead };
  if (
    existing?.lastReportedPair?.startCommit === pair.startCommit &&
    existing?.lastReportedPair?.currentHead === pair.currentHead
  ) {
    return {
      injection: null,
      newTracker: null,
      trackerPath,
      log: { sessionId: args.sessionId, skipped: true, skipReason: "already-reported" },
    };
  }

  // Emit warning and update tracker.
  const warning = buildWarning(
    daemonState.startCommit,
    daemonState.startTimestamp,
    currentHead,
    changedSrcPaths
  );

  const newTracker: SessionTracker = { lastReportedPair: pair };

  return {
    injection: warning,
    newTracker,
    trackerPath,
    log: {
      sessionId: args.sessionId,
      skipped: false,
      warned: true,
      changedSrcCount: changedSrcPaths.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Dispatcher-compatible pure function (ADR-028 Phase 2b, mt#2687)
// ---------------------------------------------------------------------------

/**
 * Guard-dispatcher entry point. Mirrors `main()`'s orchestration but returns
 * a `GuardOutcome` instead of writing to stdout / calling `process.exit`. The
 * opt-out check lives inside `decideAndUpdate` itself (via `OPT_OUT_ENV`), so
 * no separate override handling is needed here.
 *
 * @see .minsky/hooks/registry.ts — the guard-dispatcher registration
 * @see .minsky/hooks/dispatch-userpromptsubmit.ts — the dispatcher entrypoint
 */
export function run(input: ClaudeHookInput, _ctx: DispatchContext): GuardOutcome | null {
  const sessionId = input.session_id ?? "unknown";
  const projectDir = input.cwd;
  if (!projectDir) return null;

  const decision = decideAndUpdate({ projectDir, sessionId, env: process.env });

  if (decision.newTracker) {
    writeTracker(decision.trackerPath, decision.newTracker);
  }

  return decision.injection ? { additionalContext: decision.injection } : null;
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  let input: UserPromptSubmitInput;
  try {
    input = await readInput<UserPromptSubmitInput>();
  } catch {
    process.exit(0);
  }

  const sessionId = input.session_id ?? "unknown";
  const projectDir = input.cwd;

  if (!projectDir) {
    process.exit(0);
  }

  const decision = decideAndUpdate({
    projectDir,
    sessionId,
    env: process.env,
  });

  if (decision.newTracker) {
    writeTracker(decision.trackerPath, decision.newTracker);
  }

  if (decision.injection) {
    const output: HookOutput = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: decision.injection,
      },
    };
    writeOutput(output);
  }

  process.exit(0);
}
