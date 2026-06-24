#!/usr/bin/env bun
// UserPromptSubmit hook: detect skill/agent/rule files modified since session start
// and inject a staleness warning into the next agent turn.
//
// **Why this exists.** Skill/agent/rule bodies load into Claude Code's session
// context on first invocation and stay cached for the rest of the session.
// When a structural fix updates a skill on main and the change reaches local
// disk (via git pull, etc.), a running session keeps using the OLD body for
// any skill it has already invoked. Today's detection path is "operator
// notices wrong outputs"; this hook moves detection to "harness notices file
// mtime change between turns."
//
// **Why UserPromptSubmit, not FileChanged.** Claude Code's `FileChanged` event
// is in the "no decision control" class — it fires on file changes but cannot
// emit `additionalContext` into the next agent turn. `UserPromptSubmit` IS a
// context-injecting event (used by `memory-search.ts`), so the hook performs
// its own per-turn mtime check rather than subscribing to filesystem events.
// Trade-off: detection is per-turn rather than instantaneous; in practice
// equivalent since the agent only acts on context between turns.
//
// **Baseline strategy.** Lazy initialization: on first invocation for a given
// session_id, snapshot mtimes and write to a per-session state file; on
// subsequent invocations, compare current mtimes against the stored baseline.
// Avoids cross-hook coupling with `session-start.ts` (which early-exits on
// non-remote sessions).
//
// **Re-warning suppression.** After warning about file X, the hook records
// the mtime that triggered the warning into `lastReported[X]`. Subsequent
// turns only re-warn if the mtime has changed AGAIN since lastReported. This
// keeps the "I already told you about this one" UX without forcing operators
// to acknowledge each warning.
//
// **Opt-out.** Set `MINSKY_SKIP_SKILL_STALENESS=1` in the environment to
// disable the hook entirely.
//
// @see mt#1622 — this hook
// @see feedback_skill_copy_staleness_in_running_sessions — bridge memory
// @see memory record b0b056f8-7fb8-493d-8cda-0945488b086d — synthesis frame

import { readInput, writeOutput } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserPromptSubmitInput extends ClaudeHookInput {
  prompt: string;
}

/** mtime in milliseconds since epoch. */
export type MtimeMs = number;

/** Path-keyed mtime map, relative to project root. */
export type MtimeMap = Record<string, MtimeMs>;

export interface SessionBaseline {
  /** mtime snapshot taken at first hook invocation for this session. */
  baseline: MtimeMap;
  /**
   * mtime values most recently reported in a staleness warning. Used to
   * suppress re-warning on unchanged files. Empty until the first warning.
   */
  lastReported: MtimeMap;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Env var that disables the hook when set to a truthy value. */
export const OPT_OUT_ENV = "MINSKY_SKIP_SKILL_STALENESS";

/**
 * Watch roots, relative to project cwd. Files under each root with the listed
 * suffix are tracked. The directory walk is shallow-recursive (depth 3 is
 * sufficient for the current layout: `.claude/skills/<name>/SKILL.md`).
 */
export const WATCH_ROOTS: ReadonlyArray<{ readonly dir: string; readonly suffix: string }> = [
  { dir: ".claude/skills", suffix: ".md" },
  { dir: ".claude/agents", suffix: ".md" },
  { dir: ".minsky/rules", suffix: ".mdc" },
];

/**
 * Patterns to exclude from the watch — test/spec files alongside any of the
 * watched suffixes. The alternation must cover every suffix in WATCH_ROOTS,
 * including `.mdc` for the rules directory; otherwise `*.spec.mdc` /
 * `*.test.mdc` rule fixtures slip through and contribute false staleness.
 */
const SKIP_FILENAME_RE = /\.(test|spec)\.(ts|tsx|md|mdc)$/i;

/**
 * Hard cap on the file count listed in the warning message. Anything beyond
 * is summarised as "+ N more".
 */
export const MAX_FILES_LISTED = 10;

/**
 * Recursion depth cap for the directory walk. Defends against symlink loops
 * even though `entry.isSymbolicLink()` already filters them out — a defensive
 * second line in case a future fs surface reports something unexpected.
 *
 * Current watched layouts bottom out at depth 2 (`.claude/skills/<name>/SKILL.md`),
 * so 10 is well above the practical maximum. Bumping further is harmless; making
 * it configurable was considered but rejected as over-engineering for a
 * defensive guard rail. Add a regression test if a future layout pushes past 10.
 */
const MAX_WALK_DEPTH = 10;

/** Debug log file path. */
export const LOG_PATH = "/tmp/claude-skill-staleness-hook.log";

/** Rotate log when size exceeds this. */
const LOG_ROTATE_BYTES = 1_000_000;

/**
 * Hook version tag, included in every log entry. Bump this when behavior
 * changes so post-hoc log analysis can attribute observations to the correct
 * hook version.
 */
export const HOOK_VERSION = "1";

// ---------------------------------------------------------------------------
// Filesystem dependency surface (for testability)
// ---------------------------------------------------------------------------

export interface FsDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf8") => string;
  writeFileSync: (path: string, data: string, encoding: "utf8") => void;
  readdirSync: (
    path: string,
    options: { withFileTypes: true }
  ) => Array<{
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
    isSymbolicLink: () => boolean;
  }>;
  statSync: (path: string) => { mtimeMs: number; size: number };
  mkdirSync: (path: string, options: { recursive: true }) => void;
  appendFileSync: (path: string, data: string, encoding: "utf8") => void;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (path: string) => void;
}

