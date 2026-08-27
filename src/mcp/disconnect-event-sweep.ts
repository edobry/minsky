/**
 * mcp.disconnect system-event bridge (mt#2537).
 *
 * The MCP disconnect-tracker (`disconnect-tracker.ts`) persists disconnect
 * events as append-only JSONL to `<state-dir>/mcp-disconnect-log.json` — it
 * does NOT write to the `system_events` table directly. This module bridges
 * that JSONL log into `system_events` as `mcp.disconnect` rows so the
 * cockpit activity feed and the Phase 2 attention noticer see them.
 *
 * WHAT IT PROJECTS (mt#4617). Only `kind: "disconnect"` lines are bridged —
 * `parseNewDisconnectEvents` drops `reconnect`, `process_start` and
 * `transport_error`. Two consequences worth stating, because both have already
 * been got wrong:
 *
 * 1. The row population is single-kind BY CONSTRUCTION, so a `cause`
 *    distribution over these rows is already the disconnect-only distribution
 *    mt#4511 corrected. The payload's missing `kind` field is redundant here,
 *    not lossy.
 * 2. The file's TOTAL record count must never be compared against this table's
 *    row count — that compares a four-kind population against a one-kind
 *    subpopulation. A 2026-08-25 measurement did exactly that and concluded the
 *    bridge was a "48% partial projection"; on the same footing the numbers
 *    invert. Compare `kind = "disconnect"` on both sides or not at all.
 *
 * Per the accepted Event-log RFC, this table is a cross-cutting PROJECTION and
 * the producing subsystem stays the source of truth — the log file is the
 * complete record, and the pre-deployment history is deliberately not
 * backfilled ("the event log starts from the deployment date").
 *
 * Invocation path: fire-and-forget, triggered once at MCP-server boot from
 * `src/commands/mcp/start-command.ts`, mirroring the `startup-transcript-
 * ingest.ts` (mt#2051) and `startup-embedding-sweep.ts` boot-sweep pattern.
 * Never blocks server startup; failures are logged and swallowed.
 *
 * Dedup: HWM-gated by disconnect-event `timestamp`, persisted to
 * `<state-dir>/mcp-disconnect-sweep-hwm.json`. The MCP server restarts
 * frequently (see CLAUDE.md's disconnect-cadence rule — harness-driven
 * cycling is routine), so without a HWM every boot would re-emit the entire
 * log's history as duplicate `mcp.disconnect` rows.
 *
 * Filesystem access is injected via `DisconnectSweepFsDeps` (mirroring the
 * `readHostCap` injectable-`readFile` pattern in `.claude/hooks/types.ts`)
 * so tests exercise an in-memory fake instead of real `fs`/tmpdir, per the
 * repo's `custom/no-real-fs-in-tests` ESLint rule.
 */
import fs from "node:fs";
import path from "node:path";
import { log } from "@minsky/shared/logger";
import type { BasePersistenceProvider } from "@minsky/domain/persistence/types";
import { getDisconnectLogPath } from "./disconnect-tracker";
import { listCorpusPaths, monthOf } from "./disconnect-log-segments";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

interface HwmState {
  lastSweptTimestamp: string;
}

interface DisconnectLogLine {
  timestamp: string;
  serverName: string;
  kind: string;
  cause: string;
  uptimeMs?: number;
  processRole?: string;
}

/** Injectable filesystem surface — production default wraps real `node:fs`. */
export interface DisconnectSweepFsDeps {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => string;
  /**
   * Enumerate the state dir, so the sweep can see ROLLED segments (mt#4495).
   * Without this the sweep reads only the active file, and any event that was
   * rolled before it was swept is never bridged to `system_events` — a silent
   * data-loss path, since the HWM would then advance past it forever.
   */
  readdirSync: (p: string) => string[];
  writeFileSync: (p: string, content: string) => void;
  mkdirSync: (p: string, options?: { recursive?: boolean }) => void;
  /**
   * Sweep-lock primitives (mt#4617). `linkSync` is what PUBLISHES the lock: it
   * fails when the destination exists, giving the same exclusivity as the `wx`
   * (`O_CREAT|O_EXCL`) open `disconnect-log-segments.ts` uses to reserve a
   * segment name — but atomically WITH the payload, so a peer can never observe
   * the lock name without its contents (PR #3396 R1).
   */
  linkSync: (existing: string, target: string) => void;
  unlinkSync: (p: string) => void;
}

