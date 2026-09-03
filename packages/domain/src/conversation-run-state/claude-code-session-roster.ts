/**
 * Claude Code's live-session roster reader (mt#4869).
 *
 * Claude Code writes one small JSON file per running `claude` process to
 * `<CLAUDE_CONFIG_DIR|~/.claude>/sessions/<pid>.json` — the vendor's own docs
 * describe it as existing "to detect concurrent sessions and crashes"
 * (`code.claude.com/docs/en/claude-directory`). Verified live 2026-09-01
 * (mem#805) and 2026-09-01/02 by byte-offset scan of the desktop app's
 * `app.asar` (mem#1356): the entry for a terminal session persists for the
 * process's whole life, is removed on clean exit, and **tracks the
 * conversation the process currently holds** — after `/clear` the entry's
 * `sessionId` switched to the new id within seconds.
 *
 * This module classifies a conversation id against that roster using
 * `CliLivenessRegistry.compute()`'s own semantics (read from `app.asar`,
 * mem#1356), copied deliberately rather than invented: an entry counts as
 * live only when
 *
 *   1. it is younger than 24h by `updatedAt ?? startedAt`,
 *   2. `process.kill(pid, 0)` succeeds (EPERM counts as alive — the process
 *      exists but belongs to another user), AND
 *   3. its recorded `procStart` matches the LIVE process's actual start time
 *      — the pid-reuse guard: without it, a pid recycled by an unrelated
 *      process after the original `claude` died would read as still held.
 *
 * ANY `kind` counts (`interactive`, `bg`, `sdk`) — this mirrors the vendor's
 * `writerLivenessFor()`, not its interactive-only `livenessFor()`, because a
 * background or SDK writer forks a conversation's history exactly like an
 * interactive one holding the same file.
 *
 * **Fails CLOSED.** An unreadable roster directory, an unparseable entry, or
 * an entry over 1 MB degrades the WHOLE answer to `unknown` — never to
 * `not_running` — matching the vendor's own "mark the registry
 * uninterpretable" behavior rather than silently ignoring the bad entry. A
 * live pid whose actual start time this reader could not determine degrades
 * the SAME way: guessing `running` or `not_running` here could be wrong in
 * either direction, and `unknown` cannot be.
 *
 * @see ./attach-admissibility.ts — the gate this reader feeds
 * @see mt#4869 — this module
 */

