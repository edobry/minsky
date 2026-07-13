/**
 * Live-tail JSONL poller for the Rung-1 observe→drive SSE endpoint (mt#2232).
 *
 * Consumes `JsonlTailer` (the shared incremental-read primitive from mt#2320)
 * as a render-on-append source. Each connected SSE client gets its own
 * per-connection `JsonlTailer` instance (independent byte-offset state) so
 * multiple tabs watching the same session each receive ALL new lines.
 *
 * Also provides `resolveJsonlPath` — the workspace→JSONL file resolution
 * logic that turns a `workdir` + `agentSessionId` into an absolute path
 * under `~/.claude/projects/`.
 *
 * @see mt#2232 — Rung-1 live renderer (this file)
 * @see packages/domain/src/transcripts/jsonl-tailer.ts — shared tailer primitive
 * @see src/cockpit/server.ts — wires this into GET /api/agents/:id/live-tail
 * @see src/cockpit/transcript-watcher.ts — first consumer of JsonlTailer (ingest path)
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { readdir as readdirAsync, stat as statAsync } from "node:fs/promises";

import { JsonlTailer } from "@minsky/domain/transcripts/jsonl-tailer";
import {
  turnLineToBlock,
  assistantContentKind as _assistantContentKind,
} from "@minsky/domain/transcripts/session-context-snapshot";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";

export { turnLineToBlock };

// ---------------------------------------------------------------------------
// Injectable FS abstraction (enables unit-test injection without real disk I/O)
// ---------------------------------------------------------------------------

/**
 * Minimal fs abstraction for resolveJsonlPath.
 * Production code uses real node:fs; tests inject in-memory equivalents.
 */
export interface ResolveJsonlFsMod {
  readdirWithTypes(dir: string): Promise<Array<{ name: string; isDirectory(): boolean }>>;
  fileExists(path: string): boolean;
}

/**
 * Stat result abstraction used by startLiveTail to seed the tailer offset.
 * Production uses real node:fs/promises.stat; tests inject a synchronous mock.
 */
export type StatFn = (path: string) => Promise<{ size: number }>;

/**
 * Minimal tailer interface accepted by startLiveTail.
 * Structural — both real JsonlTailer and test mocks satisfy it.
 */
export interface TailerLike {
  setOffset(path: string, offset: number): void;
  forget(path: string): void;
  readNew<T = unknown>(path: string): Promise<{ lines: T[] }>;
}

// Production defaults --------------------------------------------------------

const prodFsMod: ResolveJsonlFsMod = {
  readdirWithTypes: (dir) => readdirAsync(dir, { withFileTypes: true }),
  fileExists: (path) => existsSync(path),
};

const prodStatFn: StatFn = statAsync;

// ---------------------------------------------------------------------------
// JSONL file resolution — workspace → ~/.claude/projects/**/<agentSessionId>.jsonl
// ---------------------------------------------------------------------------

