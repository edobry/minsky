/**
 * Claude Code v1 implementation of TranscriptSource.
 *
 * Scans a configurable Claude Code projects directory for JSONL transcript
 * files. Top-level files map to root agent sessions; files under
 * `<session>/subagents/` map to subagent transcripts. Filters to user/assistant
 * lines (matches `AgentTranscriptService.ingestTranscript` retention at
 * `src/domain/provenance/transcript-service.ts:26`).
 *
 * @see mt#1313 §Harness agnosticism, §Subagent transcript discovery
 * @see mt#1350 — this file
 */

import { promises as fs, type Dirent } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";

import { glob } from "glob";

import type {
  AgentSessionId,
  DiscoveredSession,
  RawTurnLine,
  TimestampISO,
  TranscriptSource,
} from "./transcript-source";

/** Message types preserved from Claude Code JSONL transcripts. */
const RETAINED_TYPES = new Set(["user", "assistant"]);

const HARNESS = "claude_code";

/**
 * Default glob scans all per-project transcript directories under
 * `claudeProjectsDir`. Claude Code derives its per-project directory name by
 * replacing slashes in the absolute project path with `-`, so a single
 * `claudeProjectsDir` may hold transcripts for many checkouts. Callers that
 * need to scope to a particular checkout should pass an explicit
 * `projectDirGlob` via `ClaudeCodeTranscriptSourceOptions`.
 */
const DEFAULT_PROJECT_DIR_GLOB = "*";

const SUBAGENTS_DIR = "subagents";

const JSONL_EXT = ".jsonl";

/** Loosely-typed parsed JSONL line (we narrow on `type`). */
interface JsonlLine {
  type?: unknown;
  message?: unknown;
  timestamp?: unknown;
  uuid?: unknown;
  [key: string]: unknown;
}

export interface ClaudeCodeTranscriptSourceOptions {
  /** Parent dir of per-project transcript folders. Defaults to `~/.claude/projects`. */
  claudeProjectsDir?: string;
  /**
   * Glob (relative to `claudeProjectsDir`) selecting project dirs to scan.
   * Defaults to `"*"` — scan every project directory. Pass a more specific
   * pattern (e.g. `"-Users-name-Projects-minsky*"`) to scope the scan.
   */
  projectDirGlob?: string;
}

export class ClaudeCodeTranscriptSource implements TranscriptSource {
  readonly harness = HARNESS;

  private readonly claudeProjectsDir: string;
  private readonly projectDirGlob: string;

  constructor(options: ClaudeCodeTranscriptSourceOptions = {}) {
    this.claudeProjectsDir = options.claudeProjectsDir ?? join(homedir(), ".claude", "projects");
    this.projectDirGlob = options.projectDirGlob ?? DEFAULT_PROJECT_DIR_GLOB;
  }

  async *discoverSessions(): AsyncIterable<DiscoveredSession> {
    const projectDirs = await safeGlob(this.projectDirGlob, this.claudeProjectsDir);

    for (const projectDir of projectDirs) {
      yield* this.scanDir(projectDir, false);

      const sessionDirs = await safeReaddir(projectDir);
      for (const entry of sessionDirs) {
        if (!entry.isDirectory()) continue;
        const subagentsDir = join(projectDir, entry.name, SUBAGENTS_DIR);
        if (await pathExists(subagentsDir)) {
          yield* this.scanDir(subagentsDir, true);
        }
      }
    }
  }

  async *readSession(agentSessionId: AgentSessionId): AsyncIterable<RawTurnLine> {
    const path = await this.locateSessionFile(agentSessionId);
    if (!path) return;

    const raw = await safeReadFile(path);
    if (raw === null) return;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseJsonlLine(trimmed);
      if (!parsed) continue;
      if (typeof parsed.type !== "string" || !RETAINED_TYPES.has(parsed.type)) continue;
      yield parsed as RawTurnLine;
    }
  }

  getJsonlTimestamp(line: RawTurnLine): TimestampISO | undefined {
    const ts = line.timestamp;
    if (typeof ts !== "string") return undefined;
    if (Number.isNaN(Date.parse(ts))) return undefined;
    return ts;
  }

  /**
   * Resolves an agent session ID to its JSONL path.
   *
   * v1 implementation re-runs `discoverSessions()`. Acceptable at the historical
   * scale (~265 files); the mt#1351 ingest service will iterate
   * `discoverSessions()` directly and pass `jsonlPath` through, so this lookup
   * is only used by ad-hoc callers.
   */
  private async locateSessionFile(agentSessionId: AgentSessionId): Promise<string | null> {
    for await (const session of this.discoverSessions()) {
      if (session.agentSessionId === agentSessionId) return session.jsonlPath;
    }
    return null;
  }

  private async *scanDir(dir: string, isSubagent: boolean): AsyncIterable<DiscoveredSession> {
    const entries = await safeReaddir(dir);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(JSONL_EXT)) continue;
      const jsonlPath = join(dir, entry.name);
      const stat = await safeStat(jsonlPath);
      if (!stat) continue;
      yield {
        agentSessionId: basename(entry.name, JSONL_EXT),
        jsonlPath,
        harness: HARNESS,
        isSubagent,
        mtime: stat.mtime,
        cwd: await recoverCwd(jsonlPath, dir),
      };
    }
  }
}

