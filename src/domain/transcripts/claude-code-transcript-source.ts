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
import { basename, join } from "path";

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

const DEFAULT_PROJECT_DIR_GLOB = "-Users-edobry-Projects-minsky*";

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
  /** Glob (relative to claudeProjectsDir) selecting project dirs to scan. */
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
    const projectDirs = await glob(this.projectDirGlob, {
      cwd: this.claudeProjectsDir,
      absolute: true,
    });

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

    const raw = String(await fs.readFile(path, "utf-8"));
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
    if (ts === undefined) return undefined;
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
      };
    }
  }
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