/** Default root where Claude Code stores transcript JSONL files. */
const DEFAULT_CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Resolve the absolute path of the JSONL transcript file for a given
 * `agentSessionId` under the Claude Code projects directory.
 *
 * Strategy:
 * 1. If `projectDir` is known (stored in `agent_transcripts.project_dir`),
 *    check `<projectDir>/<agentSessionId>.jsonl` directly.
 * 2. Otherwise, scan the one level of subdirectories under
 *    `~/.claude/projects/` for a matching filename. Claude Code's structure
 *    is flat (one encoded subdir per project, files directly inside it), so
 *    one level of readdir is sufficient and fast (<100 dirs in practice).
 *
 * Returns `null` when the file cannot be found (session may not have started
 * writing yet, or the projects dir doesn't exist).
 *
 * @param fsMod - Injectable fs operations; defaults to real node:fs (injection
 *   is for unit tests only — production always passes undefined / omits).
 */
export async function resolveJsonlPath(
  agentSessionId: string,
  opts: {
    projectDir?: string | null;
    claudeProjectsDir?: string;
    fsMod?: ResolveJsonlFsMod;
  } = {}
): Promise<string | null> {
  const claudeProjectsDir = opts.claudeProjectsDir ?? DEFAULT_CLAUDE_PROJECTS_DIR;
  const filename = `${agentSessionId}.jsonl`;
  const fs = opts.fsMod ?? prodFsMod;

  // Fast path: projectDir known from DB
  if (opts.projectDir) {
    const candidate = join(opts.projectDir, filename);
    if (fs.fileExists(candidate)) return candidate;
  }

  // Scan path: walk one level under ~/.claude/projects/
  try {
    const entries = await fs.readdirWithTypes(claudeProjectsDir);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const candidate = join(claudeProjectsDir, entry.name, filename);
        if (fs.fileExists(candidate)) return candidate;
      }
    }
  } catch {
    // Projects dir may not exist (no Claude Code sessions ever run)
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Workspace-cwd descendant LIKE matching — shared by the /api/agents/:id and
// /api/agents/:id/live-tail transcript-resolution routes so the backslash
// escape level is defined exactly ONCE and cannot drift (mt#2232 R1).
// ---------------------------------------------------------------------------

/**
 * Build the Postgres LIKE patterns matching `workdir` and all its descendants
 * under either path separator (POSIX "/" and Windows "\\"). LIKE wildcards in
 * the literal path are escaped (Postgres' default escape char is backslash);
 * the Windows pattern emits a literal "\\" before "%" so a backslash separator
 * is matched rather than treated as an escape. Callers OR these two patterns
 * together with an exact-equality match on the workdir itself.
 */
export function cwdDescendantLikePatterns(workdir: string): {
  posix: string;
  windows: string;
} {
  const escaped = workdir.replace(/([\\%_])/g, "\\$1");
  return { posix: `${escaped}/%`, windows: `${escaped}\\\\%` };
}

// ---------------------------------------------------------------------------
// JSONL line → SessionContextSnapshotBlock conversion for live-tail
// ---------------------------------------------------------------------------

/**
 * Convert a raw JSONL line object (read by `JsonlTailer`) to a
 * `SessionContextSnapshotBlock` for streaming over SSE.
 *
 * Live-tail blocks use a counter-based id (`<agentSessionId>:live:<counter>`)
 * rather than the DB's `turn:<turnIndex>` id; the SPA must NOT de-duplicate
 * live blocks against snapshot blocks (they represent different read paths
 * and could collide on the first live append if we used `turnIndex`).
 *
 * Only `user` and `assistant` JSONL lines are converted; `system`,
 * `attachment`, and other types return `null` (filtered out by the caller).
 */
export function jsonlLineToLiveBlock(
  agentSessionId: string,
  liveCounter: number,
  rawLine: unknown
): SessionContextSnapshotBlock | null {
  // turnLineToBlock uses `agentSessionId:turn:N` ids; override with a live id
  // that won't collide with DB-fetched snapshot blocks.
  const block = turnLineToBlock(agentSessionId, liveCounter, rawLine);
  if (block === null) return null;
  return {
    ...block,
    id: `${agentSessionId}:live:${liveCounter}`,
  };
}

// ---------------------------------------------------------------------------
// LiveTailSession — per-connection polling manager
// ---------------------------------------------------------------------------

/** How often to poll the JSONL file for new lines (ms). */
export const LIVE_TAIL_POLL_MS = 500;

/** Callback invoked for each new block read from the live tail. */
export type LiveTailCallback = (block: SessionContextSnapshotBlock) => void;

/** Cleanup function returned by `startLiveTail`. */
export type LiveTailStop = () => void;

/**
 * Start polling a JSONL file for new turns and call `onBlock` for each.
 *
 * Seeds the tailer to the current EOF so only FUTURE appends are surfaced
 * (not the historical content already in the DB snapshot). Returns a `stop`
 * function; call it on SSE client disconnect to cancel the interval.
 *
 * @param jsonlPath - Absolute path to the JSONL file to tail.
 * @param agentSessionId - Harness session id; used to construct block ids.
 * @param onBlock - Callback invoked for each new `SessionContextSnapshotBlock`.
 * @param opts.pollMs - Override the polling interval (tests use a very short window).
 * @param opts.tailer - Override the JsonlTailer (tests inject a deterministic one).
 * @param opts.statFn - Override the stat function (tests inject a synchronous mock).
 */
export async function startLiveTail(
  jsonlPath: string,
  agentSessionId: string,
  onBlock: LiveTailCallback,
  opts: {
    pollMs?: number;
    tailer?: TailerLike;
    statFn?: StatFn;
  } = {}
): Promise<LiveTailStop> {
  const pollMs = opts.pollMs ?? LIVE_TAIL_POLL_MS;
  const tailer: TailerLike = opts.tailer ?? new JsonlTailer();
  const statFn = opts.statFn ?? prodStatFn;

  let seeded = false;

  // Seed the tailer to the file's CURRENT size so only FUTURE appends are
  // surfaced (historical content already in the DB snapshot is excluded). If
  // the file does not exist yet (session just started), seeding is DEFERRED to
  // the poll loop and retried until the file appears — otherwise the first
  // successful read would start at offset 0 and stream the whole history (R1).
  async function trySeed(): Promise<void> {
    if (seeded) return;
    try {
      const st = await statFn(jsonlPath);
      tailer.setOffset(jsonlPath, st.size);
      seeded = true;
    } catch {
      // File may not exist yet — leave unseeded and retry on the next poll.
    }
  }

  await trySeed();

  let liveCounter = 0;
  let stopped = false;
  let inFlight = false;

  const interval = setInterval(async () => {
    if (stopped) {
      clearInterval(interval);
      return;
    }
    // Reentrancy guard: if a poll is still running when the next tick fires
    // (slow or large read), skip this tick rather than overlapping. Overlapping
    // polls would interleave reads and produce non-monotonic live ids (R1).
    if (inFlight) return;
    inFlight = true;
    try {
      if (!seeded) {
        // File was absent at connect; seed to its size the moment it appears
        // (so pre-existing/historical content is NOT streamed), then begin
        // reading appends on the next tick.
        await trySeed();
        return;
      }
      const result = await tailer.readNew(jsonlPath);
      for (const line of result.lines) {
        if (stopped) break;
        const block = jsonlLineToLiveBlock(agentSessionId, liveCounter++, line);
        if (block !== null) {
          onBlock(block);
        }
      }
    } catch {
      // File not yet created, or transient FS error — keep polling.
    } finally {
      inFlight = false;
    }
  }, pollMs);

  return function stop() {
    stopped = true;
    clearInterval(interval);
    tailer.forget(jsonlPath);
  };
}