/**
 * Process-identity surface, injected so the stale-lock path is testable
 * without spawning processes (mt#4617).
 */
export interface DisconnectSweepProcDeps {
  pid: number;
  isAlive: (pid: number) => boolean;
  /** Injected so the pid-reuse backstop below is testable without waiting. */
  now: () => number;
}

/**
 * Age past which a lock is reclaimed even though its recorded pid looks alive
 * (PR #3396 R1). This is a BACKSTOP against pid reuse only — pid-liveness stays
 * the primary mechanism — so it is deliberately far above any legitimate hold
 * rather than tuned to one.
 *
 * Sizing, per `decision-defaults.mdc §Thresholds` (CEILING case: bound the
 * permitted extreme, not the typical). A lock is held only for the duration of
 * one sweep, and a sweep's work is bounded by its backlog: the largest ever
 * recorded was 865 events (mt#4131), which is seconds of inserts. Against that,
 * one hour is ~two orders of magnitude of headroom. It is also well inside
 * mt#4487's measured daemon lifetimes (4–8 minutes active, 10–44 hours quiet),
 * so in the active regime the holder is long gone before this ever fires — the
 * pid check will have reclaimed it first, which is the intent.
 *
 * Without this, one wedge is silent and permanent: a holder dies mid-sweep, its
 * pid is later reused by an unrelated live process, `isAlive` says true forever,
 * and the bridge stops with nothing reporting it.
 */
export const SWEEP_LOCK_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * `process.kill` is called as a METHOD via this cast, not destructured — the
 * same shape `src/mcp/stdio-proxy/cli.ts` uses, and for the same two reasons:
 * detaching it from `process` is not a contract Node/Bun guarantee, and this
 * repo's ambient `process` type does not declare `kill`.
 */
const proc = process as typeof process & { kill: (pid: number, signal: number) => void };

/**
 * Deliberately NOT imported from `src/cockpit/port-recovery.ts`, whose
 * `isProcessAlive` is this same function: that module pulls in
 * `child_process`, `./lifecycle` and the shared logger, and this one runs on
 * the MCP boot path next to two siblings (`disconnect-escalation.ts`,
 * `disconnect-log-segments.ts`) kept dependency-free on purpose. Extracting a
 * shared primitive is the right call if a third caller appears.
 */
export const defaultProcDeps: DisconnectSweepProcDeps = {
  pid: process.pid,
  now: () => Date.now(),
  isAlive: (pid: number) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      proc.kill(pid, 0);
      return true;
    } catch (err) {
      // ESRCH: no such process -> genuinely gone. EPERM: it exists but is
      // owned by another user -> alive, and must NOT be reclaimed. Treating
      // EPERM as dead is the classic way a liveness check invents a corpse.
      return (err as NodeJS.ErrnoException)?.code === "EPERM";
    }
  },
};

/** Injectable warn sink, mirroring `LogPostgresNoticeDeps` (mt#3628). */
export interface DisconnectSweepLogDeps {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

export const defaultLogDeps: DisconnectSweepLogDeps = { warn: log.warn };

export const defaultFsDeps: DisconnectSweepFsDeps = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p) => fs.readFileSync(p, { encoding: "utf-8" }) as string,
  readdirSync: (p) => fs.readdirSync(p),
  writeFileSync: (p, content) => fs.writeFileSync(p, content, { encoding: "utf-8" }),
  mkdirSync: (p, options) => {
    const recursive = options?.recursive ?? true;
    fs.mkdirSync(p, { ...options, recursive });
  },
  linkSync: (existing, target) => fs.linkSync(existing, target),
  unlinkSync: (p) => fs.unlinkSync(p),
};

function getHwmPath(): string {
  return path.join(path.dirname(getDisconnectLogPath()), "mcp-disconnect-sweep-hwm.json");
}

/**
 * Ensure `dir` exists, creating it (and any missing parent directories) if
 * necessary. `mkdirSync(dir, { recursive: true })` is idempotent — it does
 * not throw `EEXIST` if the directory already exists, including in the
 * TOCTOU (time-of-check-time-of-use) window where a concurrent process
 * creates the directory between an `existsSync` check and a subsequent
 * `mkdirSync` call. Callers must not precede this with an `existsSync`
 * check (mt#2633) — the recursive `mkdirSync` call already handles the
 * "already exists" case safely on its own.
 */
