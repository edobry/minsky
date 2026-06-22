/**
 * Cockpit Express server factory (mt#1144)
 *
 * Creates an Express app serving:
 *   GET /api/health           — health + version + uptime
 *   GET /api/widgets          — metadata for every registered widget
 *   GET /api/widget/:id/data  — fetch a single widget's data (registry-gated;
 *                               404 only for ids absent from WIDGET_REGISTRY)
 *   GET /api/events           — SSE stream of Postgres NOTIFY events (mt#1853)
 *   GET /api/agents/:id       — workspace-session detail: meta, commits, PR
 *                               state, transcript bridge (mt#1919)
 *   GET /api/asks             — list pending operator-routed asks (mt#1916)
 *   POST /api/asks/:id/resolve — mark an Ask as resolved (mt#1147)
 *   GET /assets/*             — static files from web/dist/assets
 *   GET /                     — serves web/dist/index.html
 */
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { cockpitWebDistDir, cockpitIndexHtml } from "./web-dist";
import { randomUUID } from "crypto";
import { WIDGET_REGISTRY } from "./widget-registry";
import type { WidgetRegistry } from "./widget-registry";
import { TranscriptWatcherTracker } from "./transcript-watcher-tracker";
import { TranscriptSweepTracker } from "./transcript-sweep-tracker";
import { setLoadedWidgetCount } from "./widgets/basic-health";
import type { WidgetModule } from "./types";
import { SseBroker } from "./sse-broker";
import type { SseClient, SseEvent } from "./sse-broker";
import {
  PostgresChannelListener,
  createNoopChannelListener,
} from "@minsky/domain/mesh/postgres-channel-listener";
import { log } from "@minsky/shared/logger";
import { DEFAULT_SWEEP_INTERVAL_MS } from "@minsky/domain/ask/advancement";
import type { AgentSessionId } from "@minsky/domain/transcripts/transcript-source";
import { execSync } from "child_process";

// Lazy + memoized: this module loads during CLI command registration (e.g. on
// `--help`), so a module-level spawn would run `git rev-parse` — and leak
// `fatal: not a git repository` from non-repo cwds — on commands that never
// touch the cockpit (mt#1428). `stdio: "pipe"` keeps the child's stderr out of
// the parent's output either way.
let gitCommit: string | undefined;
function getGitCommit(): string {
  if (gitCommit === undefined) {
    try {
      gitCommit = String(
        execSync("git rev-parse --short HEAD", { encoding: "utf-8", stdio: "pipe" })
      ).trim();
    } catch {
      gitCommit = "unknown";
    }
  }
  return gitCommit;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the built SPA assets — bundle-aware (cwd + module-dir walk, mt#2283). */
const WEB_DIST_DIR = cockpitWebDistDir(__dirname);
const INDEX_HTML = cockpitIndexHtml(__dirname);

/** Options accepted by createCockpitServer */
/**
 * Minimal interface for the credential module surface used by the server's
 * credential endpoints. Defined here so tests can inject doubles without
 * needing to import the real domain module (which writes to the filesystem).
 */
export interface CredentialModuleOverride {
  getCredentialProvider: (id: string) =>
    | {
        validate: (
          token: string
        ) => Promise<import("@minsky/domain/credentials").CredentialCheckResult>;
      }
    | undefined;
  addCredential: (
    provider: string,
    token: string
  ) => Promise<import("@minsky/domain/credentials").AddCredentialResult>;
  listCredentials: () => Promise<import("@minsky/domain/credentials").CredentialListing[]>;
  removeCredential: (provider: string) => Promise<{ removed: boolean }>;
  listCredentialProviders: () => readonly {
    id: string;
    displayName: string;
    acquireUrl: string;
    scopeGuidance: string;
  }[];
}

export interface CockpitServerOptions {
  /** Additional widgets to register alongside builtins (used in tests) */
  overrideRegistry?: WidgetRegistry;
  /**
   * Override the AskRepository used by the resolve endpoint (used in tests).
   * When absent, the server lazily initialises a DrizzleAskRepository from
   * the default PersistenceService (same pattern as attention.ts).
   */
  overrideAskRepository?: import("@minsky/domain/ask/repository").AskRepository;
  /**
   * Override the SseBroker used by the /api/events endpoint (used in tests).
   * When absent, the server lazily initialises a real broker backed by a
   * PostgresChannelListener from the default PersistenceService.
   */
  overrideSseBroker?: SseBroker;
  /**
   * Override the credential module used by the /api/credentials/* endpoints
   * (used in tests). When absent, the server dynamically imports the real
   * domain credentials module which writes to ~/.config/minsky/.
   */
  overrideCredentialModule?: CredentialModuleOverride;
  /** When true, skip static/SPA asset serving — Vite middleware handles it. */
  dev?: boolean;
}

const serverStartTime = Date.now();

/**
 * Build and return an Express app serving the cockpit shell.
 *
 * Call `app.listen(port)` on the returned app to start the server.
 */
// ---------------------------------------------------------------------------
// Context-inspector SQL connection — lazy-cached singleton (mt#2023).
// Uses the cockpit-wide PersistenceService singleton (shared-persistence.ts).
// Returns null when the provider is non-SQL (the endpoint returns 503).
// ---------------------------------------------------------------------------

let _cachedContextInspectorDb: import("drizzle-orm/postgres-js").PostgresJsDatabase | null = null;
let _cachedContextInspectorDbProbed = false;

async function getContextInspectorDb(): Promise<
  import("drizzle-orm/postgres-js").PostgresJsDatabase | null
> {
  if (_cachedContextInspectorDb) return _cachedContextInspectorDb;
  if (_cachedContextInspectorDbProbed) return null;
  try {
    const { getSharedPersistenceService } = await import("./shared-persistence");
    const svc = await getSharedPersistenceService();
    const provider = svc.getProvider();
    if (
      !("getDatabaseConnection" in provider) ||
      typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !== "function"
    ) {
      _cachedContextInspectorDbProbed = true;
      return null;
    }
    const sqlProvider = provider as {
      getDatabaseConnection: () => Promise<import("drizzle-orm/postgres-js").PostgresJsDatabase>;
    };
    _cachedContextInspectorDb = await sqlProvider.getDatabaseConnection();
    _cachedContextInspectorDbProbed = true;
    return _cachedContextInspectorDb;
  } catch {
    _cachedContextInspectorDbProbed = true;
    return null;
  }
}

// ---------------------------------------------------------------------------
// AskRepository lazy init — uses cockpit-wide PersistenceService singleton.
// ---------------------------------------------------------------------------

let _cachedServerAskRepo: import("@minsky/domain/ask/repository").AskRepository | null = null;

async function getServerAskRepository(): Promise<
  import("@minsky/domain/ask/repository").AskRepository | null
> {
  if (_cachedServerAskRepo) return _cachedServerAskRepo;
  try {
    const { getSharedPersistenceService } = await import("./shared-persistence");
    const { DrizzleAskRepository } = await import("@minsky/domain/ask/repository");
    const svc = await getSharedPersistenceService();
    const provider = svc.getProvider();
    if (
      !("getDatabaseConnection" in provider) ||
      typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !== "function"
    ) {
      return null;
    }
    const sqlProvider = provider as {
      getDatabaseConnection: () => Promise<import("drizzle-orm/postgres-js").PostgresJsDatabase>;
    };
    const db = await sqlProvider.getDatabaseConnection();
    if (!db) return null;
    _cachedServerAskRepo = new DrizzleAskRepository(db);
    return _cachedServerAskRepo;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ask advancement sweeper (mt#2265)
// ---------------------------------------------------------------------------

/**
 * Start the periodic ask-advancement sweep in this cockpit process.
 *
 * Advances `detected` asks the create path missed (emission-callsite rows,
 * rows from crashed processes) and expires stale ones, so the operator
 * surface reflects reality without a manual probe. Runs one pass at boot,
 * then every `intervalMs` (sweeper-not-queue per decision-defaults
 * §Reliability; the asks table is the single source of truth).
 *
 * Fail-open: a failed pass logs and waits for the next tick — the sweep
 * must never crash the cockpit. Overlapping ticks are skipped.
 *
 * @returns stop function (clears the interval).
 */
export function startAskAdvancementSweeper(intervalMs?: number): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const repo = await getServerAskRepository();
      if (!repo) return;
      const { runAskAdvancementSweep } = await import("@minsky/domain/ask/advancement");
      await runAskAdvancementSweep(repo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("cockpit: ask advancement sweep failed", { message });
    } finally {
      running = false;
    }
  };

  void tick();
  const resolvedInterval = intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const id = setInterval(() => void tick(), resolvedInterval);
  // Never hold the process open on account of the sweeper.
  if (typeof id === "object" && "unref" in id) id.unref();
  return () => clearInterval(id);
}

// ---------------------------------------------------------------------------
// Prod-state cache refresh sweeper (mt#2506)
// ---------------------------------------------------------------------------

/**
 * Default refresh interval for the prod-state cache. Kept well below the consumer hook's
 * staleness threshold (`PROD_STATE_STALENESS_MS` = 30m in inject-prod-state.ts) so a healthy
 * sweep keeps the injected snapshot labelled "fresh"; only a stalled/absent sweep trips the
 * hook's STALE path.
 */
const PROD_STATE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Start the periodic prod-state cache refresh in this cockpit process (mt#2506).
 *
 * The PRODUCER half of the hybrid cached-injection for the R10 no-tool-boundary status-claim
 * seam: reads the prod migration ledger via the provider's raw-SQL connection and writes a
 * small local cache that `.claude/hooks/inject-prod-state.ts` injects each turn. Doing the
 * network read here (once at boot, then every `intervalMs`) keeps the per-turn hook read
 * cheap (local fs only) per memory `08606f7c`'s ≤50ms bar.
 *
 * Fail-open: no DB / unreadable ledger / a failed pass logs and waits for the next tick —
 * never crashes the cockpit, and leaves the last-good cache in place. Overlapping ticks skip.
 *
 * @returns stop function (clears the interval).
 */
export function startProdStateRefreshSweeper(intervalMs?: number): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const { getSharedPersistenceService } = await import("./shared-persistence");
      const { refreshProdStateCache } = await import("./prod-state-cache");
      const svc = await getSharedPersistenceService();
      const provider = svc.getProvider();
      const getRawSql =
        "getRawSqlConnection" in provider &&
        typeof (provider as { getRawSqlConnection?: unknown }).getRawSqlConnection === "function"
          ? (provider as { getRawSqlConnection: () => Promise<unknown> }).getRawSqlConnection.bind(
              provider
            )
          : null;
      if (!getRawSql) return;
      const sql = (await getRawSql()) as import("./prod-state-cache").UnsafeSql | null | undefined;
      await refreshProdStateCache(sql, new Date().toISOString());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("cockpit: prod-state refresh sweep failed", { message });
    } finally {
      running = false;
    }
  };

  void tick();
  const resolvedInterval = intervalMs ?? PROD_STATE_REFRESH_INTERVAL_MS;
  const id = setInterval(() => void tick(), resolvedInterval);
  if (typeof id === "object" && "unref" in id) id.unref();
  return () => clearInterval(id);
}

// ---------------------------------------------------------------------------
// Transcript sweep backstop (mt#2321)
// ---------------------------------------------------------------------------

/**
 * Default cadence for the transcript sweep backstop. Longer than the prod-state
 * sweeper (10m) because a full ingestAll + embedding backfill is heavy — it
 * re-discovers every JSONL session in ~/.claude/projects and calls the DB for each.
 * 30m keeps the backstop meaningful (catches sessions missed while the daemon was
 * down, dropped FS events) without hammering the DB on a tight loop.
 */
const TRANSCRIPT_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Resolve the sweep cadence (SC1 — externally configurable). An explicit
 * `MINSKY_TRANSCRIPT_SWEEP_INTERVAL_MS` env override (positive-integer
 * milliseconds) wins; otherwise the default. Env-var config mirrors the
 * cockpit's existing `MINSKY_COCKPIT_*` reads — no config-schema change needed.
 */
export function resolveSweepIntervalMs(): number {
  const raw = process.env.MINSKY_TRANSCRIPT_SWEEP_INTERVAL_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    log.warn("cockpit: ignoring invalid MINSKY_TRANSCRIPT_SWEEP_INTERVAL_MS", { raw });
  }
  return TRANSCRIPT_SWEEP_INTERVAL_MS;
}

