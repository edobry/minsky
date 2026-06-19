/**
 * SingleFileTranscriptSource — a TranscriptSource scoped to ONE known JSONL path.
 *
 * The cockpit transcript watcher (mt#2320) receives the exact changed file path
 * from its filesystem watcher, so it must NOT pay the cost of
 * `ClaudeCodeTranscriptSource.readSession` → `locateSessionFile` → a full
 * `discoverSessions()` walk, which stats AND fully reads every transcript under
 * `~/.claude/projects` (cwd recovery) just to resolve one id. This source reads
 * only the one file it was constructed with — O(1) per ingest instead of
 * O(all transcripts) — making `AgentTranscriptIngestService.ingestSession`
 * cheap enough to run on every append.
 *
 * The retention filter + JSONL parse are duplicated from
 * `claude-code-transcript-source.ts` intentionally: per that file's note,
 * `RETAINED_TYPES` is deliberately NOT a shared export (custom/no-domain-singleton),
 * and the legacy transcript-service keeps its own filter too. Consolidation of
 * the copies is tracked separately as mt#2042.
 *
 * @see mt#2320 — cockpit-daemon transcript watcher (the consumer)
 * @see claude-code-transcript-source.ts — the discovery-based sibling
 * @see mt#2042 — retention-filter consolidation
 */

import { promises as fs } from "fs";
import { basename } from "path";

import type {
  AgentSessionId,
  DiscoveredSession,
  RawTurnLine,
  TimestampISO,
  TranscriptSource,
} from "./transcript-source";

const HARNESS = "claude_code";
const JSONL_EXT = ".jsonl";
// Path-separator-agnostic so subagent transcripts classify correctly on Windows.
const SUBAGENTS_SEGMENT_RE = /[\\/]subagents[\\/]/;
const RETAINED_TYPES = new Set(["user", "assistant", "attachment", "system"]);

export class SingleFileTranscriptSource implements TranscriptSource {
  readonly harness = HARNESS;

  /** Memoized file contents — read once per instance (the source is constructed per event). */
  private rawCache: string | null | undefined = undefined;

  constructor(private readonly jsonlPath: string) {}

  /**
   * Build the DiscoveredSession metadata for the configured file. Throws only
   * when the file cannot be stat-ed (caller treats that as "file vanished" and
   * skips). `cwd` is recovered from the first turn that records it; the lossy
   * project-dir-name fallback in ClaudeCodeTranscriptSource is intentionally
   * omitted on this hot path — the first user turn always records `cwd`, so it
   * is available by the first append (and `cwd` is insert-only, so the watcher
   * being the first writer must set it or the column stays NULL forever).
   */
  async discovered(): Promise<DiscoveredSession> {
    const stat = await fs.stat(this.jsonlPath);
    return {
      agentSessionId: basename(this.jsonlPath, JSONL_EXT),
      jsonlPath: this.jsonlPath,
      harness: HARNESS,
      isSubagent: SUBAGENTS_SEGMENT_RE.test(this.jsonlPath),
      mtime: stat.mtime,
      cwd: await this.recoverCwd(),
    };
  }

  async *discoverSessions(): AsyncIterable<DiscoveredSession> {
    try {
      yield await this.discovered();
    } catch {
      // File vanished between the event and the read — yield nothing.
    }
  }

  /** Reads the single configured file; the `agentSessionId` argument is ignored. */
  async *readSession(_agentSessionId: AgentSessionId): AsyncIterable<RawTurnLine> {
    const raw = await this.readRaw();
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

  private async readRaw(): Promise<string | null> {
    if (this.rawCache !== undefined) return this.rawCache;
    this.rawCache = await safeReadFile(this.jsonlPath);
    return this.rawCache;
  }

  private async recoverCwd(): Promise<string | undefined> {
    const raw = await this.readRaw();
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
}

interface JsonlLine {
  type?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  [key: string]: unknown;
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

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return String(await fs.readFile(path, "utf-8"));
  } catch {
    return null;
  }
}
