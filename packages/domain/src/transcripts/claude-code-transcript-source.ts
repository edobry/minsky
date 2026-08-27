/**
 * Claude Code v1 implementation of TranscriptSource.
 *
 * Scans a configurable Claude Code projects directory for JSONL transcript
 * files. Top-level files map to root agent sessions; files under
 * `<session>/subagents/` map to subagent transcripts.
 *
 * **Retention (mt#2022 update).** Filters to four JSONL line types:
 * `user`, `assistant`, `attachment`, and `system`. Routing between
 * `agent_transcripts.transcript` jsonb (turns) and the sibling
 * `agent_transcript_attachments` table (non-turn side material) happens at
 * the ingest layer (`AgentTranscriptIngestService`). The legacy
 * `AgentTranscriptService.ingestTranscript` path at
 * `src/domain/provenance/transcript-service.ts:26` still retains only
 * user/assistant for authorship-tier judging — consolidation is filed
 * separately as mt#2042 (bring-it-forward sibling of mt#2022).
 *
 * @see mt#1313 §Harness agnosticism, §Subagent transcript discovery
 * @see mt#1350 — this file
 * @see mt#2022 — RETAINED_TYPES widening + routing-at-ingest
 * @see mt#2042 — legacy filter consolidation
 */

import { promises as fs, type Dirent } from "fs";
import type { FileHandle } from "fs/promises";
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

/**
 * JSONL line types preserved from Claude Code transcripts.
 *
 * `user`/`assistant`: turn content → flows into `agent_transcripts.transcript`
 * jsonb (the canonical turn substrate).
 *
 * `attachment`/`system` (mt#2022): non-turn side material — hook injections,
 * MCP-server instructions, skill listings, deferred-tools deltas, task
 * reminders, stop-hook summaries, turn-duration metadata. These flow into the
 * sibling `agent_transcript_attachments` table via the ingest pipeline; they
 * do NOT enter the turn jsonb (preserving backwards-compat for existing
 * consumers that iterate over `transcript`). See mt#2022 "Backwards-compat
 * reasoning" section in the task spec.
 *
 * The two sub-classes (turn vs attachment) are discriminated inline in the
 * ingest pipeline via direct string equality on `line.type` — no shared
 * exported Set, per `custom/no-domain-singleton`. The grouping is documented
 * here for readers; the routing logic lives in `agent-transcript-ingest-service.ts`.
 */
/**
 * `queue-operation` (mt#3260) records the operator queueing/dequeueing a message
 * while a turn is in flight. Verified shape (2026-07-26, 170 of 1003 local
 * transcripts): `{type, operation, timestamp, sessionId}` — **no `message`, no
 * `uuid`**, unlike every other retained type.
 *
 * Retaining it is safe for turn extraction: `turn-extractor.ts` branches
 * explicitly on `line.type === "user"` / `"assistant"` and ignores every other
 * type, so a `queue-operation` line cannot open, close, or pollute a turn. It is
 * retained so queued-message state is recoverable downstream at all — before
 * this it was dropped at ingest and unrecoverable.
 */
// mt#3836: `last-prompt` is retained but NEVER stored — it is a SIDECAR type
// (`isSidecarLineType`, transcript-source.ts). It carries the only
// writer-identity trace the format offers, which the divergence detector reads
// at ingest; it has no timestamp and no content, so every storage path drops it
// anyway. Consumers must not count it toward `lineIndex` — see the predicate's
// docblock for why that matters to the attachments primary key.
const RETAINED_TYPES = new Set([
  "user",
  "assistant",
  "attachment",
  "system",
  "queue-operation",
  "last-prompt",
]);

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

/**
 * How many directory levels below a session's `subagents/` directory to walk
 * (mt#3294).
 *
 * The only nesting the harness produces today is one level —
 * `subagents/workflows/<wf-id>/` — so 3 leaves room for it to grow twice more
 * without another silent-invisibility incident, while still refusing to walk an
 * arbitrarily deep tree if something unexpected (a symlink loop, a stray
 * checkout) lands under there. Chosen over an unbounded walk because discovery
 * runs over the whole corpus on every sweep and an unbounded descent is how
 * that becomes someone else's incident.
 */