import { readdir, readFile, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

/**
 * Filesystem seam for the roster scan — injectable (real default below) so
 * unit tests supply an in-memory fake instead of touching a real directory
 * (`custom/no-real-fs-in-tests`; mirrors `attachment-lsof.ts`'s `LsofRunner`
 * injection for the same reason).
 */
export interface RosterFs {
  /** List filenames in a directory. Rejects when the directory cannot be read. */
  readdir(dir: string): Promise<string[]>;
  /** Byte size of a file. */
  statSize(path: string): Promise<number>;
  /** Full UTF-8 contents of a file. */
  readFile(path: string): Promise<string>;
}

/** Production filesystem — the only place this module reads real files. */
export const DEFAULT_ROSTER_FS: RosterFs = {
  readdir: (dir) => readdir(dir),
  statSize: async (path) => (await stat(path)).size,
  // `String(...)`: this project's fs/promises type resolution (bun-types vs
  // @types/node) can widen `readFile`'s return to `string | Buffer` even with
  // a literal `"utf8"` encoding — the same workaround `local-workspace-backend.ts`
  // already uses.
  readFile: async (path) => String(await readFile(path, "utf8")),
};

/** Roster filenames: one per running process, keyed by pid. */
const SESSION_FILE_RE = /^\d+\.json$/;

/** Vendor's own cap (mem#1356): an entry over this size flips the whole registry to `unknown`. */
const MAX_ENTRY_BYTES = 1024 * 1024;

/** Vendor's own cap: an entry older than this by `updatedAt ?? startedAt` is not counted live. */
const MAX_ENTRY_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * One roster entry, as Claude Code writes it. Only the fields this reader
 * consumes are typed here — a real entry carries more (`cwd`, `version`,
 * `peerProtocol`, `messagingSocketPath`, `nameSource`, `bridgeSessionId`, …;
 * see mem#1356 for a full sample).
 */
interface RawRosterEntry {
  pid: number;
  sessionId: string;
  startedAt?: number;
  procStart?: string;
  kind?: string;
  entrypoint?: string;
  name?: string;
  status?: string;
  updatedAt?: number;
  statusUpdatedAt?: number;
}

function isRawRosterEntry(value: unknown): value is RawRosterEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.pid === "number" && typeof v.sessionId === "string";
}

/** Whether Claude Code's live-session roster shows a process currently holding a conversation. */
export type RosterLiveness = "running" | "not_running" | "unknown";

/**
 * Where the holding process runs, derived from its `entrypoint`/`kind`
 * fields. The `cli` entrypoint and `bg` kind are confirmed vendor values
 * (mem#805, mem#1356, and the spec's own field sample); `claude-desktop` is
 * named explicitly in mt#4869's spec. `vscode` is this reader's best-effort
 * guess at the VS Code extension's entrypoint string — UNVERIFIED against a
 * live VS Code roster entry; correct it if a real one turns up naming
 * something else.
 */
export type HolderSurface = "terminal" | "claude-desktop" | "vscode" | "background";

/** Operator-facing description of the process holding a conversation. Present when `liveness === "running"`. */
export interface RosterHolder {
  surface: HolderSurface;
  name: string | null;
  pid: number;
  /** Ms since the entry's `statusUpdatedAt`, present only when `status === "idle"`. */
  idleForMs: number | null;
}

/** The reader's full answer for one conversation id. */
export interface RosterClassification {
  liveness: RosterLiveness;
  holder: RosterHolder | null;
  /** Diagnostic — why this answer, for logs and for the gate's "roster unreadable" refusal message. */
  basis: string;
}

/**
 * Probes the OS for what the roster JSON alone cannot answer. Injectable —
 * trailing parameter with a real default — so unit tests drive specific
 * liveness/pid-reuse scenarios without `spyOn`ing `process.kill` or spawning
 * a real `ps` (testing-standards §Testable Design).
 */
export interface ProcessProbe {
  /** `process.kill(pid, 0)` semantics: true if the process exists (EPERM — exists, wrong user — counts as alive, per the vendor's own rule). */
  isAlive(pid: number): boolean;
  /** The live process's start-time string, in the same `ps -o lstart=` format the roster records, or null when it cannot be determined (process gone, `ps` unavailable, …). */
  startTimeOf(pid: number): string | null;
}

function defaultIsAlive(pid: number): boolean {
  try {
    // eslint-disable-next-line custom/no-excessive-as-unknown -- process.kill side-channel; bun-types omits it from the ambient `process` type (mirrors src/cockpit/process-identity.ts precedent)
    (process as unknown as { kill(pid: number, signal?: number): boolean }).kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Shells out to `ps -o lstart=` (project convention: `Bun.spawnSync`, not
 * `node:child_process` — see `attachment-lsof.ts`). The roster's own
 * `procStart` field is recorded in exactly this format (confirmed against a
 * live entry, mem#1356), so a direct string comparison is meaningful without
 * parsing either side into a `Date`.
 */
function defaultStartTimeOf(pid: number): string | null {
  try {
    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="]);
    const out = result.stdout.toString().trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Production process probe — the only place this module touches the OS. */
export const DEFAULT_PROCESS_PROBE: ProcessProbe = {
  isAlive: defaultIsAlive,
  startTimeOf: defaultStartTimeOf,
};

/**
 * `<CLAUDE_CONFIG_DIR|~/.claude>/sessions` — the vendor's roster directory
 * (`code.claude.com/docs/en/claude-directory`). `env`/`home` are injectable
 * with real defaults, evaluated at CALL time so a fresh read never sees a
 * stale environment.
 */
export function resolveClaudeSessionsDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  const configDir = env.CLAUDE_CONFIG_DIR;
  const base = configDir && configDir.trim().length > 0 ? configDir : join(home, ".claude");
  return join(base, "sessions");
}

/** Outcome of scanning the roster directory: either every entry parsed, or the vendor's own "uninterpretable" verdict. */
type RosterScan = { ok: true; entries: RawRosterEntry[] } | { ok: false; reason: string };

async function scanRoster(sessionsDir: string, fs: RosterFs): Promise<RosterScan> {
  let filenames: string[];
  try {
    filenames = await fs.readdir(sessionsDir);
  } catch {
    return { ok: false, reason: `the roster directory (${sessionsDir}) could not be read` };
  }

  const entries: RawRosterEntry[] = [];
  for (const filename of filenames) {
    if (!SESSION_FILE_RE.test(filename)) continue;
    const fullPath = join(sessionsDir, filename);

    let size: number;
    try {
      size = await fs.statSize(fullPath);
    } catch {
      return { ok: false, reason: `roster entry ${filename} could not be read` };
    }
    // Vendor's own cap (mem#1356): an oversized entry flips the WHOLE
    // registry to uninterpretable, matching `CliLivenessRegistry.compute()`
    // — never just the one entry, since a truncated read of it could hide
    // anything, including a match for the conversation being queried.
    if (size > MAX_ENTRY_BYTES) {
      return { ok: false, reason: `roster entry ${filename} exceeds 1 MB` };
    }

    let raw: string;
    try {
      raw = await fs.readFile(fullPath);
    } catch {
      return { ok: false, reason: `roster entry ${filename} could not be read` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: `roster entry ${filename} is not valid JSON` };
    }
    if (!isRawRosterEntry(parsed)) {
      return { ok: false, reason: `roster entry ${filename} is missing pid/sessionId` };
    }
    entries.push(parsed);
  }
  return { ok: true, entries };
}

function classifySurface(entrypoint: string | null, kind: string | null): HolderSurface {
  if (kind === "bg") return "background";
  if (entrypoint === "claude-desktop") return "claude-desktop";
  if (entrypoint === "vscode") return "vscode";
  return "terminal";
}

/**
 * Classify whether a process currently holds `conversationId`, per Claude
 * Code's own live-session roster (see module header for the exact liveness
 * rule and its fail-closed bounds).
 *
 * `sessionsDir`, `now`, and `processProbe` are trailing injected parameters
 * with real defaults (testing-standards §Testable Design) — unit tests point
 * `sessionsDir` at a fixed mock path, supply an in-memory `fs` fake (never a
 * real directory — `custom/no-real-fs-in-tests`), and drive `now`/`processProbe`
 * directly, with no `spyOn` anywhere in the reader or its callers.
 */
export async function classifyConversationHolder(
  conversationId: string,
  sessionsDir: string = resolveClaudeSessionsDir(),
  now: Date = new Date(),
  processProbe: ProcessProbe = DEFAULT_PROCESS_PROBE,
  fs: RosterFs = DEFAULT_ROSTER_FS
): Promise<RosterClassification> {
  const scan = await scanRoster(sessionsDir, fs);
  if (!scan.ok) {
    return { liveness: "unknown", holder: null, basis: scan.reason };
  }

  const match = scan.entries.find((entry) => entry.sessionId === conversationId);
  if (!match) {
    return {
      liveness: "not_running",
      holder: null,
      basis: "no roster entry names this conversation",
    };
  }

  const nowMs = now.getTime();
  const referenceMs = match.updatedAt ?? match.startedAt;
  if (referenceMs === undefined || nowMs - referenceMs >= MAX_ENTRY_AGE_MS) {
    return { liveness: "not_running", holder: null, basis: "roster entry is older than 24h" };
  }

  if (!processProbe.isAlive(match.pid)) {
    return { liveness: "not_running", holder: null, basis: `pid ${match.pid} is not running` };
  }

  // Pid-reuse guard: a `procStart` this reader cannot verify is treated the
  // same as an unparseable entry (unknown), never assumed either way.
  if (match.procStart === undefined) {
    return {
      liveness: "unknown",
      holder: null,
      basis: `roster entry for pid ${match.pid} has no procStart to verify against`,
    };
  }
  const actualStart = processProbe.startTimeOf(match.pid);
  if (actualStart === null) {
    return {
      liveness: "unknown",
      holder: null,
      basis: `could not determine pid ${match.pid}'s actual start time`,
    };
  }
  if (actualStart !== match.procStart) {
    return {
      liveness: "not_running",
      holder: null,
      basis: `pid ${match.pid} was reused by a different process`,
    };
  }

  const holder: RosterHolder = {
    surface: classifySurface(match.entrypoint ?? null, match.kind ?? null),
    name: match.name ?? null,
    pid: match.pid,
    idleForMs:
      match.status === "idle" && match.statusUpdatedAt !== undefined
        ? Math.max(0, nowMs - match.statusUpdatedAt)
        : null,
  };
  return { liveness: "running", holder, basis: "live process holds this conversation" };
}
