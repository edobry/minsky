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

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getMinskyStateDir } from "./paths";

/**
 * The filesystem operations this module needs, injectable so tests exercise
 * the real logic without touching disk (`custom/no-real-fs-in-tests`).
 */
export interface MappingIo {
  ensureDir(dir: string): void;
  read(path: string): string | null;
  write(path: string, contents: string): void;
  /** Append one line to a log. Separate from {@link MappingIo.write} because
   *  the transition log is append-only while the mapping file is replaced. */
  append(path: string, line: string): void;
  /**
   * Entry filenames in a directory, and removal of one (mt#4378's prune).
   *
   * OPTIONAL so every existing test double keeps satisfying this interface
   * without change — a fake that omits them simply does not prune, which is
   * today's behavior and cannot make a mapping wrong. Making them required
   * would have forced an edit to every unrelated fixture, and a mechanical
   * sweep like that is where a real behavioral change hides.
   */
  list?(dir: string): string[];
  remove?(path: string): void;
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
  append: (path, line) => {
    appendFileSync(path, line, "utf8");
  },
  list: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
  remove: (path) => {
    rmSync(path, { force: true });
  },
};

/** Directory holding one JSON file per live harness pid. */
export function getConversationPidMapDir(): string {
  return join(getMinskyStateDir(), "conversation-by-pid");
}

/**
 * Append-only log of observed conversation transitions (mt#3943).
 *
 * One JSON object per line, mirroring `.minsky/hooks/guard-health.ts`'s
 * `guard-health-log.jsonl` rather than introducing a second logging idiom.
 * Unbounded by design: measured at ~10 transitions/hour on a busy machine
 * (~48 KB/day at ~200 bytes/record), and the project's convention for this file
 * class is that older records stay on disk (ADR-032 states it for the
 * calibration logs — cited as precedent, not as authority over this file).
 */
export function getConversationTransitionLogPath(): string {
  return join(getMinskyStateDir(), "conversation-transitions.jsonl");
}

/**
 * One observed replacement of a conversation on a harness pid.
 *
 * Deliberately a record of WHAT THE HARNESS DID, not of what it meant. There is
 * no `continuesFrom` here and there must not be: a `/clear` frequently means
 * "new, unrelated topic" — operators clear context precisely to STOP continuing
 * — and a `fork` produces a sibling whose predecessor may stay live on another
 * pid. Succession is a judgment derived or asserted over these facts (mt#2911's
 * authored handoff), and baking it in here would make an inference
 * indistinguishable from an observation at the lowest layer of the substrate.
 */