/**
 * Recovers the session's working directory (mt#1445).
 *
 * Primary source: the `cwd` field on the first parseable user/assistant turn
 * in the JSONL — Claude Code records it on each turn and it's the most
 * reliable signal of where the session ran.
 *
 * Fallback: derive from the parent directory's name. Claude Code's
 * project-dir convention replaces `/` with `-` in the absolute project path
 * (e.g. `/Users/foo/Projects/bar` → `-Users-foo-Projects-bar`). This is
 * lossy (a literal `-` in the path collides with the separator) so it's
 * only used when the JSONL has no parseable turn with a `cwd` field.
 *
 * Returns `undefined` when neither source produces a value, so the column
 * stays NULL rather than receiving a misleading default.
 */
async function recoverCwd(jsonlPath: string, parentDir: string): Promise<string | undefined> {
  const fromTurn = await readFirstTurnCwd(jsonlPath);
  if (fromTurn) return fromTurn;
  return deriveCwdFromProjectDir(parentDir);
}

async function readFirstTurnCwd(jsonlPath: string): Promise<string | undefined> {
  const raw = await safeReadFile(jsonlPath);
  if (raw === null) return undefined;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseJsonlLine(trimmed);
    if (!parsed) continue;
    const cwd = parsed.cwd;
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
  }
  return undefined;
}

/**
 * Reverse the Claude Code project-dir naming convention. Only invoked as a
 * fallback when the JSONL has no parseable cwd; the result is best-effort.
 *
 * Subagent transcripts live two levels deep — `<projectDir>/<sessionId>/subagents/`
 * — so when the immediate parent's basename is the literal `subagents` or
 * the parent appears to be a session UUID rather than a project dir, walk up
 * to find the actual project dir before applying the convention reverse
 * (mt#1445 R1 BLOCKING).
 */
function deriveCwdFromProjectDir(parentDir: string): string | undefined {
  const projectName = findProjectDirName(parentDir);
  if (projectName === undefined) return undefined;
  return projectName.replace(/-/g, "/");
}

/**
 * Walk up from `parentDir` until we find a directory whose basename starts
 * with `-` (the Claude Code project-dir convention). Returns the basename or
 * undefined if none found within a small number of hops.
 *
 * This handles both top-level session files (parent is the project dir) and
 * subagent files (parent is `<projectDir>/<sessionId>/subagents`).
 */
function findProjectDirName(parentDir: string): string | undefined {
  let current = parentDir;
  // Cap at 3 hops to avoid walking the whole filesystem on misconfigured input:
  // the deepest legitimate case is subagents/ → sessionId/ → projectDir/ (2 hops).
  for (let i = 0; i < 3; i++) {
    const name = basename(current);
    if (name.startsWith("-") && name !== SUBAGENTS_DIR) return name;
    const next = dirname(current);
    if (next === current) return undefined; // reached filesystem root
    current = next;
  }
  return undefined;
}

function parseJsonlLine(line: string): JsonlLine | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as JsonlLine;
  } catch {
    return null;
  }
}

async function safeReaddir(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(path: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return (await safeStat(path)) !== null;
}

/**
 * Wraps `glob` to match `safeReaddir` / `safeStat` semantics: a missing or
 * inaccessible base directory yields an empty array instead of throwing.
 */
async function safeGlob(pattern: string, cwd: string): Promise<string[]> {
  if (!(await pathExists(cwd))) return [];
  try {
    return await glob(pattern, { cwd, absolute: true });
  } catch {
    return [];
  }
}

/**
 * Wraps `fs.readFile` in the same swallow-and-return-null pattern. A file that
 * is deleted, rotated, or temporarily unreadable between discovery and read
 * yields `null` instead of throwing.
 */
async function safeReadFile(path: string): Promise<string | null> {
  try {
    return String(await fs.readFile(path, "utf-8"));
  } catch {
    return null;
  }
}
