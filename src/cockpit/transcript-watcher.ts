/**
 * Cockpit-daemon transcript watcher (mt#2320) — the PRIMARY transcript-capture
 * mechanism from ADR-017.
 *
 * Watches `~/.claude/projects/**\/*.jsonl` and, on append, ingests the new turns
 * of the changed session via the existing idempotent
 * `AgentTranscriptIngestService` — so an in-flight session becomes
 * FTS-searchable shortly after its turns hit disk, with no session exit, no
 * manual `transcripts ingest`, and no MCP reboot (SC1, SC3). Capture is
 * independent of how (or whether) a session exits.
 *
 * Design notes:
 * - **Native `fs.watch` (recursive), not chokidar.** Zero new dependency and
 *   zero native-module bundling risk (chokidar pulls optional `fsevents`, which
 *   cannot bundle into `dist/minsky.js`). Bun's recursive `fs.watch` uses
 *   FSEvents on macOS — the operator target ADR-017 names. On platforms where
 *   recursive watch is unsupported (older Linux), `fs.watch` throws at start;
 *   we log and no-op, and the periodic sweep (mt#2321) is the backstop.
 * - **Tailer as a change-gate.** {@link JsonlTailer} cheaply reads only the new
 *   bytes to decide whether there is genuinely new complete content before
 *   paying for an ingest, and is the shared incremental-read primitive mt#2232
 *   reuses for live render. It is NOT the correctness mechanism: ingest dedup
 *   is owned by the service's timestamp high-water-mark, so a tailer/HWM drift
 *   only affects this gate, never what lands in the DB.
 * - **Backstop boundary.** If an ingest fails after the tailer advanced its
 *   offset, those turns will not re-trigger via the watcher until the next
 *   append; the periodic sweep (mt#2321) is the recovery layer for that window,
 *   and the failure is recorded in {@link TranscriptWatcherTracker} (SC5).
 * - **Single-writer.** mt#1418 (advisory-lock single-writer guard) is a soft
 *   prerequisite once watcher + sweep + boot-sweep overlap; until then the
 *   per-`turn_index` upsert + HWM keep concurrent ingests benign, and a per-path
 *   in-flight guard serializes this watcher's own ingests.
 *
 * @see mt#2320 — this task
 * @see docs/architecture/adr-017-transcript-capture-continuous-watch.md
 * @see src/cockpit/sweepers.ts startAskAdvancementSweeper — daemon lifecycle convention
 * @see scripts/smoke-transcript-watcher.ts — §7a end-to-end verification artifact
 */

import { watch as fsWatch, type Dirent, type FSWatcher } from "node:fs";
import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { log } from "@minsky/shared/logger";
import { raceAgainstTimeout } from "@minsky/shared/timeout";
import { JsonlTailer } from "@minsky/domain/transcripts/jsonl-tailer";

import { TranscriptWatcherTracker } from "./transcript-watcher-tracker";
import { createEpochKeyedCache } from "./shared-persistence";

const JSONL_EXT = ".jsonl";
const DEFAULT_DEBOUNCE_MS = 400;