export function ensureDirSync(dir: string, deps: DisconnectSweepFsDeps): void {
  deps.mkdirSync(dir, { recursive: true });
}

function readHwm(deps: DisconnectSweepFsDeps): string | null {
  try {
    const raw = deps.readFileSync(getHwmPath());
    const parsed = JSON.parse(raw) as Partial<HwmState>;
    return typeof parsed.lastSweptTimestamp === "string" ? parsed.lastSweptTimestamp : null;
  } catch {
    return null; // absent/malformed HWM file — sweep from the beginning of the log
  }
}

function writeHwm(timestamp: string, deps: DisconnectSweepFsDeps): void {
  try {
    const dir = path.dirname(getHwmPath());
    ensureDirSync(dir, deps);
    deps.writeFileSync(getHwmPath(), JSON.stringify({ lastSweptTimestamp: timestamp } as HwmState));
  } catch (err) {
    log.warn("mcp-disconnect-sweep: failed to persist HWM (best-effort)", {
      error: getLoggableErrorSummary(err),
    });
  }
}

function getSweepLockPath(): string {
  return path.join(path.dirname(getDisconnectLogPath()), "mcp-disconnect-sweep.lock");
}

/**
 * Take the sweep lock, returning a release function — or `null` when another
 * LIVE sweep already holds it, in which case this boot must not sweep (mt#4617).
 *
 * Why a lock at all. `readHwm` -> emit-loop -> `writeHwm` is a read-modify-write
 * with nothing serializing it, and the sweep is dispatched fire-and-forget at
 * EVERY MCP boot on a host that records up to 326 process starts/day. Two boots
 * whose sweeps overlap both read the pre-sweep HWM and both emit the same
 * backlog. Measured on the live corpus before this fix: one
 * `helper|stdin_close|uptimeMs=41` tuple had 5 records in the file (all
 * 2026-07-08..07-16) against 287 rows in `system_events` spanning 07-21..08-26 —
 * the same five records re-bridged for six weeks after the events stopped
 * occurring.
 *
 * Why skip rather than wait. The sweep is best-effort and HWM-gated, so the
 * loser's backlog is not lost — the next boot picks it up, and on this host the
 * next boot is minutes away. Waiting would hold a fire-and-forget task open
 * across a shutdown for no gain.
 *
 * Reclaim is process-liveness, not a TTL. The holder writes its pid; a lock
 * whose holder is gone is reclaimed on the spot. That matters here more than
 * usual: this process dies constantly (`staleness_exit`, SIGTERM, stdin close),
 * so a holder dying mid-sweep is the common case, not the edge case. A TTL would
 * have to be longer than the slowest legitimate sweep and would therefore stall
 * every boot inside that window.
 */
