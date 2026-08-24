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
import { JsonlTailer } from "@minsky/domain/transcripts/jsonl-tailer";

import { TranscriptWatcherTracker } from "./transcript-watcher-tracker";
import { createEpochKeyedCache } from "./shared-persistence";

const JSONL_EXT = ".jsonl";
const DEFAULT_DEBOUNCE_MS = 400;

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
    if (this.inFlight.has(jsonlPath)) return;
    this.inFlight.add(jsonlPath);
    try {
      const sessionId = sessionIdFromPath(jsonlPath);

      if (!(await fileExists(jsonlPath))) {
        this.tracker.removeSession(sessionId);
        this.tailer.forget(jsonlPath);
        this.tracker.setFilesWatched(this.tracker.trackedSessionCount);
        return;
      }

      this.tracker.recordSessionEvent(sessionId, isSubagentPath(jsonlPath));
      this.tracker.setFilesWatched(this.tracker.trackedSessionCount);

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

      const ingested = await this.ingestFileImpl(jsonlPath);
      if (ingested > 0) this.tracker.recordSessionIngest(sessionId, ingested);
    } finally {
      this.inFlight.delete(jsonlPath);
    }
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