/**
 * Wall-clock bound on one ingest (mt#4492).
 *
 * WHY A CALLER-SIDE BOUND AT ALL. postgres-js documents `connect_timeout`,
 * `idle_timeout` and `max_lifetime`, and NO statement-level timeout or
 * `AbortSignal`. Its one documented cancellation path — `.cancel()` on a query
 * — works by opening a NEW connection to send a protocol-level cancel, which is
 * precisely what a wedged pooler cannot supply. So for an in-flight query the
 * vendor leaves the caller as the only layer that can bound anything; this is
 * the documented-pattern default, not a deviation from it.
 *
 * WHY 300s, AND WHY THE FIRST ANSWER (90s) WAS WRONG (mt#4502).
 *
 * The original derivation read this as a CEILING over `createBoundedSocket`'s
 * inactivity bound (60s, from `idle_timeout`) and set 90s to clear it. **Wrong
 * anchor.** That bound governs inactivity within ONE SOCKET; an ingest is a pool
 * acquire plus several queries, so its total duration has no reason to sit under
 * a per-socket inactivity window. `decision-defaults.mdc §Thresholds`'s CEILING
 * case says to read the inner layer's declared maximum — right when the wrapper
 * bounds THAT layer's work, misleading when it bounds a COMPOSITE operation the
 * inner constant says nothing about.
 *
 * Measured four minutes after 90s shipped: a boot storm (~1,500 files seeded at
 * once, contending for the pool) drove `oldestIngestInFlightAgeMs` to 86,208 ms
 * with `ingestErrors 0` and `dbRecycle.recycleCount 0` — no wedge, just normal
 * work. Nine ingests were abandoned and the backoff latched. 300s is ~3.5x that
 * observed tail and still far under the 30-minute sweep interval, so the watcher
 * path recovers faster than its own backstop.
 *
 * WHY LONGER IS THE SAFE DIRECTION. The bound's job is converting "never settles"
 * into "settles eventually" — any finite value does that. Firing on the normal
 * population is pure cost: the abandoned promise keeps running, the retry redoes
 * the work, and freshness is delayed rather than improved. A wedge is already
 * visible IMMEDIATELY via `oldestIngestInFlightAgeMs` climbing, which does not
 * depend on this constant at all. So the tie-break is "never fire on healthy
 * work", not "catch a wedge soonest".
 *
 * WHAT IT ACTUALLY CATCHES. The class the socket bound structurally cannot reach:
 * the wait for a pool slot, where no socket is assigned yet. postgres-js has no
 * checkout timeout at all — when `max` connections are busy, queries queue with
 * no bound (mt#4473), which is also why a boot storm reaches tens of seconds.
 *
 * COST OF FIRING. One abandoned ingest for one path, retried on the next event.
 * Freshness only — completeness is the sweep's guarantee, per ADR-017.
 */
const DEFAULT_INGEST_TIMEOUT_MS = 300_000;

/**
 * Consecutive abandons before the ingest path backs off (mt#4492).
 *
 * `raceAgainstTimeout` bounds the CALLER's wait and does not cancel the
 * operation — its own docblock is explicit — so every abandoned ingest leaves a
 * promise pending against the wedged pool. Without a backoff, a long wedge with
 * N active conversations accrues a fresh one per path per bound, forever.
 * Three is the smallest count that cannot be reached by a single slow ingest
 * plus its retry.
 */
const ABANDON_BACKOFF_THRESHOLD = 3;

/**
 * How long the ingest path stays paused once the threshold trips.
 *
 * Grounded in the observed recovery cadence of the thing being waited on: the
 * shared-persistence recycle backoff escalates 60s → 120s → 240s → 480s → 900s
 * (mem#1227), so a pause materially shorter than its second step just retries
 * into the same wedge. Five minutes sits inside that escalation without
 * outliving the 30-minute sweep interval that backstops completeness meanwhile.
 */
const ABANDON_BACKOFF_MS = 5 * 60_000;

/*
 * WHY THESE THREE ARE MODULE CONSTANTS AND NOT CONFIG (PR #3282 R1, non-blocking).
 *
 * Deliberate, and recorded here because the reviewer asked for the decision
 * rather than the outcome. The in-repo precedent for a bound of exactly this
 * shape is mt#4103's `RECONCILE_STAGE_TIMEOUT_MS` / `RECONCILE_ROW_TIMEOUT_MS`,
 * which are plain constants in `driven-session-launch.ts` with no config or env
 * surface — and which are observably firing on the live daemon, so the pattern
 * has been exercised rather than merely chosen.
 *
 * Two reasons not to surface them yet. Every value above is DERIVED from
 * another layer's declared budget (`idle_timeout`, the recycle backoff ladder),
 * so an operator tuning one in isolation would decouple it from the thing it is
 * a ceiling over — the failure mode the derivation exists to prevent. And there
 * is no evidence anyone has needed to: nothing has been tuned, because this is
 * the first time the path has been bounded at all.
 *
 * The tell that would change this: an incident where the right move is to move
 * one of these values, and it requires a deploy. Add config THEN, with the
 * incident as the calibration input, rather than guessing a range now.
 */