export function acquireSweepLock(
  fsDeps: DisconnectSweepFsDeps,
  procDeps: DisconnectSweepProcDeps
): (() => void) | null {
  const lockPath = getSweepLockPath();
  ensureDirSync(path.dirname(lockPath), fsDeps);

  const release = (): void => {
    try {
      fsDeps.unlinkSync(lockPath);
    } catch (err) {
      // intentional-swallow: releasing a lock that is already gone (reclaimed
      // by a peer that judged us dead) is not an error worth failing a
      // best-effort boot sweep over.
      void err;
    }
  };

  // CONTENT FIRST, NAME SECOND (PR #3396 R1). The obvious shape — `openSync`
  // with `wx`, then `writeFileSync` the pid — publishes an EMPTY file and fills
  // it a moment later. In that window a peer sees a lock it cannot parse, reads
  // "names no holder", and reclaims a lock that is very much held. Writing the
  // payload to a private temp name and then `linkSync`-ing it into place closes
  // the window: `link` fails when the destination exists, so the lock name never
  // exists without its contents.
  const take = (): boolean => {
    const tmpPath = `${lockPath}.${procDeps.pid}.tmp`;
    try {
      fsDeps.writeFileSync(
        tmpPath,
        JSON.stringify({ pid: procDeps.pid, writtenAtMs: procDeps.now() })
      );
    } catch (err) {
      // intentional-swallow: cannot stage the lock payload -> do not sweep.
      void err;
      return false;
    }
    try {
      fsDeps.linkSync(tmpPath, lockPath);
      return true;
    } catch (err) {
      // intentional-swallow: EEXIST is the expected "someone else holds it"
      // answer, and any other link failure is handled the same way.
      void err;
      return false;
    } finally {
      try {
        fsDeps.unlinkSync(tmpPath);
      } catch (err) {
        // intentional-swallow: the temp name is ours alone; a failure to clean
        // it up must not fail a best-effort boot sweep.
        void err;
      }
    }
  };

  if (take()) return release;

  let holder: { pid?: number; writtenAtMs?: number } = {};
  try {
    holder = JSON.parse(fsDeps.readFileSync(lockPath)) as typeof holder;
  } catch (err) {
    // intentional-swallow: with the link idiom above, the lock name cannot
    // exist empty, so an unparseable body means genuine corruption rather than
    // a peer mid-publish. Reclaiming is then the right call — the alternative
    // wedges the bridge permanently on one corrupt byte.
    void err;
  }

  const holderPid = holder.pid;
  // A lock carrying no `writtenAtMs` is UNKNOWN-age, not infinitely old. Scoring
  // it as ancient would let the backstop overrule a live pid, inverting the
  // design — pid-liveness is the primary mechanism and the age check exists
  // only to catch pid REUSE. Unknown age therefore defers to the pid entirely,
  // and cannot wedge: every lock this code writes carries a timestamp, so the
  // unknown case does not survive a single reclaim cycle.
  const heldForMs =
    typeof holder.writtenAtMs === "number" ? procDeps.now() - holder.writtenAtMs : 0;

  if (
    typeof holderPid === "number" &&
    procDeps.isAlive(holderPid) &&
    heldForMs < SWEEP_LOCK_MAX_AGE_MS
  ) {
    return null;
  }

  try {
    fsDeps.unlinkSync(lockPath);
  } catch (err) {
    // intentional-swallow: a peer reclaimed it first; let them have it.
    void err;
    return null;
  }
  return take() ? release : null;
}

/**
 * Parse the disconnect-tracker's JSONL log and return `disconnect`-kind
 * lines strictly newer than `hwm` (or all `disconnect` lines when `hwm` is
 * null). Tolerates the legacy mt#1645 leading `[...]` array block the same
 * way `DisconnectTracker.loadFromDisk` does — malformed/bracket-residue
 * lines are skipped rather than failing the whole sweep. Pure function — no
 * filesystem access, so it needs no injected deps.
 *
 * HWM comparison (`candidate.timestamp <= hwm`) is a plain string comparison,
 * which is only chronologically correct because `disconnect-tracker.ts`
 * always writes `timestamp` via `new Date().toISOString()` — a fixed-width,
 * always-UTC, millisecond-precision ISO-8601 string. Lexicographic and
 * chronological ordering coincide for that exact format. If a producer ever
 * writes a differently-formatted timestamp (different precision, a numeric
 * offset instead of "Z", etc.) into this log, this comparison would silently
 * misorder — there is no format validation here beyond `typeof === "string"`.
 */
export function parseNewDisconnectEvents(raw: string, hwm: string | null): DisconnectLogLine[] {
  const events: DisconnectLogLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("]")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed line
    }
    if (!parsed || typeof parsed !== "object") continue;
    const candidate = parsed as Partial<DisconnectLogLine>;
    if (
      candidate.kind !== "disconnect" ||
      typeof candidate.timestamp !== "string" ||
      typeof candidate.serverName !== "string" ||
      typeof candidate.cause !== "string"
    ) {
      continue;
    }
    if (hwm && candidate.timestamp <= hwm) continue;
    events.push(candidate as DisconnectLogLine);
  }
  return events;
}

/**
 * Sweep the disconnect-tracker JSONL log and emit `mcp.disconnect` system
 * events (best-effort) for every disconnect recorded since the last
 * successful sweep.
 *
 * @param persistenceProvider - The persistence provider from the DI container.
 * @param fsDeps - Injectable filesystem surface; defaults to real `node:fs`.
 *   Tests pass an in-memory fake (per `custom/no-real-fs-in-tests`).
 * @param logDeps - Injectable warn sink; defaults to the shared logger. Exists
 *   so the "exactly one warning per halt" property is assertable by a test
 *   rather than inferred from the loop's shape (PR #3009 R1).
 */