export interface ConversationTransition {
  /** The conversation that was mapped to this pid before the switch. */
  predecessor: string;
  /** The conversation that replaced it. */
  successor: string;
  /** SessionStart's own `source`: startup | resume | clear | compact | fork. */
  source?: string;
  harnessPid: number;
  /** Start time of the harness process that wrote the SUCCESSOR. */
  harnessStartedAt?: string;
  /**
   * Start time recorded alongside the PREDECESSOR, when the prior entry carried
   * one (PR #2791 R1).
   *
   * Both are needed, and the successor's alone is not enough: a pid identifies a
   * process only together with its start time, so an edge where these two
   * DIFFER was manufactured by the OS handing the pid to an unrelated harness —
   * not by an operator switching conversations. With only one timestamp a
   * reader of this log cannot tell those apart, which would make the log's
   * headline fact unreliable exactly where it matters.
   */
  predecessorHarnessStartedAt?: string;
  at: string;
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
  /**
   * The harness process's start time, verbatim from `ps -o lstart=`.
   *
   * This is what makes a pid safe to key on. A pid alone is ambiguous across
   * time — the OS recycles it — so an entry written by one `claude` could be
   * read as if it belonged to a later, unrelated `claude` that happened to
   * inherit the number. Pid PLUS start time identifies a specific process
   * instance, so a recycled pid fails the comparison and the entry is treated
   * as absent (PR #2764 R1, SC5/AT4).
   */
  harnessStartedAt?: string;
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
 * Read a process's start time as `ps` reports it, or null when the process is
 * gone or `ps` is unusable.
 *
 * The exact format does not matter — it is only ever compared verbatim against
 * a value produced the same way on the same machine.
 */
/**
 * Whether a pid names a running process — the THREE-valued answer (mt#4378).
 *
 * `readProcessStartTime` below returns `null` for two different facts: the
 * process is GONE, and `ps` could not be run. That conflation is the defect
 * this task exists to fix. `readConversationMapping`'s recycling check
 * tolerates a `null` (correctly — a failed `ps` is not evidence of recycling),
 * so a DEAD pid's entry sailed through and was returned as a live mapping. The
 * store never prunes, so a two-day-old entry for a pid nobody is running is
 * byte-indistinguishable from a current one, and there is no fallback to
 * observe because nothing looks absent. That is the mem#704 shape: the probe
 * returns a well-formed answer whether or not the system is healthy.
 *
 * `process.kill(pid, 0)` sends no signal and only performs the existence and
 * permission check, which is what makes the three cases separable:
 *   - resolves           -> the process exists and is ours
 *   - throws `EPERM`     -> it EXISTS and belongs to another user
 *   - throws `ESRCH`     -> no such process
 *   - anything else      -> we cannot tell, and must not guess
 *
 * `EPERM` is deliberately `alive`: the question is whether the pid is running,
 * not whether we may signal it. Reading it as dead would discard a live
 * mapping, which is the false-negative direction.
 */
export type ProcessLiveness = "alive" | "dead" | "unknown";

export function processLiveness(pid: number): ProcessLiveness {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  // This repo's ambient `process` shim (`src/types/node.d.ts`) omits `kill`,
  // the same omission `ownParentPid` below casts around for `ppid`.
  const kill = (process as typeof process & { kill?: (pid: number, signal: number) => void }).kill;
  if (typeof kill !== "function") return "unknown";
  try {
    kill(pid, 0);
    return "alive";
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

export function readProcessStartTime(pid: number): string | null {
  try {
    const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!result.success) return null;

    const out = new TextDecoder().decode(result.stdout).trim();
    return out.length > 0 ? out : null;
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
/**
 * Delete entries for pids that are no longer running (SC4, mt#4378).
 *
 * ON WRITE rather than on a schedule: a SessionStart write is exactly when a
 * harness has just started or switched conversations, which is both infrequent
 * and already paying for filesystem work — there is no daemon here to hang a
 * timer on, and adding one would be a mechanism where a sweep suffices. The
 * store held 223 entries going back to 2026-08-11 when this was filed.
 *
 * ONLY `dead` is pruned. An `unknown` liveness must never delete a mapping: the
 * cost of wrongly keeping one is a stale entry the reader now rejects anyway,
 * while the cost of wrongly deleting one is the live session losing its own
 * identity and falling back to the spawn-time env value.
 *
 * Failure-isolated like the transition log below it — pruning is hygiene, and
 * the mapping write is what correctness depends on (mt#3900). A directory that
 * cannot be listed, or an entry that cannot be removed, must never cost the
 * caller its write.
 */
export function pruneDeadMappings(
  io: MappingIo = realMappingIo,
  liveness: (pid: number) => ProcessLiveness = processLiveness,
  keepPid?: number
): number {
  const list = io.list;
  const remove = io.remove;
  if (typeof list !== "function" || typeof remove !== "function") return 0;

  let pruned = 0;
  try {
    const dir = getConversationPidMapDir();
    for (const entry of list(dir)) {
      const match = entry.match(/^(\d+)\.json$/);
      const raw = match?.[1];
      if (raw === undefined) continue;
      const pid = Number.parseInt(raw, 10);
      if (!Number.isFinite(pid)) continue;
      // NEVER the entry the caller just wrote. A write comes from the harness
      // that owns the pid, so it is live by construction; deleting it because a
      // `ps` hiccup answered "dead" would destroy the mapping in the very call
      // that created it. Caught by a test whose synthetic pid really is dead.
      if (keepPid !== undefined && pid === keepPid) continue;
      if (liveness(pid) !== "dead") continue;
      try {
        remove(join(dir, entry));
        pruned++;
      } catch {
        // intentional-swallow: one unremovable entry must not abort the sweep
        // or the write it rides on. The reader rejects a dead pid regardless,
        // so a survivor is a disk-space cost, not a correctness one.
      }
    }
  } catch {
    // intentional-swallow: see the docblock — hygiene never fails a write.
  }
  return pruned;
}

export function writeConversationMapping(
  harnessPid: number,
  conversationId: string,
  source?: string,
  io: MappingIo = realMappingIo,
  startedAt: string | null = readProcessStartTime(harnessPid)
): boolean {
  if (!UUID_RE.test(conversationId)) return false;

  const successor = conversationId.toLowerCase();

  try {
    io.ensureDir(getConversationPidMapDir());
    const path = getConversationPidMapPath(harnessPid);

    // mt#3943: the entry about to be overwritten holds the PREDECESSOR, and this
    // is the only moment it is observable — a `/clear` does not announce itself
    // anywhere else, and once this write lands the edge is unrecoverable.
    // Capture before clobbering.
    const prior = readPriorMapping(io.read(path));

    const payload: ConversationPidMapping = {
      conversationId: successor,
      updatedAt: new Date().toISOString(),
      ...(source ? { source } : {}),
      ...(startedAt ? { harnessStartedAt: startedAt } : {}),
    };
    io.write(path, `${JSON.stringify(payload)}\n`);

    // AFTER the write, for the same reason the transition log is: the mapping
    // is what correctness depends on, and the sweep is hygiene (SC4). The pid
    // just written is held out — see `keepPid`.
    pruneDeadMappings(io, processLiveness, harnessPid);

    // AFTER the mapping write, and independently failure-isolated: the mapping
    // is what correctness depends on (mt#3900), the log is observability. A
    // broken log must never cost us a correct attribution.
    if (prior !== null && prior.conversationId !== successor) {
      appendConversationTransition(
        {
          predecessor: prior.conversationId,
          successor,
          ...(source ? { source } : {}),
          harnessPid,
          ...(startedAt ? { harnessStartedAt: startedAt } : {}),
          ...(prior.harnessStartedAt
            ? { predecessorHarnessStartedAt: prior.harnessStartedAt }
            : {}),
          at: new Date().toISOString(),
        },
        io
      );
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Extract just the conversation id from a raw mapping file body.
 *
 * Returns null for anything unreadable — absent file, malformed JSON, missing or
 * non-UUID id. Deliberately does NOT apply the recycled-pid start-time check
 * that {@link readConversationMapping} applies: this is used to identify the
 * predecessor at write time, and an entry from a recycled pid is still a real
 * observation of what was mapped, just one whose successor edge is meaningless.
 * Suppressing it here would silently drop transitions; recording it lets a
 * reader tell the two apart via `harnessStartedAt`.
 */
function readPriorMapping(
  contents: string | null
): { conversationId: string; harnessStartedAt?: string } | null {
  if (contents === null) return null;
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object") return null;
    const mapping = parsed as Partial<ConversationPidMapping>;
    const id = mapping.conversationId;
    if (typeof id !== "string" || !UUID_RE.test(id)) return null;
    return {
      conversationId: id.toLowerCase(),
      ...(typeof mapping.harnessStartedAt === "string"
        ? { harnessStartedAt: mapping.harnessStartedAt }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Append one transition to the log. Never throws.
 *
 * Isolated from the mapping write on purpose (SC2): this runs inside a
 * SessionStart hook, and a hook must not fail the event it observes. A lost
 * transition costs a gap in observability; a thrown error would cost the
 * attribution fix mt#3900 shipped.
 */
export function appendConversationTransition(
  transition: ConversationTransition,
  io: MappingIo = realMappingIo
): boolean {
  try {
    const logPath = getConversationTransitionLogPath();
    // Derived from the log path, not hard-coded to the state root (PR #2791 R1):
    // if the log ever moves into a subdirectory, a hard-coded parent silently
    // stops creating the directory that actually needs to exist.
    io.ensureDir(dirname(logPath));
    io.append(logPath, `${JSON.stringify(transition)}\n`);
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
  io: MappingIo = realMappingIo,
  readStartTime: (pid: number) => string | null = readProcessStartTime,
  liveness: (pid: number) => ProcessLiveness = processLiveness
): string | null {
  try {
    // LIVENESS FIRST (SC1, mt#4378). A dead pid's entry is not stale data to be
    // sanity-checked, it is data about a process that no longer exists — and
    // the recycling check below cannot catch it, because a dead pid makes `ps`
    // fail and that path is deliberately tolerant. The store never prunes, so
    // without this a two-day-old entry answers as confidently as a current one.
    //
    // Only `dead` rejects. `unknown` degrades to the previous behavior rather
    // than discarding a mapping we merely could not verify — the fallback is
    // the spawn-time env value, which is exactly what goes stale on `/clear`.
    if (liveness(harnessPid) === "dead") return null;

    const contents = io.read(getConversationPidMapPath(harnessPid));
    if (contents === null) return null;

    const parsed: unknown = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object") return null;

    const mapping = parsed as Partial<ConversationPidMapping>;
    const id = mapping.conversationId;
    if (typeof id !== "string" || !UUID_RE.test(id)) return null;

    // Staleness rule (SC5/AT4): a pid identifies a process only together with
    // its start time. If the entry names one and the live process reports a
    // different one, this pid has been recycled onto a DIFFERENT harness since
    // the entry was written — the conversation it names is not ours, so treat
    // the entry as absent and let the caller fall back.
    //
    // Either side missing is tolerated rather than rejected: `ps` can fail, and
    // an entry written before this field existed is not evidence of recycling.
    // Both are best-effort degradations toward the pre-mt#3900 behavior, never
    // toward asserting a wrong identity.
    const recordedStart = mapping.harnessStartedAt;
    if (typeof recordedStart === "string" && recordedStart.length > 0) {
      const liveStart = readStartTime(harnessPid);
      if (liveStart !== null && liveStart !== recordedStart) return null;
    }

    return id.toLowerCase();
  } catch {
    return null;
  }
}