export type DbGetter = () => Promise<PostgresJsDatabase | null>;

export interface TranscriptWatcherDeps {
  /** Root projects dir to watch. Defaults to `~/.claude/projects`. */
  claudeProjectsDir?: string;
  /** Per-file debounce window (ms) coalescing rapid appends. */
  debounceMs?: number;
  /** DB getter for ingest. Defaults to the cockpit shared persistence provider. */
  getDb?: DbGetter;
  /**
   * Test seam: override the persistence-epoch read (mt#4480). Mirrors
   * `createEpochKeyedCache`'s own `options.getEpoch`. Production never sets it —
   * bumping the real epoch means recycling the real pool.
   */
  getEpoch?: () => number;
  /** Tracker singleton. Defaults to the process-lifetime singleton. */
  tracker?: TranscriptWatcherTracker;
  /**
   * Override the per-file ingest (tests). Default ingests via
   * SingleFileTranscriptSource + AgentTranscriptIngestService and records
   * tracker counters. Returns the number of new turn lines ingested.
   */
  ingestFile?: (jsonlPath: string) => Promise<number>;
  /** Wall-clock bound on one ingest. Defaults to {@link DEFAULT_INGEST_TIMEOUT_MS}. */
  ingestTimeoutMs?: number;
  /**
   * Test seam: the timeout arm of the ingest bound (mt#4492).
   *
   * `raceAgainstTimeout`'s own docblock prescribes this pairing — an injected
   * signal that resolves immediately, against an operation that never resolves
   * on its own — so the abandon branch is exercised in well under a
   * millisecond instead of waiting out a real 90 seconds.
   */
  timeoutSignal?: (ms: number) => Promise<{ timedOut: true }>;
  /** Test seam: clock read for in-flight ages and backoff. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Testable core of the transcript watcher: seeding + per-file processing,
 * independent of the `fs.watch` event source. {@link startTranscriptWatcher}
 * wires `fs.watch` + debounce to {@link TranscriptWatcher.processFile}.
 */
export class TranscriptWatcher {
  private readonly projectsDir: string;
  private readonly tracker: TranscriptWatcherTracker;
  private readonly tailer = new JsonlTailer();
  private readonly getDb: DbGetter;
  private readonly ingestFileImpl: (jsonlPath: string) => Promise<number>;
  private readonly inFlight = new Set<string>();
  private readonly ingestTimeoutMs: number;
  private readonly timeoutSignal: ((ms: number) => Promise<{ timedOut: true }>) | undefined;
  private readonly now: () => number;
  /** Abandons since the last ingest that actually settled (mt#4492). */
  private consecutiveAbandons = 0;
  /** While set and in the future, ingests are skipped — events still stamp liveness. */
  private ingestPausedUntilMs: number | null = null;
  /**
   * Epoch-keyed DB handle (mt#4480).
   *
   * This was a plain `private cachedDb` that, once set, was never invalidated.
   * A pool recycle (mt#3638) ENDS the old `Sql` instance, and postgres-js then
   * rejects every query on a handle derived from it with `CONNECTION_ENDED`
   * forever — nothing clears the `ending` flag. So one recycle killed the
   * PRIMARY transcript-capture path for the rest of the daemon's life, leaving
   * freshness to the 30-minute sweep backstop. Measured on a live daemon before
   * the fix: `ingestsTriggered: 47, ingestsSucceeded: 16, ingestErrors: 31`,
   * with `lastIngestAt` 75 minutes stale while `lastErrorAt` was current, and
   * actively-writing conversations 1.4h to 45h behind their on-disk head.
   *
   * `createEpochKeyedCache` is the mt#3721 primitive for exactly this and
   * carries subtleties worth not re-deriving: it single-flights concurrent
   * callers, requires the epoch to be STABLE ACROSS construction (a recycle
   * landing mid-resolve would otherwise cache a handle onto the torn-down
   * pool), and never caches a null so a not-yet-ready DI container is retried.
   *
   * Why mt#3721's structural guard did not catch this: `epoch-cache-coverage.test.ts`
   * matches module-level `let` declarations, and this cache was an INSTANCE
   * FIELD. The guard has been widened in the same change.
   */
  private readonly resolveDbCached: () => Promise<PostgresJsDatabase | null>;

