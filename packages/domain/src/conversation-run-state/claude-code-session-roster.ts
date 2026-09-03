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
 *   3. the LIVE process's actual start time matches the roster entry's own
 *      `startedAt` — the pid-reuse guard: without it, a pid recycled by an
 *      unrelated process after the original `claude` died would read as
 *      still held.
 *
 * **Design correction from live testing (mt#4869 AT1, 2026-09-03): the
 * pid-reuse guard compares EPOCH values (`startedAt` vs. an elapsed-seconds
 * derived "now minus elapsed-time"), never the roster's `procStart` STRING
 * field.** The spec's original design, matching the vendor's own
 * documented rule, called for comparing `procStart` (a `ps -o lstart=`-style
 * ctime string) against a freshly-queried `ps -o lstart=` for the live pid.
 * A live acceptance run against a genuinely-held real conversation exposed a
 * defect in that design: on this host (and, by the general mechanism, any
 * host not in UTC), the roster's recorded `procStart` for a KNOWN-correct,
 * still-running process differs from a freshly-queried `ps -o lstart=` for
 * the SAME process by exactly the local UTC offset (confirmed 4h — EDT — by
 * converting the entry's own `startedAt` epoch to local time and finding it
 * matches the fresh `ps` reading exactly, while `procStart` does not). That
 * is the CLI's own recorded field, not this reader's query, that carries the
 * offset — the string comparison this spec originally specified would
 * ALWAYS treat a live, correctly-matching process as pid-reused, defeating
 * the guard outright and admitting an attach against a conversation a real
 * terminal process was actively holding (observed live: a request that
 * should have 409'd returned 201 and spawned a competing writer; killed
 * within seconds, no fork resulted — see the PR body's negative-control
 * section). `startedAt` is an unambiguous epoch-ms field with no
 * string-format/TZ hazard, and `ps -o etime=` (a pure elapsed-time
 * duration, not a wall-clock ctime string) gives an equally unambiguous
 * fresh reading once parsed; comparing the
 * two within a small tolerance reproduces the SAME pid-reuse detection the
 * vendor's `procStart` check is trying to provide, without inheriting its
 * formatting hazard. `procStart` is still read and required to be present
 * (matching the roster's real shape, and useful for logs), just not used in
 * the comparison itself.
 *
 * ANY `kind` counts (`interactive`, `bg`, `sdk`) — this mirrors the vendor's
 * `writerLivenessFor()`, not its interactive-only `livenessFor()`, because a
 * background or SDK writer forks a conversation's history exactly like an
 * interactive one holding the same file.
 *
 * **Fails CLOSED.** An unreadable roster directory, an unparseable entry, or
 * an entry over 1 MB degrades the WHOLE answer to `unknown` — never to
 * `not_running` — matching the vendor's own "mark the registry
 * uninterpretable" behavior rather than silently ignoring the bad entry.
 * **This is by design, not a gap**: ONE malformed or oversized roster file
 * — out of however many other processes' entries sit beside it — is enough
 * to flip the WHOLE registry to `unknown` (PR #3592 R1 nit 5), because a
 * truncated or corrupt read of it could hide anything, including a match for
 * the conversation being queried; the vendor's own `CliLivenessRegistry`
 * takes the identical stance. A live pid whose actual start time this
 * reader could not determine degrades the SAME way: guessing `running` or
 * `not_running` here could be wrong in either direction, and `unknown`
 * cannot be.
 *
 * **Platform support.** `ps -o etime=` (the pid-reuse guard's OS query)
 * exists on macOS and Linux; Windows has no `ps` at all. `defaultStartTimeOf`
 * checks `process.platform` before ever shelling out and returns `null` on
 * an unsupported platform — same fail-closed path as any other
 * undeterminable start time, so a Windows host reads every live pid as
 * `unknown` (refused) rather than crashing or misclassifying (PR #3592 R1
 * nit 2).
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
 * Pid-reuse guard tolerance: how far a fresh, epoch-based start-time reading
 * may differ from the roster's `startedAt` and still count as the SAME
 * process. `ps -o etime=` has whole-second granularity, and there is
 * measurement latency between when the CLI captured `startedAt` and when
 * this reader queries the OS — a few seconds of slop is expected noise, not
 * evidence of reuse. Generous relative to that noise floor, and still far
 * tighter than any realistic reuse gap (see the module header's "Design
 * correction from live testing" note for why this replaced a `procStart`
 * string comparison).
 */
const PROC_START_TOLERANCE_MS = 5_000;

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
 * fields. Confirmed vendor values, by live measurement: `cli` entrypoint
 * (mem#805, mem#1356) → terminal; `bg` kind → background; `sdk-cli`
 * entrypoint (mt#4869 AT3, 2026-09-03: the cockpit's own long-lived `-p
 * --input-format stream-json` actuator registers with `kind: "interactive"`,
 * `entrypoint: "sdk-cli"` — NOT `bg` as the naming might suggest) → also
 * background, since Minsky's own driven-session actuator is exactly that,
 * regardless of what `kind` the vendor tags it with. `claude-desktop` is
 * named explicitly in mt#4869's spec, unverified live this session. `vscode`
 * is this reader's best-effort guess at the VS Code extension's entrypoint
 * string — UNVERIFIED against a live VS Code roster entry; correct it if a
 * real one turns up naming something else.
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
  /**
   * The live process's actual start time, as an epoch-ms number derived from
   * an OS query (elapsed time, not a parsed ctime string — see the module
   * header's "Design correction" note for why), or null when it cannot be
   * determined (process gone, `ps` unavailable, …).
   */
  startTimeOf(pid: number): number | null;
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
 * Parses `ps -o etime=`'s `[[dd-]hh:]mm:ss` elapsed-time format into whole
 * seconds. `etime` (not the GNU-only `etimes`) is the POSIX-portable
 * keyword — verified live 2026-09-03 that macOS's BSD `ps` rejects `etimes`
 * outright ("keyword not found") while GNU `ps` accepts `etime` too, so this
 * is the cross-platform choice, not merely the macOS one.
 */
function parseEtimeToSeconds(etime: string): number | null {
  const match = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const days = match[1] ? Number.parseInt(match[1], 10) : 0;
  const hours = match[2] ? Number.parseInt(match[2], 10) : 0;
  const minutes = Number.parseInt(match[3] as string, 10);
  const seconds = Number.parseInt(match[4] as string, 10);
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/**
 * Platforms `ps -o etime=` is known to support — verified live 2026-09-03 on
 * macOS's BSD `ps`; Linux's GNU `ps` documents the same keyword. Windows has
 * no `ps` at all, so this is a real portability boundary, not a theoretical
 * one (PR #3592 R1 nit 2).
 */
const PS_PROBE_SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);

/**
 * Shells out to `ps -o etime=` (project convention: `Bun.spawnSync`, not
 * `node:child_process` — see `attachment-lsof.ts`) for the process's ELAPSED
 * time and derives an epoch-ms start time as `Date.now() - elapsedSeconds *
 * 1000`. See the module header's "Design correction from live testing"
 * note: a `ps -o lstart=` ctime string was tried first and found to
 * disagree with the roster's own `procStart` field by exactly the local UTC
 * offset on a real host, which would have defeated the pid-reuse guard on
 * every non-UTC machine. `etime` sidesteps any wall-clock/timezone
 * formatting entirely — it is a pure duration.
 *
 * `platform` is a trailing injected parameter (real default `process.platform`,
 * same convention as `resolveClaudeSessionsDir`'s `env`/`home`) so the
 * Windows guard below is unit-testable with no `spyOn`: on any platform
 * outside `PS_PROBE_SUPPORTED_PLATFORMS` this returns `null` BEFORE ever
 * shelling out, which `classifyConversationHolder` reads as `unknown` — this
 * module's existing fail-closed rule for "could not determine the live
 * process's actual start time", extended to cover "the OS this runs on has
 * no way to ask."
 */
export function defaultStartTimeOf(
  pid: number,
  platform: string = process.platform
): number | null {
  if (!PS_PROBE_SUPPORTED_PLATFORMS.has(platform)) return null;
  try {
    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "etime="]);
    const out = result.stdout.toString().trim();
    const elapsedSeconds = parseEtimeToSeconds(out);
    if (elapsedSeconds === null) return null;
    return Date.now() - elapsedSeconds * 1000;
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
  // `sdk-cli` is Minsky's OWN driven-session actuator (confirmed live,
  // mt#4869 AT3) — a background driver regardless of the `kind` the vendor
  // tags it with (observed "interactive", not "bg").
  if (kind === "bg" || entrypoint === "sdk-cli") return "background";
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

  // Pid-reuse guard: `procStart` (the CLI's own ctime-string field) is still
  // required to be present, matching the roster's real shape — but the
  // COMPARISON is epoch-based against `startedAt`, not a `procStart` string
  // match. See the module header's "Design correction from live testing"
  // note for why the string comparison was replaced after AT1 exposed a
  // real TZ-formatting mismatch in the CLI's own recorded `procStart`.
  if (match.procStart === undefined || match.startedAt === undefined) {
    return {
      liveness: "unknown",
      holder: null,
      basis: `roster entry for pid ${match.pid} has no procStart/startedAt to verify against`,
    };
  }
  const actualStartMs = processProbe.startTimeOf(match.pid);
  if (actualStartMs === null) {
    return {
      liveness: "unknown",
      holder: null,
      basis: `could not determine pid ${match.pid}'s actual start time`,
    };
  }
  if (Math.abs(actualStartMs - match.startedAt) > PROC_START_TOLERANCE_MS) {
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