const REAL_FS: FsDeps = {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync: (path, options) => readdirSync(path, options) as ReturnType<FsDeps["readdirSync"]>,
  statSync: (path) => {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  },
  mkdirSync,
  appendFileSync,
  renameSync,
  unlinkSync,
};

// ---------------------------------------------------------------------------
// Watch-file walker
// ---------------------------------------------------------------------------

/**
 * Walk the watch roots under `projectDir` and return a path → mtime map.
 *
 * Paths are recorded relative to `projectDir` so the baseline file remains
 * portable across machines (different absolute prefix). Symlinks are skipped
 * to avoid loops; depth is capped at `MAX_WALK_DEPTH`.
 *
 * Errors during stat/readdir are swallowed per-entry — a single unreadable
 * file shouldn't break the entire snapshot. The hook is informational; an
 * incomplete snapshot is acceptable.
 */
export function snapshotMtimes(
  projectDir: string,
  fs: FsDeps = REAL_FS,
  roots: typeof WATCH_ROOTS = WATCH_ROOTS
): MtimeMap {
  const result: MtimeMap = {};

  for (const root of roots) {
    const absRoot = join(projectDir, root.dir);
    if (!fs.existsSync(absRoot)) continue;
    walkInto(absRoot, root.suffix, projectDir, 0, fs, result);
  }

  return result;
}

function walkInto(
  absDir: string,
  suffix: string,
  projectDir: string,
  depth: number,
  fs: FsDeps,
  out: MtimeMap
): void {
  if (depth > MAX_WALK_DEPTH) return;

  let entries: Array<{
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
    isSymbolicLink: () => boolean;
  }>;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absChild = join(absDir, entry.name);

    if (entry.isDirectory()) {
      walkInto(absChild, suffix, projectDir, depth + 1, fs, out);
      continue;
    }

    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(suffix.toLowerCase())) continue;
    if (SKIP_FILENAME_RE.test(entry.name)) continue;

    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(absChild).mtimeMs;
    } catch {
      continue;
    }

    const relPath = relative(projectDir, absChild);
    out[relPath] = mtimeMs;
  }
}

// ---------------------------------------------------------------------------
// Baseline storage
// ---------------------------------------------------------------------------

/**
 * Encode a project directory path into a stable directory name. Mirrors the
 * Claude Code harness convention (replace `/` with `-`) so multiple hooks
 * keying off the same project share a consistent encoding.
 *
 * Exported for tests.
 */
export function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[/\\]/g, "-").replace(/^-/, "");
}

/**
 * Resolve the per-session baseline file path under `~/.claude/skill-staleness/`.
 *
 * Layout: `~/.claude/skill-staleness/<encoded-cwd>/<session_id>.json`. One file
 * per session sidesteps the read-modify-write race that a shared file would
 * have between concurrent sessions in the same project.
 *
 * `home` is parameterised so tests can override.
 */
export function resolveBaselinePath(
  projectDir: string,
  sessionId: string,
  home: string = homedir()
): string {
  const encoded = encodeProjectDir(projectDir);
  return join(home, ".claude", "skill-staleness", encoded, `${sessionId}.json`);
}

/**
 * Read the baseline for this session, or null if it has not been written yet.
 *
 * Defensively validates the shape so a corrupted file (partial write, schema
 * skew) is treated as "no baseline" — the hook then re-snapshots and proceeds.
 * Same posture as the trivial-prompt skip path: any error path silently falls
 * back to the no-injection baseline, never blocks the user prompt.
 */