  constructor(deps: TranscriptWatcherDeps = {}) {
    this.projectsDir = deps.claudeProjectsDir ?? join(homedir(), ".claude", "projects");
    this.tracker = deps.tracker ?? TranscriptWatcherTracker.getInstance();
    this.getDb = deps.getDb ?? (() => this.defaultGetDb());
    this.ingestFileImpl = deps.ingestFile ?? ((p) => this.defaultIngestFile(p));
    this.ingestTimeoutMs = deps.ingestTimeoutMs ?? DEFAULT_INGEST_TIMEOUT_MS;
    this.timeoutSignal = deps.timeoutSignal;
    this.now = deps.now ?? (() => Date.now());
    this.resolveDbCached = createEpochKeyedCache(
      () => this.getDb(),
      deps.getEpoch ? { getEpoch: deps.getEpoch } : undefined
    );
  }

  /** Absolute root being watched. */
  get rootDir(): string {
    return this.projectsDir;
  }

  /**
   * Seed the registry + tailer offsets from existing transcripts so the watcher
   * surfaces only NEW appends (pre-existing history is owned by the boot sweep,
   * mt#2051). Returns the number of files seeded.
   */
  async seedExisting(): Promise<number> {
    // Portable recursive walk (readdir withFileTypes) rather than
    // `readdir({ recursive: true })` — the latter is newer/less portable
    // (reviewer R1). Fail-open: an absent/unreadable dir yields no files.
    let count = 0;
    for (const abs of await walkJsonlFiles(this.projectsDir)) {
      try {
        const stat = await fsp.stat(abs);
        if (!stat.isFile()) continue;
        // Skip history: tail only appends that land after the watcher attaches.
        this.tailer.setOffset(abs, stat.size);
      } catch {
        continue;
      }
      // Seed WITHOUT stamping liveness (mt#3857): discovering a file is not
      // observing activity in it. `recordSessionEvent` would stamp Date.now() on
      // every historical conversation, which is what made /api/health's live-session
      // list 1,380 entries wide. The byte-offset seed above is the part that must
      // happen here, and it is untouched.
      this.tracker.recordSessionSeeded(sessionIdFromPath(abs), isSubagentPath(abs));
      count++;
    }
    this.tracker.setFilesWatched(this.tracker.trackedSessionCount);
    return count;
  }

