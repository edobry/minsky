/**
 * Harness-pid → conversation-id mapping (mt#3900, ADR-006 §Layer 3 amendment).
 *
 * ## The problem this exists for
 *
 * The stdio proxy resolves `CLAUDE_CODE_SESSION_ID` ONCE, at spawn, and stamps
 * that conversation id into every `tools/call` frame. A `/clear` (or in-process
 * resume, or fork) changes the conversation WITHOUT respawning MCP servers, so
 * every later call is attributed to the conversation that happened to be live
 * when the proxy started. Presence claims then record an agent's own work under
 * a stranger's id, and the collision probe reports a phantom peer.
 *
 * ADR-006 named the remedy: "a SessionStart hook writing a `<claude-pid> →
 * sessionId` mapping the proxy re-reads per request." This module is that
 * mapping — deliberately shared, because the WRITER (a SessionStart hook) and
 * the READER (the proxy) must agree on the pid, and a disagreement fails
 * silently: the reader looks up a pid nobody wrote and falls back to the stale
 * env value, which is exactly the bug, with no error anywhere.
 *
 * ## Why pid, and not something friendlier
 *
 * Several `claude` processes run at once on a working machine (five, when this
 * was measured), so anything project-scoped or "the current conversation"
 * cannot identify WHICH one is asking. The pid can: both the hook and the proxy
 * are spawned by the harness, so both can walk to the same `claude` ancestor.
 *
 * @see docs/architecture/adr-006-agent-identity.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMinskyStateDir } from "./paths";

/**
 * The filesystem operations this module needs, injectable so tests exercise
 * the real logic without touching disk (`custom/no-real-fs-in-tests`).
 */
export interface MappingIo {
  ensureDir(dir: string): void;
  read(path: string): string | null;
  write(path: string, contents: string): void;
}

/** Real-filesystem {@link MappingIo}. The default for every caller. */
export const realMappingIo: MappingIo = {
  ensureDir: (dir) => {
    mkdirSync(dir, { recursive: true });
  },
  read: (path) => (existsSync(path) ? String(readFileSync(path, "utf8")) : null),
  write: (path, contents) => {
    writeFileSync(path, contents, "utf8");
  },
};

/** Directory holding one JSON file per live harness pid. */
export function getConversationPidMapDir(): string {
  return join(getMinskyStateDir(), "conversation-by-pid");
}

/** Absolute path of the mapping file for `pid`. */
export function getConversationPidMapPath(pid: number): string {
  return join(getConversationPidMapDir(), `${pid}.json`);
}

/** What a mapping file holds. `updatedAt` is an ISO-8601 instant. */
export interface ConversationPidMapping {
  conversationId: string;
  updatedAt: string;
  /** Which SessionStart `source` wrote it — diagnostic only, never matched on. */
  source?: string;
}

/**
 * Process names accepted as "the harness". Matched against the basename of the
 * executable, case-sensitively.
 */
const HARNESS_PROCESS_NAMES: readonly string[] = ["claude"];

/**
 * How many ancestors to examine before giving up.
 *
 * A harness-spawned child is usually the harness's DIRECT child — measured on
 * macOS 2026-08-10, a harness-spawned shell reported the `claude` process as
 * its parent. But frames accumulate easily: a hook declared as a shell command
 * is spawned through `/bin/sh -c`, and anything that runs the hook indirectly
 * (a wrapper script, a test harness, a `cmd-a && cmd-b` chain) adds more.
 *
 * Sized generously on purpose. Falling one hop short does NOT produce an error
 * — it produces a null, which sends the caller back to the stale spawn-time env
 * value, i.e. silently reintroduces the exact defect this module exists to fix.
 * The cost of being generous is bounded and paid once per process (one `ps` per
 * hop, at startup only), while the cost of being stingy is invisible. Observed
 * during mt#3900's own live verification: a budget of 4 was enough for the hook
 * spawned directly by the harness but NOT for the same hook spawned by a
 * verification script two frames deeper, which failed closed and looked like a
 * broken write.
 *
 * The walk still terminates at pid 1, so a machine with no harness at all costs
 * at most this many `ps` calls before returning null.
 */
const MAX_ANCESTOR_HOPS = 12;