export function readBaseline(path: string, fs: FsDeps = REAL_FS): SessionBaseline | null {
  if (!fs.existsSync(path)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
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
  const baseline = obj["baseline"];
  const lastReported = obj["lastReported"];
  if (!isMtimeMap(baseline)) return null;
  // lastReported may be missing on older files — treat absence as empty.
  const lr = isMtimeMap(lastReported) ? lastReported : {};
  return { baseline, lastReported: lr };
}

function isMtimeMap(value: unknown): value is MtimeMap {
  if (!value || typeof value !== "object") return false;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  return true;
}

/**
 * Write the baseline for this session atomically (write-then-rename).
 * Failures are swallowed — like log rotation, baseline write is best-effort.
 */
export function writeBaseline(path: string, baseline: SessionBaseline, fs: FsDeps = REAL_FS): void {
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(baseline), "utf8");
    fs.renameSync(tmp, path);
  } catch {
    // Best-effort; if we can't persist the baseline the next turn will re-snapshot.
  }
}

// ---------------------------------------------------------------------------
// Staleness comparison
// ---------------------------------------------------------------------------

export interface StaleEntry {
  path: string;
  /** "modified" when mtime advanced; "deleted" when file no longer exists. */
  kind: "modified" | "deleted";
  /** Current mtime, or 0 for deletions. */
  currentMtime: MtimeMs;
}

/**
 * Compare a current mtime snapshot against the session baseline + lastReported
 * map. Return the entries that warrant a warning on this turn.
 *
 * Warn when:
 *   - file existed at baseline AND mtime now differs from baseline AND
 *     mtime now differs from lastReported (suppresses re-warning), OR
 *   - file existed at baseline but is now missing (deletion).
 *
 * Files that did not exist at baseline (newly added since session start)
 * are NOT warned about — they're additive context, not staleness of a
 * skill the agent has already loaded.
 */
export function detectStaleness(baseline: SessionBaseline, current: MtimeMap): StaleEntry[] {
  const stale: StaleEntry[] = [];

  for (const [path, baselineMtime] of Object.entries(baseline.baseline)) {
    const currentMtime = current[path];
    if (currentMtime === undefined) {
      // File was present at baseline but missing now. lastReported tracks the
      // mtime of the last reported state; for deletion, we use a sentinel
      // (0) and only re-warn if the file reappears with a different mtime.
      const last = baseline.lastReported[path];
      if (last !== 0) {
        stale.push({ path, kind: "deleted", currentMtime: 0 });
      }
      continue;
    }
    if (currentMtime === baselineMtime) continue;
    const last = baseline.lastReported[path];
    if (last !== undefined && currentMtime === last) continue;
    stale.push({ path, kind: "modified", currentMtime });
  }

  return stale;
}

// ---------------------------------------------------------------------------
// Message construction
// ---------------------------------------------------------------------------

// Envelope tags. Mirrors the format used by `.claude/hooks/memory-search.ts`
// for `additionalContext` injections — Claude Code surfaces text inside
// `<system-reminder>...</system-reminder>` to the model on the next turn,
// not to the user. See `memory-search.ts` `ENVELOPE_HEADER` for prior art.
const ENVELOPE_HEADER = "<system-reminder>\n";
const ENVELOPE_FOOTER = "\n</system-reminder>";

/**
 * Build the operator-facing staleness warning. Format:
 *
 *   Note: <N> skill/agent/rule file(s) changed since this session started:
 *     - <path1> (modified)
 *     - <path2> (deleted)
 *     ...
 *     + N more
 *   Re-read the changed file(s) with the Read tool before relying on them, or
 *   start a fresh session to reload all skill/agent/rule content; otherwise
 *   proceed aware that previously-invoked skills may use cached logic.
 */
export function buildWarning(stale: StaleEntry[]): string {
  if (stale.length === 0) return "";

  const total = stale.length;
  const head = stale.slice(0, MAX_FILES_LISTED);
  const overflow = total - head.length;

  const lines = [
    `Note: ${total} skill/agent/rule file${total === 1 ? "" : "s"} changed since this session started:`,
    ...head.map((e) => `  - ${e.path} (${e.kind})`),
  ];
  if (overflow > 0) {
    lines.push(`  + ${overflow} more`);
  }
  lines.push(
    "Re-read the changed file(s) with the Read tool before relying on them, or start a fresh session to reload all skill/agent/rule content; otherwise proceed aware that previously-invoked skills may use cached logic."
  );

  return ENVELOPE_HEADER + lines.join("\n") + ENVELOPE_FOOTER;
}

// ---------------------------------------------------------------------------
// Debug logging (mirrors memory-search.ts)
// ---------------------------------------------------------------------------