  /**
   * Process one changed JSONL path: drop vanished files, gate on the tailer
   * (skip when there is no new complete content), then ingest. Per-path
   * in-flight guard serializes overlapping runs.
   */
  async processFile(jsonlPath: string): Promise<void> {
    const sessionId = sessionIdFromPath(jsonlPath);

    if (this.inFlight.has(jsonlPath)) {
      // Skipping the INGEST is correct — one is already running for this path.
      // Skipping the liveness STAMP is not, and this return used to precede it
      // (mt#4492). The event genuinely arrived; dropping its stamp meant a path
      // whose ingest never settled stopped refreshing `lastEventAt` and fell
      // out of the live-session list entirely. So a wedged ingest did not
      // merely stall the path — it erased the conversation from the watcher's
      // own liveness view, which is why four hours of a stuck ingest read
      // exactly like an idle watcher on /api/health.
      this.tracker.recordSessionEvent(sessionId, isSubagentPath(jsonlPath));
      return;
    }
    this.inFlight.add(jsonlPath);
    try {
      if (!(await fileExists(jsonlPath))) {
        this.tracker.removeSession(sessionId);
        this.tailer.forget(jsonlPath);
        this.tracker.setFilesWatched(this.tracker.trackedSessionCount);
        return;
      }

      this.tracker.recordSessionEvent(sessionId, isSubagentPath(jsonlPath));
      this.tracker.setFilesWatched(this.tracker.trackedSessionCount);

      // Backoff (mt#4492). The stamp above has already landed, so a paused
      // watcher still reports the conversation as active — it is the INGEST
      // that is deferred, and `ingestPausedUntil` on /api/health says so out
      // loud rather than leaving a silently inert path.
      //
      // Returning BEFORE the change-gate is deliberate: `readNew` ADVANCES the
      // tailer offset, so gating first would burn offsets for content we have
      // no intention of ingesting, handing the sweep work the watcher could
      // still have done itself once the pause lifts.
      if (this.isIngestPaused()) return;

      // Change-gate: only ingest when there is genuinely new complete content.
      let hasNew = false;
      try {
        const res = await this.tailer.readNew(jsonlPath);
        hasNew = res.lines.length > 0 || res.reset;
      } catch (err) {
        this.tracker.recordIngestError();
        log.warn("cockpit transcript-watcher: tail read failed", {
          jsonlPath,
          message: messageOf(err),
        });
        return;
      }
      if (!hasNew) return;

      // Keyed by PATH, matching `inFlight` above — not by session id (PR #3282
      // R1). `sessionIdFromPath` is the jsonl BASENAME, so two files under
      // different project directories share a session id while ingesting
      // independently; keying the tracker by it collapsed them and under-
      // reported both the count and the oldest age.
      this.tracker.recordIngestStarted(jsonlPath, this.now());
      try {
        const outcome = await raceAgainstTimeout(
          this.ingestFileImpl(jsonlPath),
          this.ingestTimeoutMs,
          this.timeoutSignal
        );
        if (outcome.timedOut) {
          this.noteAbandonedIngest(jsonlPath);
          return;
        }
        this.consecutiveAbandons = 0;
        if (outcome.value > 0) this.tracker.recordSessionIngest(sessionId, outcome.value);
      } catch (err) {
        // The ingest REJECTED rather than hanging, which is a SETTLED outcome —
        // `defaultIngestFile` has already counted it. That clears the streak:
        // the backoff exists for a path that never answers, not for one that
        // answers with an error, and conflating the two would pause a watcher
        // whose only problem is a run of bad files.
        this.consecutiveAbandons = 0;
        throw err;
      } finally {
        this.tracker.recordIngestSettled(jsonlPath);
      }
    } finally {
      this.inFlight.delete(jsonlPath);
    }
  }

  /**
   * Whether the ingest path is currently backing off, clearing an elapsed pause
   * as a side effect (mt#4492).
   *
   * Lazily cleared on read rather than by a timer: the watcher is event-driven,
   * so there is no tick to hang the expiry off, and a pause that outlives its
   * window by however long the next event takes costs nothing.
   */
  private isIngestPaused(): boolean {
    if (this.ingestPausedUntilMs === null) return false;
    if (this.now() < this.ingestPausedUntilMs) return true;
    this.ingestPausedUntilMs = null;
    this.consecutiveAbandons = 0;
    this.tracker.setIngestPausedUntil(null);
    return false;
  }