/**
 * Injectable runners for the sweep tick — separate from the real DB wiring so
 * unit tests can inject spies without a real DB or filesystem.
 */
export interface TranscriptSweepDeps {
  /** Run a full ingest sweep (wraps ingestAll). Must be idempotent/HWM-gated. */
  runIngest: () => Promise<{ sessionsProcessed: number; sessionsErrored: number }>;
  /** Run the embedding backfill (wraps PerTurnEmbeddingPipeline.run). May throw. */
  runEmbeddings: () => Promise<void>;
  /** Tracker singleton to record observability counters. */
  tracker: TranscriptSweepTracker;
}

/** Options accepted by startTranscriptSweepBackstop. */
export interface TranscriptSweepBackstopOptions {
  /** Cadence override in milliseconds (default: TRANSCRIPT_SWEEP_INTERVAL_MS). */
  intervalMs?: number;
  /**
   * Injectable deps for testing. When absent, the real DB path is used
   * (ClaudeCodeTranscriptSource + AgentTranscriptIngestService + PerTurnEmbeddingPipeline).
   */
  deps?: TranscriptSweepDeps;
}

/**
 * Build the real sweep deps from the shared persistence service.
 * Returns null when the provider is not SQL-capable.
 */
async function buildRealSweepDeps(): Promise<TranscriptSweepDeps | null> {
  const { getSharedPersistenceService } = await import("./shared-persistence");
  const svc = await getSharedPersistenceService();
  const provider = svc.getProvider();

  if (
    !("getDatabaseConnection" in provider) ||
    typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !== "function"
  ) {
    return null;
  }

  const sqlProvider = provider as {
    getDatabaseConnection: () => Promise<
      import("drizzle-orm/postgres-js").PostgresJsDatabase | null
    >;
  };
  const db = await sqlProvider.getDatabaseConnection();
  if (!db) return null;

  const tracker = TranscriptSweepTracker.getInstance();

  const runIngest = async (): Promise<{ sessionsProcessed: number; sessionsErrored: number }> => {
    const { ClaudeCodeTranscriptSource } = await import(
      "@minsky/domain/transcripts/claude-code-transcript-source"
    );
    const { AgentTranscriptIngestService } = await import(
      "@minsky/domain/transcripts/agent-transcript-ingest-service"
    );
    const source = new ClaudeCodeTranscriptSource();
    const svcIngest = new AgentTranscriptIngestService(
      db as import("drizzle-orm/postgres-js").PostgresJsDatabase,
      source
    );
    const result = await svcIngest.ingestAll();
    return {
      sessionsProcessed: result.sessionsProcessed,
      sessionsErrored: result.sessionsErrored,
    };
  };

  const runEmbeddings = async (): Promise<void> => {
    // createEmbeddingServiceFromConfig throws when no embedding provider is
    // configured or reachable. The tick's outer try/catch (fail-open) handles
    // that case: the sweep ingest counters are already recorded, and only the
    // embedding backfill is skipped — per SC2's requirement that a missing
    // embedding provider must not crash the sweep.
    const { createEmbeddingServiceFromConfig } = await import(
      "@minsky/domain/ai/embedding-service-factory"
    );
    const embeddingService = await createEmbeddingServiceFromConfig();
    const { PerTurnEmbeddingPipeline } = await import(
      "@minsky/domain/transcripts/per-turn-embedding-pipeline"
    );
    const pipeline = new PerTurnEmbeddingPipeline(
      db as import("drizzle-orm/postgres-js").PostgresJsDatabase,
      embeddingService
    );
    await pipeline.run();
  };

  return { runIngest, runEmbeddings, tracker };
}

/**
 * Start the periodic transcript sweep backstop in this cockpit process (mt#2321).
 *
 * BACKSTOP half of ADR-017 (the primary capture path is the FS watcher, mt#2320).
 * Covers failure modes the watcher cannot recover:
 *   - Dropped / coalesced / lost FS-watch events
 *   - Sessions that completed while the cockpit daemon was DOWN
 *   - Sessions predating the watcher's attach that seedExisting did not cover
 *   - Stale / missing pgvector embeddings (via the embedded backfill pass)
 *
 * Sweeper convention (mirrors startAskAdvancementSweeper and startProdStateRefreshSweeper):
 *   - `running` flag skips overlapping ticks
 *   - fail-open try/catch + log.warn on every failure path
 *   - `void tick()` boot pass
 *   - `setInterval` + `.unref()` so the process never stays alive for the sweep alone
 *   - returns `() => clearInterval(id)` stop function
 *
 * Deps are injectable so the sweep core can be unit-tested without a real DB or filesystem.
 *
 * @see docs/architecture/cockpit.md — Transcript sweep backstop (cadence + /api/health payload)
 * @returns stop function (clears the interval).
 */