/** RFC-4122 textual form, case-insensitive — the shape of a conversation id. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read one process's parent pid and command name via `ps`.
 *
 * Returns null when the pid is gone or `ps` is unavailable/unparseable — every
 * caller treats that as "stop walking", never as an error.
 */
function readProcessInfo(pid: number): { ppid: number; comm: string } | null {
  try {
    // `-o ppid=,comm=` prints only the values, no header, so there is nothing
    // to skip. `comm` is the executable name, not the full argv, so a
    // conversation id appearing in someone's arguments cannot influence it.
    const result = Bun.spawnSync(["ps", "-o", "ppid=,comm=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!result.success) return null;

    const out = new TextDecoder().decode(result.stdout).trim();
    if (!out) return null;

    const match = out.match(/^\s*(\d+)\s+(.*)$/);
    if (!match?.[1] || match[2] === undefined) return null;

    const ppid = Number.parseInt(match[1], 10);
    if (!Number.isFinite(ppid)) return null;

    // `comm` may be a full path (Linux) or a bare name (macOS) — compare the
    // basename either way.
    const comm = match[2].trim();
    const basename = comm.slice(comm.lastIndexOf("/") + 1);
    return { ppid, comm: basename };
  } catch {
    return null;
  }
}

/**
 * Walk up from `startPid` to the nearest harness process and return its pid.
 *
 * Returns null when no harness ancestor is found within {@link MAX_ANCESTOR_HOPS}
 * — a non-Claude-Code parent, a manually launched proxy, a test. Callers fall
 * back to their existing behavior rather than guessing.
 *
 * Both the SessionStart writer and the proxy reader MUST use this same
 * function; that shared use is the whole point of putting it here.
 */
/**
 * This repo's ambient `process` shim (`src/types/node.d.ts`) omits `ppid`.
 * Same cast `src/mcp/server.ts` uses for the same reason.
 */
function ownParentPid(): number {
  return (process as typeof process & { ppid?: number }).ppid ?? 0;
}

export function resolveHarnessPid(
  startPid: number = ownParentPid(),
  readInfo: (pid: number) => { ppid: number; comm: string } | null = readProcessInfo
): number | null {
  let pid = startPid;

  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
    const info = readInfo(pid);
    if (!info) return null;
    if (HARNESS_PROCESS_NAMES.includes(info.comm)) return pid;

    // pid 1 (init/launchd) has itself or 0 as parent; either way there is
    // nothing above it worth examining.
    if (info.ppid <= 1) return null;
    pid = info.ppid;
  }

  return null;
}

/**
 * Record `conversationId` as the conversation belonging to `harnessPid`.
 *
 * Never throws: this runs inside a hook, and a hook must not block the event it
 * observes. Returns whether the write landed so a caller can log it.
 */
export function writeConversationMapping(
  harnessPid: number,
  conversationId: string,
  source?: string,
  io: MappingIo = realMappingIo
): boolean {
  if (!UUID_RE.test(conversationId)) return false;

  try {
    io.ensureDir(getConversationPidMapDir());
    const payload: ConversationPidMapping = {
      conversationId: conversationId.toLowerCase(),
      updatedAt: new Date().toISOString(),
      ...(source ? { source } : {}),
    };
    io.write(getConversationPidMapPath(harnessPid), `${JSON.stringify(payload)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the conversation id recorded for `harnessPid`, or null.
 *
 * Null covers every "we don't know" case — no file, unreadable, malformed JSON,
 * a non-UUID payload. The caller falls back to the spawn-time env value; it
 * must never fabricate an id, per ADR-006's Layer-3 conservatism.
 *
 * No staleness check on `updatedAt`: the only pid ever looked up is the
 * caller's OWN live harness ancestor, so the entry cannot belong to a dead
 * process unless the OS recycled that pid onto another `claude` — in which case
 * the entry is rewritten by that session's own SessionStart before it can serve
 * a single tool call.
 */
export function readConversationMapping(
  harnessPid: number,
  io: MappingIo = realMappingIo
): string | null {
  try {
    const contents = io.read(getConversationPidMapPath(harnessPid));
    if (contents === null) return null;

    const parsed: unknown = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object") return null;

    const id = (parsed as Partial<ConversationPidMapping>).conversationId;
    if (typeof id !== "string" || !UUID_RE.test(id)) return null;

    return id.toLowerCase();
  } catch {
    return null;
  }
}