  /**
   * Count an ingest abandoned at the bound, and trip the backoff on a streak.
   *
   * Deliberately NOT `recordIngestError`: the abandoned operation is still
   * running against the pool and may yet succeed — in which case it records its
   * own success from inside `defaultIngestFile`, late but honestly. Counting it
   * as an error here would book a failure that did not happen.
   */
  private noteAbandonedIngest(jsonlPath: string): void {
    this.tracker.recordIngestAbandoned();

    // Read the pause BEFORE counting (PR #3284 R1). `isIngestPaused` lazily
    // CLEARS an expired pause and resets the streak as a side effect, so doing
    // it after the threshold test let an abandon arriving just past expiry be
    // judged against the streak that expiry had just cleared — and re-arm the
    // pause on the spot. Reading first means such an abandon starts a fresh
    // streak, which is what the expiry meant.
    const alreadyPaused = this.isIngestPaused();

    this.consecutiveAbandons++;
    log.warn("cockpit transcript-watcher: ingest abandoned at bound", {
      jsonlPath,
      timeoutMs: this.ingestTimeoutMs,
      consecutiveAbandons: this.consecutiveAbandons,
    });
    // Already paused: count it, never extend the window (the mt#4502 latch).
    if (alreadyPaused) return;
    if (this.consecutiveAbandons < ABANDON_BACKOFF_THRESHOLD) return;
    // Arm on the TRANSITION only — never re-arm while already paused (mt#4502).
    //
    // This re-armed unconditionally, and that latched the watcher. During a
    // pause `processFile` returns before starting any ingest, so no success can
    // occur to reset the streak — while ingests that started BEFORE the pause
    // keep timing out, and each one pushed the horizon a further 5 minutes out.
    // Measured on the live daemon: 15:13:44Z → 15:14:19Z → 15:14:24Z → 15:14:48Z,
    // with `ingestsTriggered` and `ingestsSucceeded` frozen throughout. It ended
    // only when the last pre-pause straggler drained, which is not a bound.
    this.ingestPausedUntilMs = this.now() + ABANDON_BACKOFF_MS;
    this.tracker.setIngestPausedUntil(this.ingestPausedUntilMs);
    log.warn("cockpit transcript-watcher: pausing ingest after consecutive abandons", {
      consecutiveAbandons: this.consecutiveAbandons,
      resumesAt: new Date(this.ingestPausedUntilMs).toISOString(),
    });
  }

  private async resolveDb(): Promise<PostgresJsDatabase | null> {
    // Caches only a live connection, and only for the persistence generation it
    // was resolved under — both properties belong to the helper now. See
    // `resolveDbCached`'s doc comment for what the un-keyed version cost.
    return this.resolveDbCached();
  }

  private async defaultGetDb(): Promise<PostgresJsDatabase | null> {
    try {
      const { getSharedPersistenceService } = await import("./shared-persistence");
      const svc = await getSharedPersistenceService();
      const provider = svc.getProvider();
      if (
        !("getDatabaseConnection" in provider) ||
        typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !==
          "function"
      ) {
        return null;
      }
      const db = await (
        provider as { getDatabaseConnection: () => Promise<PostgresJsDatabase> }
      ).getDatabaseConnection();
      return db ?? null;
    } catch (err) {
      log.warn("cockpit transcript-watcher: DB acquisition failed", { message: messageOf(err) });
      return null;
    }
  }