export function startTranscriptSweepBackstop(opts?: TranscriptSweepBackstopOptions): () => void {
  let running = false;
  const resolvedInterval = opts?.intervalMs ?? resolveSweepIntervalMs();

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // Resolve deps: injected (for tests) or real (for production).
      let sweepDeps: TranscriptSweepDeps | null;
      if (opts?.deps) {
        sweepDeps = opts.deps;
      } else {
        sweepDeps = await buildRealSweepDeps();
      }

      if (!sweepDeps) {
        // Non-SQL provider: nothing to sweep.
        log.debug("cockpit: transcript sweep: no SQL-capable DB, skipping tick");
        return;
      }

      const { runIngest, runEmbeddings, tracker } = sweepDeps;

      // ── Phase 1: ingest sweep (idempotent/HWM-gated) ──────────────────────
      let ingestResult: { sessionsProcessed: number; sessionsErrored: number };
      try {
        ingestResult = await runIngest();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: transcript sweep: ingest failed", { message });
        sweepDeps.tracker.recordSweepError();
        return; // Can't meaningfully record a completed sweep if ingest threw.
      }

      // Record ingest counters (includes error count — surfaced, not dropped).
      if (ingestResult.sessionsErrored > 0) {
        log.warn("cockpit: transcript sweep: ingest completed with per-session errors", {
          sessionsProcessed: ingestResult.sessionsProcessed,
          sessionsErrored: ingestResult.sessionsErrored,
        });
      }
      tracker.recordSweepCompleted(ingestResult.sessionsProcessed, ingestResult.sessionsErrored);

      // ── Phase 2: embedding backfill (heavy, fail-open) ─────────────────────
      // SC2: default semantic-embedding backfill, run off the critical path.
      // A missing embedding provider, API error, or DB timeout must NOT crash
      // the sweep or prevent the ingest counters from being recorded.
      try {
        await runEmbeddings();
        tracker.recordEmbedRunCompleted();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: transcript sweep: embedding backfill failed (non-fatal)", { message });
        tracker.recordSweepError();
        // No return: the ingest phase already completed successfully.
      }
    } catch (err) {
      // Outermost safety net — unexpected throw escaping either phase.
      const message = err instanceof Error ? err.message : String(err);
      log.warn("cockpit: transcript sweep: unexpected error in tick", { message });
      // If we have injected deps, at least record an error.
      if (opts?.deps) {
        opts.deps.tracker.recordSweepError();
      } else {
        TranscriptSweepTracker.getInstance().recordSweepError();
      }
    } finally {
      running = false;
    }
  };

  void tick();
  const id = setInterval(() => void tick(), resolvedInterval);
  // Never hold the process open on account of the sweeper.
  if (typeof id === "object" && "unref" in id) id.unref();
  return () => clearInterval(id);
}

// ---------------------------------------------------------------------------
// Task service lazy init — uses cockpit-wide PersistenceService singleton.
// ---------------------------------------------------------------------------

interface TaskDetailDeps {
  taskService: import("@minsky/domain/tasks/taskService").TaskServiceInterface;
  taskGraphService: import("@minsky/domain/tasks/task-graph-service").TaskGraphService;
}

let _cachedTaskService: import("@minsky/domain/tasks/taskService").TaskServiceInterface | null =
  null;
let _cachedTaskDetailDeps: TaskDetailDeps | null = null;

async function getServerTaskService(): Promise<
  import("@minsky/domain/tasks/taskService").TaskServiceInterface | null
> {
  if (_cachedTaskService) return _cachedTaskService;
  try {
    const { getSharedPersistenceService } = await import("./shared-persistence");
    const { createConfiguredTaskService } = await import("@minsky/domain/tasks/taskService");
    const svc = await getSharedPersistenceService();
    const provider = svc.getProvider();
    const taskService = await createConfiguredTaskService({
      workspacePath: process.cwd(),
      persistenceProvider: provider,
    });
    _cachedTaskService = taskService;
    return _cachedTaskService;
  } catch {
    return null;
  }
}

/**
 * Lazy-cached task detail deps (TaskService + TaskGraphService).
 * Uses cockpit-wide PersistenceService singleton.
 */