export async function triggerMcpDisconnectEventSweep(
  persistenceProvider: BasePersistenceProvider,
  fsDeps: DisconnectSweepFsDeps = defaultFsDeps,
  logDeps: DisconnectSweepLogDeps = defaultLogDeps,
  procDeps: DisconnectSweepProcDeps = defaultProcDeps
): Promise<void> {
  try {
    if (!persistenceProvider.capabilities.sql) return;

    const getDb = (persistenceProvider as { getDatabaseConnection?: () => Promise<unknown> })
      .getDatabaseConnection;
    if (typeof getDb !== "function") return;

    const db = await getDb.call(persistenceProvider);
    if (!db) return;

    // mt#4617: serialize the read-modify-write below. Taken AFTER the cheap
    // early returns so a boot that was never going to sweep does not touch the
    // lock at all.
    const releaseLock = acquireSweepLock(fsDeps, procDeps);
    if (!releaseLock) {
      log.debug("mcp-disconnect-sweep: another sweep holds the lock; skipping this boot");
      return;
    }

    try {
      const logPath = getDisconnectLogPath();
      const hwm = readHwm(fsDeps);

      // Read the whole corpus, not just the active file (mt#4495). A roll renames
      // the active file to a monthly segment; anything in it that had not been
      // swept yet would otherwise be stranded, because the HWM advances past it
      // and never comes back. Bounding the scan by the HWM's own month keeps this
      // O(recent) rather than O(history) in steady state.
      const corpus = listCorpusPaths(logPath, fsDeps, hwm ? monthOf(hwm) : undefined);
      if (corpus.length === 0) return;

      const newEvents = corpus
        .flatMap((segment) => parseNewDisconnectEvents(fsDeps.readFileSync(segment), hwm))
        .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
      if (newEvents.length === 0) return;

      const { DrizzleEventEmitter } = await import("@minsky/domain/events/emitter");

      // Capture the emitter's failure detail instead of letting it log its own
      // line (PR #3009 R1). The emitter warns once per swallowed insert, and this
      // loop halts and warns too — two lines for one failure, against a criterion
      // that asks for exactly one. Taking its sink lets the sweep emit a SINGLE
      // warning carrying both halves: the driver cause (why) from the emitter,
      // and the unswept count (how much was left) from here.
      let failureDetail: Record<string, unknown> | undefined;
      const emitter = new DrizzleEventEmitter(
        db as import("drizzle-orm/postgres-js").PostgresJsDatabase,
        { warn: (_message, meta) => void (failureDetail = meta) }
      );

      let maxTimestamp = hwm ?? "";
      let persisted = 0;
      for (const [index, event] of newEvents.entries()) {
        // `tryEmit`, not `emit` (mt#4131): `emit` returns void, so advancing the
        // HWM after it marks an event swept whether or not the row landed. That
        // is how an 865-event backlog was dropped AND recorded as swept, leaving
        // it unrecoverable — the HWM must only ever pass events that persisted.
        const written = await emitter.tryEmit({
          eventType: "mcp.disconnect",
          payload: {
            cause: event.cause,
            serverName: event.serverName,
            uptimeMs: event.uptimeMs,
            processRole: event.processRole,
          },
        });

        if (!written) {
          // The usual cause is not a bad row but a dead pool: this sweep is
          // dispatched fire-and-forget at boot and is not awaited, so a SIGTERM
          // mid-backlog closes persistence out from under it. Every remaining
          // iteration then fails in ~1ms against the closed connection, each
          // emitting its own swallowed warning — 865 of them in the originating
          // incident. Stop at the first failure: one warning, and the unswept
          // remainder is picked up on the next boot.
          logDeps.warn("mcp-disconnect-sweep: emit failed, halting with events unswept", {
            ...failureDetail,
            persisted,
            unswept: newEvents.length - index,
          });
          break;
        }

        persisted++;
        if (event.timestamp > maxTimestamp) maxTimestamp = event.timestamp;
      }

      if (maxTimestamp) writeHwm(maxTimestamp, fsDeps);

      log.debug("mcp-disconnect-sweep: emitted mcp.disconnect events", {
        count: persisted,
        unswept: newEvents.length - persisted,
      });
    } finally {
      releaseLock();
    }
  } catch (err) {
    // Best-effort: a failed sweep must never affect MCP server boot.
    logDeps.warn("mcp-disconnect-sweep: sweep failed (best-effort, swallowed)", {
      error: getLoggableErrorSummary(err),
    });
  }
}