  private async defaultIngestFile(jsonlPath: string): Promise<number> {
    this.tracker.recordIngestTriggered();

    const db = await this.resolveDb();
    if (!db) {
      this.tracker.recordIngestError();
      log.warn("cockpit transcript-watcher: ingest skipped, DB unavailable", { jsonlPath });
      return 0;
    }

    const { SingleFileTranscriptSource } = await import(
      "@minsky/domain/transcripts/single-file-transcript-source"
    );
    const { AgentTranscriptIngestService } = await import(
      "@minsky/domain/transcripts/agent-transcript-ingest-service"
    );

    const source = new SingleFileTranscriptSource(jsonlPath);
    let discovered;
    try {
      discovered = await source.discovered();
    } catch {
      // File vanished between the gate and the ingest — benign, the next event
      // (or the sweep) handles it.
      return 0;
    }

    const svc = new AgentTranscriptIngestService(db, source);
    const result = await svc.ingestSession(discovered);

    if (result.error) {
      this.tracker.recordIngestError();
      log.warn("cockpit transcript-watcher: degraded ingest", {
        jsonlPath,
        message: messageOf(result.error),
      });
    } else {
      this.tracker.recordIngestSuccess(result.ingested);
      if (result.ingested > 0) {
        log.debug("cockpit transcript-watcher: ingested turns", {
          jsonlPath,
          ingested: result.ingested,
        });
      }
    }
    return result.ingested;
  }
}

/**
 * Start the transcript watcher in this cockpit process.
 *
 * Seeds existing transcripts (history skipped), attaches a recursive
 * `fs.watch`, and routes debounced per-file change events to
 * {@link TranscriptWatcher.processFile}. Fail-open: a watch that cannot start
 * (unsupported recursive watch, absent dir) logs and returns a no-op stop fn —
 * the cockpit never crashes on the watcher's account, and the sweep backstops.
 *
 * @returns stop function (clears timers, closes the watcher).
 */
export function startTranscriptWatcher(deps: TranscriptWatcherDeps = {}): () => void {
  const core = new TranscriptWatcher(deps);
  const tracker = deps.tracker ?? TranscriptWatcherTracker.getInstance();
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  // Seed existing files in the background; the watch attaches regardless.
  void core
    .seedExisting()
    .catch((err) =>
      log.warn("cockpit transcript-watcher: seed failed", { message: messageOf(err) })
    );

  let watcher: FSWatcher | null = null;
  try {
    watcher = fsWatch(core.rootDir, { recursive: true }, (_eventType, filename) => {
      // Default fs.watch encoding yields string filenames (relative to rootDir).
      if (!filename || !filename.endsWith(JSONL_EXT)) return;
      const abs = join(core.rootDir, filename);

      const existing = timers.get(abs);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        timers.delete(abs);
        void core.processFile(abs).catch((err) =>
          log.warn("cockpit transcript-watcher: processFile failed", {
            jsonlPath: abs,
            message: messageOf(err),
          })
        );
      }, debounceMs);
      // Never hold the process open on account of the watcher's debounce timers.
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      timers.set(abs, timer);
    });
    watcher.on("error", (err) =>
      log.warn("cockpit transcript-watcher: watch error", { message: messageOf(err) })
    );
    tracker.setRunning(true);
    log.debug("cockpit transcript-watcher: watching", { dir: core.rootDir });
  } catch (err) {
    log.warn("cockpit transcript-watcher: failed to start watch (sweep backstops)", {
      dir: core.rootDir,
      message: messageOf(err),
    });
  }

  return () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    if (watcher) watcher.close();
    tracker.setRunning(false);
  };
}

function sessionIdFromPath(jsonlPath: string): string {
  return basename(jsonlPath, JSONL_EXT);
}

// Path-separator-agnostic so it classifies correctly on Windows too (reviewer R1).
const SUBAGENTS_SEGMENT_RE = /[\\/]subagents[\\/]/;

function isSubagentPath(jsonlPath: string): boolean {
  return SUBAGENTS_SEGMENT_RE.test(jsonlPath);
}

/** Portable recursive walk yielding every `.jsonl` file under `dir`. Fail-open. */
async function walkJsonlFiles(dir: string): Promise<string[]> {
  let dirents: Dirent[];
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // absent/unreadable directory
  }
  const out: string[] = [];
  for (const ent of dirents) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await walkJsonlFiles(full)));
    } else if (ent.isFile() && ent.name.endsWith(JSONL_EXT)) {
      out.push(full);
    }
  }
  return out;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(path);
    return stat.isFile();
  } catch {
    return false;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