export interface LogEntry {
  v?: string;
  ts: string;
  sessionId: string;
  skipped: boolean;
  skipReason?: string;
  baselineExisted?: boolean;
  watchedFileCount?: number;
  staleCount?: number;
  warned?: boolean;
  error?: string;
}

function rotateLogIfNeeded(path: string, maxBytes: number, fs: FsDeps): void {
  if (!fs.existsSync(path)) return;
  try {
    const size = fs.statSync(path).size;
    if (size <= maxBytes) return;
    const rotatedPath = `${path}.1`;
    if (fs.existsSync(rotatedPath)) {
      fs.unlinkSync(rotatedPath);
    }
    fs.renameSync(path, rotatedPath);
  } catch {
    // Rotation failures are silent — logging is best-effort.
  }
}

export function writeLog(entry: LogEntry, path: string = LOG_PATH, fs: FsDeps = REAL_FS): void {
  try {
    rotateLogIfNeeded(path, LOG_ROTATE_BYTES, fs);
    const stamped: LogEntry = { v: HOOK_VERSION, ...entry };
    fs.appendFileSync(path, `${JSON.stringify(stamped)}\n`, "utf8");
  } catch {
    // Logging is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

/**
 * Pure-logic core: given input, env, fs, and baseline path, produce the
 * decision (skip / no-warning / warn) plus the new baseline to persist.
 *
 * Split out from the entrypoint so tests can drive the full decision tree
 * without touching real stdin/stdout or the filesystem.
 */
export function decideAndUpdate(args: {
  projectDir: string;
  sessionId: string;
  env: NodeJS.ProcessEnv;
  fs?: FsDeps;
  now?: () => number;
  baselinePathOverride?: string;
  homeOverride?: string;
}): {
  injection: string | null;
  newBaseline: SessionBaseline | null;
  baselinePath: string;
  log: Omit<LogEntry, "v" | "ts">;
} {
  const fs = args.fs ?? REAL_FS;
  const home = args.homeOverride ?? homedir();
  const baselinePath =
    args.baselinePathOverride ?? resolveBaselinePath(args.projectDir, args.sessionId, home);

  // Opt-out: short-circuit before touching filesystem. Truthy = "1", "true",
  // "yes" (case-insensitive). Empty / unset / "0" / "false" = opt in.
  const optOut = (args.env[OPT_OUT_ENV] ?? "").toLowerCase();
  if (optOut === "1" || optOut === "true" || optOut === "yes") {
    return {
      injection: null,
      newBaseline: null,
      baselinePath,
      log: { sessionId: args.sessionId, skipped: true, skipReason: "opt-out" },
    };
  }

  const current = snapshotMtimes(args.projectDir, fs);
  const watchedFileCount = Object.keys(current).length;

  const existing = readBaseline(baselinePath, fs);

  if (existing === null) {
    // First invocation for this session — snapshot and persist; no warning.
    const fresh: SessionBaseline = { baseline: current, lastReported: {} };
    return {
      injection: null,
      newBaseline: fresh,
      baselinePath,
      log: {
        sessionId: args.sessionId,
        skipped: true,
        skipReason: "baseline-init",
        baselineExisted: false,
        watchedFileCount,
      },
    };
  }

  const stale = detectStaleness(existing, current);
  if (stale.length === 0) {
    return {
      injection: null,
      newBaseline: null,
      baselinePath,
      log: {
        sessionId: args.sessionId,
        skipped: true,
        skipReason: "no-change",
        baselineExisted: true,
        watchedFileCount,
        staleCount: 0,
      },
    };
  }

  const warning = buildWarning(stale);

  // Update lastReported for the files we just warned about, so subsequent
  // turns won't re-warn unless the file changes again.
  const newLastReported: MtimeMap = { ...existing.lastReported };
  for (const entry of stale) {
    newLastReported[entry.path] = entry.currentMtime;
  }
  const newBaseline: SessionBaseline = {
    baseline: existing.baseline,
    lastReported: newLastReported,
  };

  return {
    injection: warning,
    newBaseline,
    baselinePath,
    log: {
      sessionId: args.sessionId,
      skipped: false,
      baselineExisted: true,
      watchedFileCount,
      staleCount: stale.length,
      warned: true,
    },
  };
}

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
    writeLog({
      ts: new Date().toISOString(),
      sessionId,
      skipped: true,
      skipReason: "no-cwd",
    });
    process.exit(0);
  }

  const decision = decideAndUpdate({
    projectDir,
    sessionId,
    env: process.env,
  });

  if (decision.newBaseline) {
    writeBaseline(decision.baselinePath, decision.newBaseline);
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

  writeLog({ ts: new Date().toISOString(), ...decision.log });
  process.exit(0);
}