export const MAX_SUBAGENT_TREE_DEPTH = 3;

const JSONL_EXT = ".jsonl";

/**
 * `.jsonl` basenames under a session tree that are NOT conversations (mt#4480).
 *
 * The Workflow tool writes a run journal at
 * `subagents/workflows/<wf-id>/journal.jsonl`, which `scanSubagentTree`'s
 * deliberately-general recursion picks up like any other transcript. It then
 * yields the literal `agentSessionId` `"journal"` — a value no harness ever
 * mints, since Claude Code ids are UUIDs or `agent-`-prefixed hashes.
 *
 * The cost was not a failed ingest. It was a MEASUREMENT: `transcripts list
 * --check-disk-coverage` reports on-disk sessions with no row, so three journal
 * files read as three permanently-never-ingested conversations that no amount
 * of backfilling would ever clear — a small standing false positive in exactly
 * the surface that exists to prove ingest coverage is complete.
 *
 * Matched on the exact basename rather than on "looks like a UUID": subagent
 * transcripts are legitimately named `agent-<hex>`, so a shape test would have
 * to encode every id convention the harness uses and would silently drop real
 * transcripts the day it adds another.
 */
const NON_CONVERSATION_BASENAMES = new Set(["journal"]);

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
          yield* this.scanSubagentTree(subagentsDir);
        }
      }
    }
  }

  /**
   * Stream EVERY parsed line in the file, in file order, with no type filter
   * (mt#4573).
   *
   * This is the unfiltered sibling of {@link readSession}, and it exists
   * because `RETAINED_TYPES` below is not a neutral cleanup: measured
   * 2026-08-25, the types it drops (`bridge-session`, `mode`, `custom-title`,
   * `permission-mode`, `ai-title`, `agent-name`, `file-history-snapshot`) are
   * ~24% of lines by count, and they are exactly the un-timestamped ones — so
   * nothing downstream of the timestamp high-water-mark can ever see them.
   * `transcript_lines` keys on position instead and therefore can.
   *
   * **Ordinal semantics.** The consumer's ordinal is the index of the yielded
   * line among lines that were non-empty AND parsed. A line that fails to parse
   * is skipped here exactly as it is in `readSession`, so it consumes no
   * ordinal and cannot be reconstructed later. That is a real fidelity bound,
   * and a narrow one: the harness writes well-formed JSON, and a line it
   * mangled is not one we could store as `jsonb` anyway.
   */
  async *readSessionRaw(
    agentSessionId: AgentSessionId,
    jsonlPath?: string
  ): AsyncIterable<RawTurnLine> {
    const path = jsonlPath ?? (await this.locateSessionFile(agentSessionId));
    if (!path) return;

    const raw = await safeReadFile(path);
    if (raw === null) return;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseJsonlLine(trimmed);
      if (!parsed) continue;
      yield parsed as RawTurnLine;
    }
  }

  /**
   * The harness-specific retention predicate, exposed so a caller iterating
   * {@link readSessionRaw} can reproduce {@link readSession}'s filtering
   * without knowing which types this source retains (mt#4573).
   */
  isRetainedLine(line: RawTurnLine): boolean {
    return typeof line.type === "string" && RETAINED_TYPES.has(line.type);
  }

  async *readSession(
    agentSessionId: AgentSessionId,
    jsonlPath?: string
  ): AsyncIterable<RawTurnLine> {
    for await (const parsed of this.readSessionRaw(agentSessionId, jsonlPath)) {
      if (!this.isRetainedLine(parsed)) continue;
      yield parsed;
    }
  }

  getJsonlTimestamp(line: RawTurnLine): TimestampISO | undefined {
    const ts = line.timestamp;
    if (typeof ts !== "string") return undefined;
    if (Number.isNaN(Date.parse(ts))) return undefined;
    return ts;
  }

  /**
   * Resolves an agent session ID to its JSONL path by scanning `discoverSessions()`.
   *
   * O(all transcripts) per call, so it is reserved for callers that genuinely
   * have only an id — today that is `scripts/backfill-agent-transcript-attachments.ts`.
   * Any caller holding a `DiscoveredSession` MUST pass `jsonlPath` to
   * `readSession` instead.
   *
   * This docblock previously asserted the ingest service already passed the path
   * through, so the lookup was "only used by ad-hoc callers." That was false:
   * `ingestSession` called `readSession(agentSessionId)` on every session, making
   * `ingestAll` quadratic — measured at 1 ms for the first session in discovery
   * order and 681 ms for the last, against 0-1 ms for a path-scoped read of the
   * same file. mt#3288 made the path a parameter and fixed the caller.
   */
  private async locateSessionFile(agentSessionId: AgentSessionId): Promise<string | null> {
    return (await this.locateSession(agentSessionId))?.jsonlPath ?? null;
  }

  /**
   * Public sibling of {@link locateSessionFile} that returns the whole
   * {@link DiscoveredSession} rather than only its path (mt#3095).
   *
   * Attaching a session driver to a conversation Minsky did not spawn needs the
   * `cwd` as much as the path — `claude --resume` must run in the directory the
   * conversation belongs to. Discovery already resolves `cwd` for every session
   * it yields (see `yieldTranscripts`, which calls `recoverCwd`), so this
   * exposes information already computed instead of adding a second reader.
   *
   * Same linear-scan cost as `locateSessionFile`, and the same caveat: callers
   * that already hold a path should use it rather than scanning to re-derive one.
   */
  async locateSession(agentSessionId: AgentSessionId): Promise<DiscoveredSession | null> {
    for await (const session of this.discoverSessions()) {
      if (session.agentSessionId === agentSessionId) return session;
    }
    return null;
  }

  /**
   * Walk a session's `subagents/` tree, yielding every transcript at any depth
   * (mt#3294).
   *
   * The tree is not flat. Workflow-spawned subagents write one level deeper, at
   * `subagents/workflows/<wf-id>/*.jsonl`, and the original one-level scan
   * skipped those directories entirely — 41 of 1,024 local transcripts were
   * invisible to every sweep, including one whose stored row sat at 48 lines
   * against 109 on disk. It had 48 at all only because some other write path
   * had reached it, which is what made the gap quiet: the row existed and
   * looked plausible.
   *
   * Recursing generally rather than special-casing `workflows/`: the harness
   * introduced that nesting without any change on our side, so matching the one
   * shape we happen to know about leaves the next one just as invisible. Depth
   * is bounded anyway — see {@link MAX_SUBAGENT_TREE_DEPTH}.
   *
   * Everything found here is a subagent transcript by construction (it is under
   * `subagents/`), so `isSubagent` is true at every depth.
   *
   * Reads each directory ONCE and partitions the entries, rather than calling
   * `scanDir` (which reads) and then reading again to recurse — the directory
   * count here multiplies across every session on every sweep (PR #2377 R1).
   *
   * Symlinked directories are not descended, and no explicit check is needed
   * for that: `readdir` with `withFileTypes` reports a symlink via
   * `isSymbolicLink()` and NOT `isDirectory()` (lstat semantics), so the filter
   * below already excludes them. An added `|| entry.isSymbolicLink()` was tried
   * and removed as dead code — the symlink test below passes with and without
   * it, which is the evidence. The test is kept as a lock on that platform
   * behavior, since the safety of this walk depends on it (PR #2377 R1).
   */
  private async *scanSubagentTree(dir: string, depth = 0): AsyncIterable<DiscoveredSession> {
    const entries = await safeReaddir(dir);
    yield* this.yieldTranscripts(dir, entries, true);
    if (depth >= MAX_SUBAGENT_TREE_DEPTH) return;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      yield* this.scanSubagentTree(join(dir, entry.name), depth + 1);
    }
  }

  private async *scanDir(dir: string, isSubagent: boolean): AsyncIterable<DiscoveredSession> {
    yield* this.yieldTranscripts(dir, await safeReaddir(dir), isSubagent);
  }

  /** Yield a `DiscoveredSession` for each `.jsonl` file among already-read entries. */
  private async *yieldTranscripts(
    dir: string,
    entries: Dirent[],
    isSubagent: boolean
  ): AsyncIterable<DiscoveredSession> {
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(JSONL_EXT)) continue;
      if (NON_CONVERSATION_BASENAMES.has(basename(entry.name, JSONL_EXT))) continue;
      const jsonlPath = join(dir, entry.name);
      const stat = await safeStat(jsonlPath);
      if (!stat) continue;
      yield {
        agentSessionId: basename(entry.name, JSONL_EXT) as AgentSessionId,
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

/**
 * Sized so the common case resolves in a single read: the deepest first-`cwd`
 * byte offset observed across the local 1,024-file corpus is 4,879 bytes, and
 * 1,023 of those files resolve within one chunk.
 */
const CWD_SCAN_CHUNK_BYTES = 64 * 1024;

/**
 * Reads the JSONL a chunk at a time and stops at the first line carrying a
 * `cwd`, instead of loading the whole file to inspect (almost always) its first
 * line. `discoverSessions` calls this once per transcript, so this is the
 * difference between a discovery pass reading the entire corpus and reading only
 * its head: measured over the local corpus, 1,524 MB versus 4 MB.
 *
 * Behavior is unchanged, not merely bounded — a file whose first `cwd` sits past
 * the first chunk keeps reading, and a file with no `cwd` at all is still read to
 * EOF before the caller falls back to the parent-directory derivation.
 *
 * Not built on `JsonlTailer` (`jsonl-tailer.ts`): that primitive follows appends
 * from a stored per-path offset and reads through to EOF in one call, which is
 * the opposite of the bounded head read wanted here.
 */
async function readFirstTurnCwd(jsonlPath: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(jsonlPath, "r");
    // Uint8Array + TextDecoder (not Buffer): the decoder is kept across reads
    // with `stream: true` so a multi-byte UTF-8 character split across a chunk
    // boundary decodes correctly instead of becoming a replacement character.
    const chunk = new Uint8Array(CWD_SCAN_CHUNK_BYTES);
    const decoder = new TextDecoder();
    let pending = "";
    let position = 0;

    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, CWD_SCAN_CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      pending += decoder.decode(chunk.subarray(0, bytesRead), { stream: true });

      const lastNewline = pending.lastIndexOf("\n");
      if (lastNewline === -1) continue;
      const cwd = findCwdInLines(pending.slice(0, lastNewline));
      if (cwd) return cwd;
      pending = pending.slice(lastNewline + 1);
    }

    // Trailing line with no terminating newline.
    return findCwdInLines(pending + decoder.decode());
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function findCwdInLines(text: string): string | undefined {
  for (const line of text.split("\n")) {
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
 * This handles top-level session files (parent is the project dir), subagent
 * files (parent is `<projectDir>/<sessionId>/subagents`), and subagent files
 * nested deeper still (`.../subagents/workflows/<wf-id>`, mt#3294).
 */
function findProjectDirName(parentDir: string): string | undefined {
  let current = parentDir;
  // Hop budget must cover the deepest path scanSubagentTree can reach:
  // <wf-id>/ → workflows/ → subagents/ → sessionId/ → projectDir/. That is
  // 2 hops for a flat subagent dir plus MAX_SUBAGENT_TREE_DEPTH more for the
  // nesting below it, +1 so the projectDir itself is inspected rather than
  // just stepped onto. Derived from the depth cap rather than hard-coded, so
  // raising one cannot silently outrun the other — the previous fixed cap of 3
  // stopped one directory short of the project dir for workflow-nested files,
  // which would have left their cwd undefined once discovery could see them.
  const maxHops = 2 + MAX_SUBAGENT_TREE_DEPTH + 1;
  for (let i = 0; i < maxHops; i++) {
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