async function getServerTaskDetailDeps(): Promise<TaskDetailDeps | null> {
  if (_cachedTaskDetailDeps) return _cachedTaskDetailDeps;
  try {
    const { getSharedPersistenceService } = await import("./shared-persistence");
    const { createConfiguredTaskService } = await import("@minsky/domain/tasks/taskService");
    const { TaskGraphService } = await import("@minsky/domain/tasks/task-graph-service");

    const svc = await getSharedPersistenceService();
    const provider = svc.getProvider();

    const taskService = await createConfiguredTaskService({
      workspacePath: process.cwd(),
      persistenceProvider: provider,
    });

    const sqlProvider =
      provider as import("@minsky/domain/persistence/types").SqlCapablePersistenceProvider;
    const db = await sqlProvider.getDatabaseConnection?.();
    if (!db) return null;

    const taskGraphService = new TaskGraphService(
      db as import("drizzle-orm/postgres-js").PostgresJsDatabase
    );

    _cachedTaskDetailDeps = { taskService, taskGraphService };
    return _cachedTaskDetailDeps;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session provider lazy init — uses cockpit-wide PersistenceService singleton
// (mt#1919). Mirrors the agents-widget defaultProviderFactory; kept separate
// so the endpoint and the widget caches stay independently invalidatable
// (mt#2362 touches the widget's cache).
// ---------------------------------------------------------------------------

let _cachedServerSessionProvider:
  | import("@minsky/domain/session/types").SessionProviderInterface
  | null = null;

async function getServerSessionProvider(): Promise<
  import("@minsky/domain/session/types").SessionProviderInterface | null
> {
  if (_cachedServerSessionProvider) return _cachedServerSessionProvider;
  try {
    const { getSharedPersistenceService } = await import("./shared-persistence");
    const { createSessionProvider } = await import(
      "@minsky/domain/session/drizzle-session-repository"
    );
    const svc = await getSharedPersistenceService();
    const provider = await createSessionProvider(undefined, {
      persistenceService: {
        isInitialized: () => true,
        getProvider: () => svc.getProvider(),
      },
    });
    _cachedServerSessionProvider = provider;
    return provider;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Attention-window channel names — must match notify.ts emit side
// ---------------------------------------------------------------------------

const CHANNEL_ATTENTION_OPENED = "minsky.attention_window_opened";
const CHANNEL_ATTENTION_CLOSED = "minsky.attention_window_closed";

// Future channels per ADR-010 §3 — added to the pre-subscribe list so SSE
// clients requesting `session.*` or `task.*` topics deliver events as soon as
// mt#1854 wires the emit sites. Pre-subscribing to a channel with no current
// producer is a no-op cost (one open Postgres LISTEN registration per channel
// over a single connection); the SSE client side filters dynamically via
// `matchesTopic` so spurious events are impossible.
const CHANNEL_SESSION_STARTED = "minsky.session.started";
const CHANNEL_SESSION_SCOPE_CHANGED = "minsky.session.scope_changed";
const CHANNEL_TASK_STATUS_CHANGED = "minsky.task.status_changed";
const CHANNEL_TASK_BLOCKING = "minsky.task.blocking";

// Credential invalidation events (mt#1426). Producer:
// `notifyCredentialInvalidated` in src/domain/credentials/invalidations.ts.
// Mirror constant: `CHANNEL_CREDENTIAL_INVALIDATED` in that file.
const CHANNEL_CREDENTIAL_INVALIDATED = "minsky.credential.invalidated";

/**
 * Canonical list of all Postgres NOTIFY channels this cockpit-server process
 * pre-subscribes to at broker init time. Comprehensive coverage of the
 * ADR-010 channel taxonomy — clients requesting any `attention.*`,
 * `session.*`, or `task.*` topic filter receive events the moment any
 * producer fires on a matching channel.
 *
 * IMPORTANT: postgres-js `sql.listen()` does NOT support wildcard channel
 * names. Clients may subscribe with patterns like `attention.*`, but the
 * broker must enumerate concrete channel names here. The set is comprehensive
 * (covers all ADR-010 §3 canonical channels) so dynamic client-requested
 * topics across the spec's namespace are satisfied without ever needing
 * runtime channel registration. When ADR-010 grows a new channel-class, add
 * it here.
 *
 * Status today:
 *   - `minsky.attention_window_opened` / `..._closed` — producer live (mt#1411)
 *   - `minsky.session.started` / `..._scope_changed` — producer pending mt#1854
 *   - `minsky.task.status_changed` / `..._blocking` — producer pending mt#1854
 *
 * Pre-subscribing channels with no current producer is harmless: postgres-js
 * holds one LISTEN per channel name over the listener's single connection;
 * a NOTIFY-less channel costs nothing.
 */
export const COCKPIT_SSE_CHANNELS: readonly string[] = [
  CHANNEL_ATTENTION_OPENED,
  CHANNEL_ATTENTION_CLOSED,
  CHANNEL_SESSION_STARTED,
  CHANNEL_SESSION_SCOPE_CHANGED,
  CHANNEL_TASK_STATUS_CHANGED,
  CHANNEL_TASK_BLOCKING,
  CHANNEL_CREDENTIAL_INVALIDATED,
] as const;

// ---------------------------------------------------------------------------
// SSE broker — one shared broker per cockpit-server process.
// Initialised eagerly at server startup (not lazily on first request) to
// avoid a race where the first /api/events connection triggers init and misses
// events that fire during the init window.
// ---------------------------------------------------------------------------

let _cachedSseBroker: SseBroker | null = null;

/**
 * Exported accessor for the shared SSE broker — used by the attention widget's
 * `defaultDepsFactory` to read the active window key from the ring buffer.
 * Returns null when the broker is unavailable (init not yet called or failed).
 */
export async function getServerSseBrokerForWidget(): Promise<SseBroker | null> {
  return getServerSseBroker();
}

/**
 * Initialise the SSE broker and pre-subscribe to all canonical channels in
 * `COCKPIT_SSE_CHANNELS`.
 *
 * When the persistence provider is not Postgres (e.g. offline mode),
 * the broker is wired with a no-op listener. Clients that connect to
 * `/api/events` will receive an open SSE stream but no events — the endpoint
 * returns 200 (not 503), because the broker IS available; it just has no
 * Postgres backend to deliver events from. This is the documented behaviour
 * for non-Postgres deployments: the stream is open but silent.
 *
 * Returns null only when the entire init path throws unexpectedly (e.g. a
 * Postgres provider that fails to connect). In that case `/api/events` returns
 * 503.
 */
async function getServerSseBroker(): Promise<SseBroker | null> {
  if (_cachedSseBroker) return _cachedSseBroker;

  try {
    const { getSharedPersistenceService } = await import("./shared-persistence");
    const svc = await getSharedPersistenceService();
    const provider = svc.getProvider();

    // Require getListenCapableSqlConnection — only the Postgres provider has it
    if (
      !("getListenCapableSqlConnection" in provider) ||
      typeof (provider as { getListenCapableSqlConnection?: unknown })
        .getListenCapableSqlConnection !== "function"
    ) {
      const noopListener = createNoopChannelListener();
      const broker = new SseBroker(noopListener);
      _cachedSseBroker = broker;
      return broker;
    }

    const sqlProvider = provider as {
      getListenCapableSqlConnection: () => Promise<ReturnType<typeof import("postgres")>>;
    };
    const sql = await sqlProvider.getListenCapableSqlConnection();

    const listener = new PostgresChannelListener(sql);
    const broker = new SseBroker(listener);

    for (const channel of COCKPIT_SSE_CHANNELS) {
      await broker.ensureChannel(channel);
    }

    _cachedSseBroker = broker;
    return broker;
  } catch {
    return null;
  }
}

/**
 * Eagerly initialise the SSE broker at server startup.
 *
 * Called by the cockpit server entry-point before any HTTP requests are
 * served. Ensures channels are pre-subscribed before the first client
 * connects, avoiding the race condition where a client subscribes to
 * `attention.*` while the broker is still initialising.
 *
 * Safe to call multiple times — subsequent calls are no-ops once the broker
 * is cached.
 */
export async function initServerSseBroker(): Promise<void> {
  await getServerSseBroker();
}

// ---------------------------------------------------------------------------
// SSE formatting helpers
// ---------------------------------------------------------------------------

/**
 * Write a single SSE event to the Express response.
 *
 * SSE format:
 *   id: <id>\n
 *   data: <json>\n
 *   \n
 */
function writeSseEvent(res: express.Response, event: SseEvent): void {
  res.write(`id: ${event.id}\n`);
  res.write(
    `data: ${JSON.stringify({ channel: event.channel, payload: event.payload, at: event.at })}\n`
  );
  res.write("\n");
}

export function createCockpitServer(opts: CockpitServerOptions = {}): express.Express {
  // Resolve the effective registry (builtins + any test-injected widgets).
  // The registry is the single source of truth for which widgets exist; a
  // registered widget's data endpoint is always served. There is no per-widget
  // enable flag — capability (does the widget exist) is decoupled from layout
  // (which cards the home dashboard renders, decided on the frontend). See mt#2294.
  const effectiveRegistry: WidgetRegistry = {
    ...WIDGET_REGISTRY,
    ...(opts.overrideRegistry ?? {}),
  };

  // AskRepository override for tests
  const askRepoOverride = opts.overrideAskRepository ?? null;

  // SseBroker override for tests
  const sseBrokerOverride = opts.overrideSseBroker ?? null;

  // Credential module override for tests
  const credModuleOverride = opts.overrideCredentialModule ?? null;

  // Every registered widget is available; the data endpoint is registry-gated.
  const availableWidgets = new Map<string, WidgetModule>(Object.entries(effectiveRegistry));

  // Inform basic-health of the loaded widget count
  setLoadedWidgetCount(availableWidgets.size);

  const app = express();
  app.use(express.json());

  // Preview-mode guard (mt#2096): block mutation endpoints in preview deploys.
  // Defense-in-depth API layer — paired with a read-only Supabase DB role.
  if (process.env.MINSKY_COCKPIT_PREVIEW === "true") {
    app.use("/api", (req, res, next) => {
      if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
        next();
        return;
      }
      res.status(403).json({
        error: "Preview mode: mutations are disabled",
        preview: true,
      });
    });
  }

  // --- API endpoints ---

  /** GET /api/health */
  app.get("/api/health", (_req, res) => {
    const uptimeSec = Math.floor((Date.now() - serverStartTime) / 1000);
    let version = "unknown";
    try {
      // Attempt to read version from package.json relative to project root
      const pkgPath = path.join(__dirname, "..", "..", "package.json");
      const raw = String(fs.readFileSync(pkgPath));
      const pkg = JSON.parse(raw) as { version?: string };
      version = pkg.version ?? "unknown";
    } catch {
      // fallback: unknown
    }
    // Transcript watcher observability (mt#2320 SC2/SC5): the watcher runs in
    // THIS cockpit process, so its tracker singleton is readable here directly
    // (it is intentionally not on debug_systemInfo, which is a different
    // process). Exposes aggregate counters + the per-session freshness registry.
    const watcherTracker = TranscriptWatcherTracker.getInstance();
    // Transcript sweep backstop observability (mt#2321 SC3): the sweep also runs
    // in THIS cockpit process. Aggregate counters only; no raw error strings
    // (redaction policy — same as the watcher tracker above, per reviewer R1 on
    // mt#2320).
    const sweepTracker = TranscriptSweepTracker.getInstance();
    res.json({
      status: "ok",
      version,
      commit: getGitCommit(),
      uptimeSec,
      transcriptWatcher: {
        ...watcherTracker.getSummary(),
        activeSessions: watcherTracker.getActiveSessions(),
      },
      transcriptSweep: sweepTracker.getSummary(),
    });
  });

  /** GET /api/widgets — metadata for every registered widget */
  app.get("/api/widgets", (_req, res) => {
    const widgets = Array.from(availableWidgets.values()).map((w) => ({
      id: w.id,
      title: w.title,
      updateMode: w.updateMode,
    }));
    res.json(widgets);
  });

  /** GET /api/widget/:id/data — registry-gated; 404 only for unregistered ids */
  app.get("/api/widget/:id/data", async (req, res) => {
    const widget = availableWidgets.get(req.params.id);
    if (!widget) {
      res.status(404).json({ error: "Widget not found" });
      return;
    }
    try {
      const query: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query)) {
        if (typeof v === "string") query[k] = v;
      }
      const data = await widget.fetch({ id: req.params.id, query });
      res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ state: "degraded", reason: `Widget crashed: ${message}` });
    }
  });

  /**
   * GET /api/tasks/:id — task detail for the drill-down page (mt#1918).
   *
   * Returns: { task, spec, parent, children, deps }
   * Uses the shared task-detail deps singleton (TaskService + TaskGraphService).
   * IMPORTANT: This route must be registered BEFORE /api/tasks (the list
   * endpoint) so Express evaluates it first. Express matches routes in
   * registration order; the parameterised /:id would otherwise never fire
   * because /api/tasks (exact) would catch same-length paths first — but to
   * be safe we register /:id before the exact /api/tasks route.
   */
  app.get("/api/tasks/:id", async (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      res.status(400).json({ error: "Task ID required" });
      return;
    }
    // Accept both URL-encoded (mt%231918) and raw (mt#1918) forms
    const taskId = decodeURIComponent(rawId);

    try {
      const taskDetailDeps = await getServerTaskDetailDeps();
      if (!taskDetailDeps) {
        res.status(503).json({
          error: "Task service unavailable — persistence provider not ready",
        });
        return;
      }

      const { taskService, taskGraphService } = taskDetailDeps;
      const { formatTaskIdForDisplay } = await import("@minsky/domain/tasks/task-id-utils");

      // Fetch task metadata and spec in parallel — they don't depend on each other
      const [taskResult, specResult] = await Promise.allSettled([
        taskService.getTask(taskId),
        taskService.getTaskSpecContent(taskId).catch(() => null),
      ]);

      if (taskResult.status === "rejected") {
        const reason =
          taskResult.reason instanceof Error
            ? taskResult.reason.message
            : String(taskResult.reason);
        if (reason.toLowerCase().includes("not found")) {
          res.status(404).json({ error: `Task ${taskId} not found` });
        } else {
          res.status(500).json({ error: reason });
        }
        return;
      }

      const task = taskResult.value;
      if (!task) {
        res.status(404).json({ error: `Task ${taskId} not found` });
        return;
      }

      const specContent =
        specResult.status === "fulfilled" && specResult.value ? specResult.value.content : null;

      // Fetch parent, children, and deps in parallel via TaskGraphService
      // listDependencies → outgoing (what this task depends on)
      // listDependents  → incoming (what depends on this task)
      const [parentIdResult, childIdsResult, outgoingIdsResult, incomingIdsResult] =
        await Promise.allSettled([
          taskGraphService.getParent(taskId),
          taskGraphService.listChildren(taskId),
          taskGraphService.listDependencies(taskId),
          taskGraphService.listDependents(taskId),
        ]);

      // Collect all referenced task IDs so we can batch-fetch their metadata
      const referencedIds = new Set<string>();
      if (parentIdResult.status === "fulfilled" && parentIdResult.value) {
        referencedIds.add(parentIdResult.value);
      }
      if (childIdsResult.status === "fulfilled") {
        for (const id of childIdsResult.value ?? []) referencedIds.add(id);
      }
      if (outgoingIdsResult.status === "fulfilled") {
        for (const id of outgoingIdsResult.value ?? []) referencedIds.add(id);
      }
      if (incomingIdsResult.status === "fulfilled") {
        for (const id of incomingIdsResult.value ?? []) referencedIds.add(id);
      }

      // Batch-fetch metadata for all referenced tasks
      const refTasksArr =
        referencedIds.size > 0 ? await taskService.getTasks([...referencedIds]) : [];
      const refTaskMap = new Map(refTasksArr.map((t) => [t.id, t]));

      function taskRef(id: string): { id: string; title: string; status: string } {
        const t = refTaskMap.get(id);
        return {
          id: formatTaskIdForDisplay(id),
          title: t?.title ?? "",
          status: ((t?.status ?? "TODO") as string).toUpperCase(),
        };
      }

      const parentId = parentIdResult.status === "fulfilled" ? parentIdResult.value : null;
      const parent = parentId ? taskRef(parentId) : null;

      const childIds = childIdsResult.status === "fulfilled" ? (childIdsResult.value ?? []) : [];
      const children = childIds.map(taskRef);

      const outgoingIds =
        outgoingIdsResult.status === "fulfilled" ? (outgoingIdsResult.value ?? []) : [];
      const incomingIds =
        incomingIdsResult.status === "fulfilled" ? (incomingIdsResult.value ?? []) : [];

      const taskDeps = {
        outgoing: outgoingIds.map(taskRef),
        incoming: incomingIds.map(taskRef),
      };

      res.json({
        task: {
          id: formatTaskIdForDisplay(task.id),
          title: task.title ?? "",
          status: (task.status ?? "TODO").toUpperCase(),
          kind: task.kind ?? "implementation",
          tags: task.tags ?? [],
        },
        spec: specContent,
        parent,
        children,
        deps: taskDeps,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[tasks] GET /api/tasks/:id — internal error: ${message}`);
      res.status(500).json({ error: "An internal error occurred while fetching the task." });
    }
  });

  /**
   * GET /api/agents/:id — workspace-session detail for the drill-down page
   * (mt#1919). Keyed by the MINSKY workspace sessionId (not the harness
   * agentSessionId — see src/cockpit/session-detail.ts header).
   *
   * Returns: SessionDetailPayload { session, commits, pr, conversation }
   * Every enrichment (git log, task title, transcript resolution) degrades
   * independently — only a missing session record is a 404.
   */
  app.get("/api/agents/:id", async (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      res.status(400).json({ error: "Session ID required" });
      return;
    }
    const sessionId = decodeURIComponent(rawId);

    try {
      const provider = await getServerSessionProvider();
      if (!provider) {
        res.status(503).json({
          error: "Session service unavailable — persistence provider not ready",
        });
        return;
      }

      const record = await provider.getSession(sessionId);
      if (!record) {
        res.status(404).json({ error: `Session ${sessionId} not found` });
        return;
      }

      const { buildSessionMeta, buildPrRef, githubRepoWebBase, parseGitLog, GIT_LOG_FORMAT } =
        await import("./session-detail");

      // Workspace dir: record fields first, provider lookup as fallback.
      let workdir: string | null = record.workspacePath ?? record.sessionPath ?? null;
      if (!workdir) {
        try {
          workdir = await provider.getSessionWorkdir(sessionId);
        } catch {
          workdir = null;
        }
      }

      // Enrichments run in parallel; each degrades to a safe default.
      const repoWebBase = githubRepoWebBase(record.repoUrl);

      const commitsPromise: Promise<ReturnType<typeof parseGitLog>> = (async () => {
        if (!workdir) return [];
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        // .git may be a directory (normal checkout) or a file (worktree
        // indirection) — existsSync covers both. A workspace without it is
        // not a git checkout; skip rather than let git walk up to a parent repo.
        if (!existsSync(workdir) || !existsSync(join(workdir, ".git"))) {
          log.debug(`[agents] commits enrichment skipped — no git workspace at ${workdir}`);
          return [];
        }
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        try {
          const { stdout } = await execFileAsync(
            "git",
            ["-C", workdir, "log", `--format=${GIT_LOG_FORMAT}`, "-n", "10"],
            { timeout: 5_000, maxBuffer: 256 * 1024 }
          );
          return parseGitLog(stdout, repoWebBase);
        } catch (gitErr) {
          const msg = gitErr instanceof Error ? gitErr.message : String(gitErr);
          log.debug(`[agents] commits enrichment degraded — git log failed: ${msg}`);
          return [];
        }
      })();

      const taskTitlePromise: Promise<string | null> = (async () => {
        if (!record.taskId) return null;
        try {
          const taskService = await getServerTaskService();
          if (!taskService) return null;
          const task = await taskService.getTask(record.taskId);
          return task?.title ?? null;
        } catch (titleErr) {
          const msg = titleErr instanceof Error ? titleErr.message : String(titleErr);
          log.debug(`[agents] task-title enrichment degraded: ${msg}`);
          return null;
        }
      })();

      // Workspace → transcript resolution (mt#2420 deferral): newest
      // agent_transcripts row whose cwd is the session workspace (or below).
      const conversationPromise: Promise<{ agentSessionId: string } | null> = (async () => {
        if (!workdir) return null;
        try {
          const db = await getContextInspectorDb();
          if (!db) return null;
          const { agentTranscriptsTable } = await import(
            "@minsky/domain/storage/schemas/agent-transcripts-schema"
          );
          const { eq, like, or, desc, sql } = await import("drizzle-orm");
          // Escape LIKE wildcards in the literal path (Postgres default escape
          // char is backslash), then match descendants under either separator —
          // POSIX "/" and Windows "\" (stored as an escaped "\\" in the pattern).
          const escaped = workdir.replace(/([\\%_])/g, "\\$1");
          const rows = await db
            .select({ agentSessionId: agentTranscriptsTable.agentSessionId })
            .from(agentTranscriptsTable)
            .where(
              or(
                eq(agentTranscriptsTable.cwd, workdir),
                like(agentTranscriptsTable.cwd, `${escaped}/%`),
                like(agentTranscriptsTable.cwd, `${escaped}\\\\%`)
              )
            )
            .orderBy(sql`${desc(agentTranscriptsTable.startedAt)} NULLS LAST`)
            .limit(1);
          const first = rows[0];
          return first ? { agentSessionId: first.agentSessionId } : null;
        } catch (convErr) {
          const msg = convErr instanceof Error ? convErr.message : String(convErr);
          log.debug(`[agents] conversation enrichment degraded: ${msg}`);
          return null;
        }
      })();

      const [commits, taskTitle, conversation] = await Promise.all([
        commitsPromise,
        taskTitlePromise,
        conversationPromise,
      ]);

      res.json({
        session: buildSessionMeta(record, taskTitle),
        commits,
        pr: buildPrRef(record),
        conversation,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[agents] GET /api/agents/:id — internal error: ${message}`);
      res.status(500).json({ error: "An internal error occurred while fetching the session." });
    }
  });

  /**
   * GET /api/tasks — lightweight task list for the command palette (mt#1917).
   *
   * Returns: { tasks: { id, title, status }[] }
   * Uses the shared task service singleton (same bootstrap pattern as
   * workstreams.ts). Returns 503 when the task service is unavailable.
   * Most-recently-updated first before the 500-cap (mt#2444): an unordered
   * slice over a >500 backlog hid every recent task from the palette.
   *
   * Query params:
   *   ?all=true — return ALL task ids regardless of status (DONE/CLOSED/COMPLETED
   *               included). Used by the entity-index linkifier (mt#2518) to make
   *               the task id-set comprehensive so every transcript ref links.
   *               Without this flag the default excludes terminal statuses, which
   *               caused only 2 of 70 task refs to link in live transcripts.
   */
  app.get("/api/tasks", async (req, res) => {
    try {
      const taskService = await getServerTaskService();
      if (!taskService) {
        res.status(503).json({
          error: "Task service unavailable — persistence provider not ready",
        });
        return;
      }
      const { formatTaskIdForDisplay } = await import("@minsky/domain/tasks/task-id-utils");
      const { sortTasksByRecency } = await import("./palette-tasks");
      // ?all=true: include DONE/CLOSED/COMPLETED tasks (needed by the entity-index
      // linkifier in ConversationView — mt#2518). Without this flag the backend
      // default hides terminal-status tasks, leaving most transcript refs unlinkified.
      const includeAll = req.query.all === "true";
      const tasks = await taskService.listTasks({ all: includeAll });
      const taskList = sortTasksByRecency(tasks)
        .slice(0, 500)
        .map((t) => ({
          id: formatTaskIdForDisplay(t.id),
          title: t.title ?? "",
          status: (t.status ?? "TODO").toUpperCase(),
        }));
      res.json({ tasks: taskList });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[tasks] GET /api/tasks — internal error: ${message}`);
      res.status(500).json({ error: "An internal error occurred while listing tasks." });
    }
  });

  /**
   * GET /api/events — SSE stream of Postgres NOTIFY events (mt#1853)
   *
   * Query params:
   *   ?topics=<comma-separated patterns>   — topic filter (e.g. "attention.*,session.*")
   *     Glob prefix syntax: "attention.*" matches any channel containing "attention"
   *     as a dotted segment. Bare "*" matches everything. Exact match also supported.
   *     Omitting topics (or empty string) defaults to subscribing to all channels ("*").
   *
   * Request headers:
   *   Last-Event-ID: <id>   — resume from a prior event (replays buffered events after it)
   *
   * Response:
   *   Content-Type: text/event-stream
   *   Each event: "id: <id>\ndata: <json>\n\n"
   *   Heartbeat: ": keep-alive\n\n" every 30 seconds to prevent proxy timeouts
   *
   * Returns 400 if topics param is malformed. Returns 503 if the SSE broker
   * is unavailable (no Postgres connection).
   */
  app.get("/api/events", async (req, res) => {
    // Resolve broker (override in tests, or lazy-init the real one)
    const broker = sseBrokerOverride ?? (await getServerSseBroker());
    if (!broker) {
      res.status(503).json({
        error: "SSE broker unavailable — persistence provider does not support LISTEN/NOTIFY",
      });
      return;
    }

    // Parse ?topics= query param with trust-boundary guard
    let topicPatterns: string[];
    try {
      const topicsParam = req.query["topics"];
      if (!topicsParam || topicsParam === "") {
        topicPatterns = ["*"]; // default: all channels
      } else if (typeof topicsParam !== "string") {
        res.status(400).json({ error: "topics must be a comma-separated string" });
        return;
      } else {
        topicPatterns = topicsParam
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
        if (topicPatterns.length === 0) {
          topicPatterns = ["*"];
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: `Invalid topics parameter: ${message}` });
      return;
    }

    // Parse Last-Event-ID header with trust-boundary guard
    let lastEventId: string | undefined;
    try {
      const rawLastId = req.headers["last-event-id"];
      if (typeof rawLastId === "string" && rawLastId.length > 0) {
        lastEventId = rawLastId;
      }
    } catch {
      // Ignore malformed header — treat as no last-event-id
    }

    // Write SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering for SSE
    });
    res.flushHeaders();

    // Create and attach a client stub
    const clientId = randomUUID();
    let closed = false;

    const client: SseClient = {
      id: clientId,
      topics: topicPatterns,
      get closed() {
        return closed;
      },
      send(event: SseEvent): void {
        if (closed) return;
        writeSseEvent(res, event);
      },
      close(): void {
        closed = true;
      },
    };

    // Replay buffered events after lastEventId (if provided)
    const replayEvents = broker.attachClient(client, lastEventId);
    for (const ev of replayEvents) {
      writeSseEvent(res, ev);
    }

    // Heartbeat to prevent proxy timeout
    const heartbeat = setInterval(() => {
      if (closed) {
        clearInterval(heartbeat);
        return;
      }
      res.write(": keep-alive\n\n");
    }, 30_000);

    // Cleanup on client disconnect
    req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      broker.detachClient(clientId);
    });
  });

  /**
   * GET /api/activity — list system events for the activity feed (mt#2092)
   *
   * Query params (mt#2340):
   *   - eventType: filter by a single event type. Must be a valid
   *                SystemEventType; an invalid value is a 400.
   *   - category:  filter by category — `actionable` or `informational`.
   *                Omit the param entirely to include ALL categories (the
   *                client drops it rather than sending a sentinel). An invalid
   *                value is a 400 (no `all` sentinel; strict at the boundary
   *                so a typo can't silently produce an empty `IN ()` filter).
   *   - limit:     max results (default 100, max 500)
   *
   * Returns: { events: SystemEvent[], total: number, limit: number }
   */
  app.get("/api/activity", async (req, res) => {
    try {
      const db = await getContextInspectorDb();
      if (!db) {
        res.status(503).json({
          error: "DB unavailable — persistence provider does not support SQL",
        });
        return;
      }

      const { listEvents } = await import("@minsky/domain/events/query");
      const { SYSTEM_EVENT_TYPE_VALUES, EVENT_CATEGORY_VALUES } = await import(
        "@minsky/domain/storage/schemas/system-events-schema"
      );
      type SystemEventType =
        import("@minsky/domain/storage/schemas/system-events-schema").SystemEventType;
      type EventCategory =
        import("@minsky/domain/storage/schemas/system-events-schema").EventCategory;

      // Validate filter params strictly at the trust boundary. Invalid values
      // are rejected with 400 rather than cast through — a bogus `category`
      // would otherwise resolve to an empty `WHERE event_type IN ()` and
      // silently return zero rows (mt#2340 R1 review).
      const rawEventType = req.query["eventType"];
      let eventType: SystemEventType | undefined;
      if (typeof rawEventType === "string") {
        if (!(SYSTEM_EVENT_TYPE_VALUES as readonly string[]).includes(rawEventType)) {
          res.status(400).json({
            error: `Invalid eventType '${rawEventType}'. Valid values: ${SYSTEM_EVENT_TYPE_VALUES.join(", ")}`,
          });
          return;
        }
        eventType = rawEventType as SystemEventType;
      }

      const rawCategory = req.query["category"];
      let category: EventCategory | undefined;
      if (typeof rawCategory === "string") {
        if (!(EVENT_CATEGORY_VALUES as readonly string[]).includes(rawCategory)) {
          res.status(400).json({
            error: `Invalid category '${rawCategory}'. Valid values: ${EVENT_CATEGORY_VALUES.join(", ")} (omit the param for all categories)`,
          });
          return;
        }
        category = rawCategory as EventCategory;
      }

      const limitParam =
        typeof req.query["limit"] === "string" ? parseInt(req.query["limit"], 10) : 100;
      const limit = isNaN(limitParam) ? 100 : Math.min(Math.max(limitParam, 1), 500);

      const events = await listEvents(db, { eventType, category, limit });

      res.json({ events, total: events.length, limit });
    } catch (err: unknown) {
      res.status(500).json({
        error: `Failed to list events: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  /**
   * GET /api/asks — list all pending operator-routed asks (mt#1916)
   *
   * Returns: { asks: Ask[], total: number }
   *
   * Lists all suspended asks routed to "operator", sorted by priority.
   * Used by the /asks management page for the full list view.
   *
   * Architecture note: the cockpit server is a direct domain-layer consumer
   * (same as the mt#1147 resolve endpoint). MCP tools (asks_respond,
   * asks_reconcile) are the agent-facing interface to the same domain
   * operations — the cockpit backend does not route through MCP to itself.
   */
  app.get("/api/asks", async (_req, res) => {
    try {
      const repo = askRepoOverride ?? (await getServerAskRepository());
      if (!repo) {
        res.status(503).json({
          error: "Ask repository unavailable — persistence provider does not support SQL",
        });
        return;
      }

      const { isTerminal } = await import("@minsky/domain/ask/state-machine");
      const { compareAskPriority } = await import("@minsky/domain/ask/pending-asks-for-window");

      const suspended = await repo.listByState("suspended");
      const operatorAsks = suspended.filter(
        (a) => a.routingTarget === "operator" && !isTerminal(a.state)
      );
      operatorAsks.sort(compareAskPriority);

      const asks = operatorAsks.map((a) => ({
        id: a.id,
        kind: a.kind,
        state: a.state,
        title: a.title,
        question: a.question,
        requestor: a.requestor,
        routingTarget: a.routingTarget,
        parentTaskId: a.parentTaskId,
        parentSessionId: a.parentSessionId,
        options: a.options,
        contextRefs: a.contextRefs,
        deadline: a.deadline,
        createdAt: a.createdAt,
        suspendedAt: a.suspendedAt,
        windowKey: a.windowKey,
        windowMissedCount: a.windowMissedCount ?? 0,
        serviceStrategy: a.serviceStrategy,
        metadata: a.metadata,
      }));

      res.json({ asks, total: asks.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/asks/:id/defer — defer an ask to the next service window (mt#1916)
   *
   * Transitions the ask back to "routed" state so it re-enters the routing
   * queue and appears in the next window's cohort.
   */
  app.post("/api/asks/:id/defer", async (req, res) => {
    const askId = req.params.id;
    if (!askId) {
      res.status(400).json({ error: "Ask ID required" });
      return;
    }
    try {
      const repo = askRepoOverride ?? (await getServerAskRepository());
      if (!repo) {
        res.status(503).json({ error: "Ask repository unavailable" });
        return;
      }
      const ask = await repo.transition(askId, "routed");
      res.json({ ok: true, id: ask.id, state: ask.state });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        res.status(404).json({ error: message });
      } else if (message.includes("Invalid transition")) {
        res.status(409).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  /**
   * POST /api/asks/:id/escalate — mark an ask as principal-critical (mt#1916)
   *
   * Transitions the ask back to "routed" state with escalation semantics.
   * Full escalation metadata (priority bump, visibility flag) is tracked
   * in mt#1528; this endpoint provides the operator affordance now.
   */
  app.post("/api/asks/:id/escalate", async (req, res) => {
    const askId = req.params.id;
    if (!askId) {
      res.status(400).json({ error: "Ask ID required" });
      return;
    }
    try {
      const repo = askRepoOverride ?? (await getServerAskRepository());
      if (!repo) {
        res.status(503).json({ error: "Ask repository unavailable" });
        return;
      }
      const ask = await repo.transition(askId, "routed");
      res.json({ ok: true, id: ask.id, state: ask.state, escalated: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        res.status(404).json({ error: message });
      } else if (message.includes("Invalid transition")) {
        res.status(409).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  /**
   * POST /api/asks/:id/resolve — mark an Ask as resolved (mt#1147)
   *
   * Body: { responder: "operator", payload: unknown, attentionCost?: {...} }
   *
   * Uses the AskRepository.respondAndClose() atomic operation to transition
   * the Ask from "suspended" to "closed" in a single write.
   *
   * Returns 200 on success, 400 if askId is missing, 403 if Ask is not
   * operator-routed (algedonic selection — see mt#1147 PR #1125 R1), 404 if
   * Ask not found, 409 on concurrent transition, 500 on unexpected errors,
   * 503 if the Ask repository is unavailable.
   */
  app.post("/api/asks/:id/resolve", async (req, res) => {
    const askId = req.params.id;
    if (!askId) {
      res.status(400).json({ error: "Ask ID required" });
      return;
    }

    try {
      const repo = askRepoOverride ?? (await getServerAskRepository());
      if (!repo) {
        res.status(503).json({
          error: "Ask repository unavailable — persistence provider does not support SQL",
        });
        return;
      }

      // Algedonic selection (mt#1147): only operator-routed asks may be resolved
      // via this endpoint. Asks resolved by policy / peers / reviewer subagents
      // must not be short-circuited through the operator's resolution surface.
      // PR #1125 R1 BLOCKING finding.
      const existing = await repo.getById(askId);
      if (!existing) {
        res.status(404).json({ error: `Ask ${askId} not found` });
        return;
      }
      if (existing.routingTarget !== "operator") {
        res.status(403).json({
          error: `Ask ${askId} is not operator-routed (routingTarget=${existing.routingTarget}); refusing to resolve`,
        });
        return;
      }

      const body = req.body as {
        responder?: string;
        payload?: unknown;
        attentionCost?: unknown;
      };

      const responsePayload = {
        responder: (body.responder ?? "operator") as "operator",
        payload: (body.payload ?? {}) as Record<string, unknown>,
        attentionCost: body.attentionCost as
          | import("@minsky/domain/ask/types").AttentionCost
          | undefined,
      };

      const ask = await repo.respondAndClose(
        askId,
        { response: responsePayload },
        { response: responsePayload }
      );

      res.json({ ok: true, id: ask.id, state: ask.state });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        res.status(404).json({ error: message });
      } else if (
        message.includes("Concurrent transition") ||
        message.includes("ConcurrentTransitionError")
      ) {
        res.status(409).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Credential endpoints (mt#1426) — cockpit surface for the credential lifecycle.
  //
  // Trust-boundary policy:
  //   - The token value is consumed in-process only. It MUST NOT appear in any
  //     response body, error message, or log line (across all four endpoints).
  //   - Body reads are guarded with try/catch; `req.body.token` may not be a string.
  //   - 400 on unknown provider or missing/invalid token; 200 on success.
  // ---------------------------------------------------------------------------

  // Normalized error response helper (mt#1426 PR #1142 R1).
  //
  // Returns errors as `{ error: { code, message } }` with stable user-safe
  // `code` values and user-safe `message` strings. Raw exception text is
  // logged server-side via `log.error` but NEVER returned to the client —
  // closes the "raw err.message coupled to UI" reviewer finding.
  //
  // Stable codes:
  //   - `invalid_body`        — request body shape unparseable
  //   - `missing_field`       — required field absent or wrong type
  //   - `unknown_provider`    — provider id not in registry
  //   - `validation_failed`   — provider.validate(token) returned !ok
  //                             (response also carries the structured
  //                             `validate: { ok, detail, unauthorized?, scopeGap? }`
  //                             so the UI can render specific failure states)
  //   - `internal`            — unexpected exception (raw message NOT returned)
  type CredentialErrorCode =
    | "invalid_body"
    | "missing_field"
    | "unknown_provider"
    | "validation_failed"
    | "internal";

  function credentialError(
    res: express.Response,
    status: number,
    code: CredentialErrorCode,
    message: string,
    extras?: Record<string, unknown>
  ): void {
    res.status(status).json({ error: { code, message }, ...(extras ?? {}) });
  }

  function logCredentialInternal(route: string, err: unknown): void {
    // Internal errors are logged server-side for operator debugging, but the
    // user-facing response carries only `{ code: "internal", message: "..." }` —
    // never the raw exception text. Keeps internal details out of the UI per
    // PR #1142 R1.
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log.error(`[credentials] ${route} — internal error: ${detail}`);
  }

  /**
   * GET /api/credentials/providers
   *
   * Returns: { providers: { id, displayName, acquireUrl, scopeGuidance }[] }
   * One entry per registered credential provider.
   */
  app.get("/api/credentials/providers", async (_req, res) => {
    try {
      const credMod = credModuleOverride ?? (await import("@minsky/domain/credentials"));
      const providers = [...credMod.listCredentialProviders()].map((p) => ({
        id: p.id,
        displayName: p.displayName,
        acquireUrl: p.acquireUrl,
        scopeGuidance: p.scopeGuidance,
      }));
      res.json({ providers });
    } catch (err) {
      logCredentialInternal("GET /api/credentials/providers", err);
      credentialError(
        res,
        500,
        "internal",
        "An internal error occurred while listing credential providers."
      );
    }
  });

  /**
   * POST /api/credentials/validate
   *
   * Body: { provider: string; token: string }
   * Returns: { ok: boolean; detail: string; unauthorized?: boolean; scopeGap?: boolean }
   *
   * Calls provider.validate(token) — read-only, never persists.
   * The token is consumed in memory and never echoed back.
   * Errors: `{ error: { code, message } }` with codes above.
   */
  app.post("/api/credentials/validate", async (req, res) => {
    let provider: string | undefined;
    let token: string | undefined;
    try {
      const body = req.body as { provider?: unknown; token?: unknown };
      provider = typeof body.provider === "string" ? body.provider : undefined;
      token = typeof body.token === "string" ? body.token : undefined;
    } catch {
      credentialError(res, 400, "invalid_body", "Request body could not be parsed.");
      return;
    }

    if (!provider) {
      credentialError(res, 400, "missing_field", "`provider` is required.");
      return;
    }
    if (!token) {
      credentialError(res, 400, "missing_field", "`token` is required.");
      return;
    }

    try {
      const credMod = credModuleOverride ?? (await import("@minsky/domain/credentials"));
      const credentialProvider = credMod.getCredentialProvider(provider);
      if (!credentialProvider) {
        credentialError(res, 400, "unknown_provider", `Unknown credential provider: ${provider}.`);
        return;
      }
      const result = await credentialProvider.validate(token);
      res.json({
        ok: result.ok,
        detail: result.detail,
        ...(result.unauthorized !== undefined ? { unauthorized: result.unauthorized } : {}),
        ...(result.scopeGap !== undefined ? { scopeGap: result.scopeGap } : {}),
      });
    } catch (err) {
      logCredentialInternal("POST /api/credentials/validate", err);
      credentialError(res, 500, "internal", "An internal error occurred during validation.");
    }
  });

  /**
   * POST /api/credentials/add
   *
   * Body: { provider: string; token: string }
   * Returns: { provider, validate, stored?, test? } — never includes the token.
   *
   * Calls addCredential(provider, token). Returns 400 with code "validation_failed"
   * and the structured `validate` result when the provider rejects the token.
   */
  app.post("/api/credentials/add", async (req, res) => {
    let provider: string | undefined;
    let token: string | undefined;
    try {
      const body = req.body as { provider?: unknown; token?: unknown };
      provider = typeof body.provider === "string" ? body.provider : undefined;
      token = typeof body.token === "string" ? body.token : undefined;
    } catch {
      credentialError(res, 400, "invalid_body", "Request body could not be parsed.");
      return;
    }

    if (!provider) {
      credentialError(res, 400, "missing_field", "`provider` is required.");
      return;
    }
    if (!token) {
      credentialError(res, 400, "missing_field", "`token` is required.");
      return;
    }

    try {
      const credMod = credModuleOverride ?? (await import("@minsky/domain/credentials"));
      const credentialProvider = credMod.getCredentialProvider(provider);
      if (!credentialProvider) {
        credentialError(res, 400, "unknown_provider", `Unknown credential provider: ${provider}.`);
        return;
      }
      const result = await credMod.addCredential(provider, token);
      if (!result.validate.ok) {
        // Preserve the structured validate result so the UI can render
        // specific states (unauthorized / scopeGap) without parsing text.
        credentialError(
          res,
          400,
          "validation_failed",
          "Credential validation failed. See `validate` for details.",
          { validate: result.validate }
        );
        return;
      }
      res.json(result);
    } catch (err) {
      logCredentialInternal("POST /api/credentials/add", err);
      credentialError(
        res,
        500,
        "internal",
        "An internal error occurred while adding the credential."
      );
    }
  });

  /**
   * GET /api/credentials
   *
   * Returns: { credentials: CredentialListing[] }
   * One entry per known provider — never includes token values.
   */
  app.get("/api/credentials", async (_req, res) => {
    try {
      const credMod = credModuleOverride ?? (await import("@minsky/domain/credentials"));
      const credentials = await credMod.listCredentials();
      res.json({ credentials });
    } catch (err) {
      logCredentialInternal("GET /api/credentials", err);
      credentialError(
        res,
        500,
        "internal",
        "An internal error occurred while listing credentials."
      );
    }
  });

  /**
   * DELETE /api/credentials/:provider
   *
   * Returns: { removed: boolean }
   * 400 with code "unknown_provider" on unknown provider; 200 on success.
   */
  app.delete("/api/credentials/:provider", async (req, res) => {
    const providerId = req.params.provider;
    if (!providerId) {
      credentialError(res, 400, "missing_field", "`provider` is required.");
      return;
    }

    try {
      const credMod = credModuleOverride ?? (await import("@minsky/domain/credentials"));
      const credentialProvider = credMod.getCredentialProvider(providerId);
      if (!credentialProvider) {
        credentialError(
          res,
          400,
          "unknown_provider",
          `Unknown credential provider: ${providerId}.`
        );
        return;
      }
      const result = await credMod.removeCredential(providerId);
      res.json(result);
    } catch (err) {
      logCredentialInternal("DELETE /api/credentials/:provider", err);
      credentialError(
        res,
        500,
        "internal",
        "An internal error occurred while removing the credential."
      );
    }
  });

  /**
   * GET /api/cockpit/context-inspector/snapshot — fetch full SessionContextSnapshot
   * for a given agent session (mt#2023).
   *
   * Query params:
   *   ?sessionId=<agent_session_id>   — required; the harness-native session UUID.
   *
   * Response: SessionContextSnapshot JSON (categorized chronological block list)
   *   or 404 when the session is unknown to the substrate.
   *
   * The widget framework's single-payload shape doesn't fit the interactive
   * picker → detail pattern, so this endpoint lives as a sibling to the
   * `context-inspector` widget (which returns the picker source). The widget
   * + this endpoint together compose the "Context" tab.
   *
   * @see mt#2023 — this endpoint
   * @see mt#2022 — `assembleSessionContextSnapshot` from the foundation
   * @see mt#2033 — canonical SessionContextSnapshot shape
   */
  // Stable user-safe error codes for the snapshot endpoint (PR #1230 R1 BLOCKING).
  // Mirrors the credential-endpoint sanitization discipline: raw `err.message`
  // values are logged server-side via `log.error` but NEVER returned to the
  // client.
  type ContextInspectorErrorCode =
    | "missing_field"
    | "unsupported_provider"
    | "session_not_found"
    | "internal";

  function contextInspectorError(
    res: express.Response,
    status: number,
    code: ContextInspectorErrorCode,
    message: string
  ): void {
    res.status(status).json({ error: { code, message } });
  }

  function logContextInspectorInternal(route: string, err: unknown): void {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log.error(`[context-inspector] ${route} — internal error: ${detail}`);
  }

  app.get("/api/cockpit/context-inspector/snapshot", async (req, res) => {
    const sessionId = req.query["sessionId"];
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      contextInspectorError(res, 400, "missing_field", "`sessionId` is required.");
      return;
    }

    try {
      // Lazy-cached SQL DB connection — mirrors the agents.ts singleton
      // pattern. Avoids constructing a fresh `PersistenceService` (and
      // re-initializing the provider) on every request. PR #1230 R1
      // non-blocking finding.
      const db = await getContextInspectorDb();
      if (db === null) {
        contextInspectorError(
          res,
          503,
          "unsupported_provider",
          "Context inspector requires a SQL persistence provider."
        );
        return;
      }

      const { assembleSessionContextSnapshot } = await import(
        "@minsky/domain/transcripts/session-context-snapshot"
      );
      const snapshot = await assembleSessionContextSnapshot(db, sessionId as AgentSessionId);

      if (snapshot === null) {
        contextInspectorError(
          res,
          404,
          "session_not_found",
          "No transcript found for the requested session."
        );
        return;
      }

      res.json(snapshot);
    } catch (err) {
      logContextInspectorInternal("GET /api/cockpit/context-inspector/snapshot", err);
      contextInspectorError(
        res,
        500,
        "internal",
        "An internal error occurred while assembling the snapshot."
      );
    }
  });

  // --- Embeddings infrastructure API (mt#2151) ---

  app.get("/api/embeddings/overview", async (_req, res) => {
    try {
      const db = await getContextInspectorDb();
      if (db === null) {
        const { EmbeddingsHealthTracker } = await import(
          "@minsky/domain/ai/embeddings-health-tracker"
        );
        res.json({
          health: EmbeddingsHealthTracker.getInstance().getSummary(),
          consumers: [],
        });
        return;
      }
      const { getEmbeddingsOverview } = await import("./embeddings-api");
      const overview = await getEmbeddingsOverview(db);
      res.json(overview);
    } catch (err) {
      log.error("[embeddings] GET /api/embeddings/overview error", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "Failed to fetch embeddings overview" });
    }
  });

  app.get("/api/embeddings/errors", async (req, res) => {
    try {
      const db = await getContextInspectorDb();
      if (db === null) {
        res.json({ errors: [] });
        return;
      }
      const parsed = parseInt(String(req.query["limit"] ?? "50"), 10);
      const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
      const { getEmbeddingsErrors } = await import("./embeddings-api");
      const errors = await getEmbeddingsErrors(db, limit);
      res.json({ errors });
    } catch (err) {
      log.error("[embeddings] GET /api/embeddings/errors error", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "Failed to fetch embeddings errors" });
    }
  });

  app.post("/api/embeddings/reindex/:consumer", async (req, res) => {
    try {
      const { consumer } = req.params;
      const { REINDEX_COMMANDS } = await import("./embeddings-api");
      const cmd = REINDEX_COMMANDS[consumer];
      if (!cmd) {
        res.status(400).json({
          error: `Unknown or non-reindexable consumer: ${consumer}`,
          available: Object.keys(REINDEX_COMMANDS),
        });
        return;
      }

      const cliEntry = path.join(process.cwd(), "src", "cli.ts");
      if (!fs.existsSync(cliEntry)) {
        res.status(503).json({
          error: "Reindex unavailable: source tree not found at expected location",
        });
        return;
      }

      const { spawn: spawnChild, execFileSync } = await import("child_process");
      try {
        execFileSync("bun", ["--version"], { timeout: 5000, stdio: "ignore" });
      } catch {
        res.status(503).json({ error: "Reindex unavailable: bun runtime not found" });
        return;
      }

      const args = cmd.split(" ");
      const child = spawnChild("bun", [cliEntry, ...args], {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
      });

      await new Promise<void>((resolve, reject) => {
        child.on("spawn", () => resolve());
        child.on("error", (err) => reject(err));
      });
      child.unref();

      res.json({ success: true, message: `Reindex started for ${consumer}` });
    } catch (err) {
      log.error("[embeddings] POST /api/embeddings/reindex error", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "Failed to start reindex" });
    }
  });

  // --- Static SPA assets ---

  if (!opts.dev) {
    /** GET /assets/* — served from web/dist/assets */
    if (fs.existsSync(path.join(WEB_DIST_DIR, "assets"))) {
      app.use("/assets", express.static(path.join(WEB_DIST_DIR, "assets")));
    }

    /**
     * SPA fallback — serve index.html for any GET that didn't match an API
     * or asset route. Required because React Router uses the History API:
     * a hard refresh on /agents would otherwise 404 at the server.
     */
    app.get("*", (_req, res) => {
      if (fs.existsSync(INDEX_HTML)) {
        res.sendFile(INDEX_HTML);
      } else {
        res.status(404).json({
          error: "Cockpit bundle not built",
          hint: "Run `bun run cockpit:build` first",
        });
      }
    });
  }

  return app;
}
