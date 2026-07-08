/**
 * Cockpit SSE broker + /api/events route (mt#2615 — extracted from
 * server.ts, mt#1853).
 *
 * Houses the shared SSE broker (one per cockpit-server process),
 * initialised as a background warmup right AFTER the server binds its port
 * via {@link initServerSseBroker} (mt#2699 — the init awaits the full
 * persistence/DB connect, ~5 s network-bound, and gating the bind on it was
 * the dominant share of the cockpit's cold-boot latency). The /api/events
 * route awaits the SAME cached init promise, so a client connecting during
 * warmup waits for channel subscriptions instead of missing them.
 */
import { randomUUID } from "crypto";
import type express from "express";
import { log } from "@minsky/shared/logger";
import { SseBroker } from "../sse-broker";
import type { SseClient, SseEvent } from "../sse-broker";
import {
  PostgresChannelListener,
  createNoopChannelListener,
} from "@minsky/domain/mesh/postgres-channel-listener";
import { getCachedPersistenceProvider } from "../db-providers";

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
 * In-flight init promise (mt#2699). Callers share ONE initialisation:
 * without this, the post-bind background warmup racing an early /api/events
 * client would each run a full init and the loser would leak a Postgres
 * LISTEN connection. A FAILED init (resolved null) clears the slot so the
 * next caller retries — preserving the pre-mt#2699 retry-on-failure
 * semantics.
 */
let _sseBrokerInitPromise: Promise<SseBroker | null> | null = null;

/**
 * Test-only provider-factory seam (mt#2699). Same convention as
 * shared-persistence.test.ts: no `mock.module` (it persists across bun:test
 * files and would poison other suites) — tests inject a factory here instead.
 * Null = use the real `getCachedPersistenceProvider`.
 */
let _providerFactoryOverride: (() => Promise<unknown>) | null = null;

/** Throw when a test-only seam is called outside bun:test (PR #1860 R1). */
function assertTestEnv(seam: string): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(`${seam} is test-only (NODE_ENV=${process.env.NODE_ENV ?? "unset"})`);
  }
}

/** Test-only: override the persistence-provider factory. Never call outside tests. */
export function __setSseBrokerProviderFactoryForTests(
  factory: (() => Promise<unknown>) | null
): void {
  assertTestEnv("__setSseBrokerProviderFactoryForTests");
  _providerFactoryOverride = factory;
}

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
 *
 * Concurrency (mt#2699): all callers share one in-flight init; a failed init
 * (null) is not cached, so later callers retry.
 */
function getServerSseBroker(): Promise<SseBroker | null> {
  if (_cachedSseBroker) return Promise.resolve(_cachedSseBroker);
  if (_sseBrokerInitPromise) return _sseBrokerInitPromise;
  _sseBrokerInitPromise = initSseBrokerOnce().then((broker) => {
    if (broker === null) {
      // Failed init: clear the slot so the next caller retries.
      _sseBrokerInitPromise = null;
    }
    return broker;
  });
  return _sseBrokerInitPromise;
}

async function initSseBrokerOnce(): Promise<SseBroker | null> {
  try {
    const provider = _providerFactoryOverride
      ? await _providerFactoryOverride()
      : await getCachedPersistenceProvider();

    // Require getListenCapableSqlConnection — only the Postgres provider has
    // it. Guard the `in` check with an object test first (R2 review): a
    // non-object provider would otherwise throw here and be misclassified as
    // "init failed" (503) by the outer catch, instead of degrading to the
    // documented no-op-listener fallback below.
    if (
      typeof provider !== "object" ||
      provider === null ||
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
 * Initialise the SSE broker (idempotent; all callers share one in-flight
 * init).
 *
 * Called by the cockpit server entry-point as a BACKGROUND warmup right
 * after the port binds (mt#2699 — it awaits the full persistence/DB init,
 * which dominated cold-boot latency when it gated the bind). The /api/events
 * route awaits the same cached promise, so a client connecting during the
 * warmup window waits for channel subscriptions rather than missing them.
 * Events firing before the LISTEN registrations complete are not captured —
 * identical in kind to the pre-bind window when the process wasn't up yet.
 */
export async function initServerSseBroker(): Promise<void> {
  await getServerSseBroker();
}

/**
 * Awaitable core of the post-bind warmup (mt#2699, hardened per PR #1860 R1):
 * attempt broker init up to `delaysMs.length` times, sleeping `delaysMs[i]`
 * before attempt i. Returns true once the broker is up. Failures are logged —
 * a silently-dropped warmup promise would leave "no SSE channels subscribed"
 * invisible until a client noticed missing events. Per-request lazy init in
 * /api/events remains the fallback after the schedule is exhausted (a failed
 * init is never cached, so every client connection retries).
 *
 * Exported for tests; production entry is {@link startSseBrokerWarmup}.
 */
export async function runSseBrokerWarmup(delaysMs: readonly number[]): Promise<boolean> {
  for (let attempt = 0; attempt < delaysMs.length; attempt++) {
    const delay = delaysMs[attempt] ?? 0;
    if (delay > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        // Don't hold the process open for a pending warmup retry.
        if (typeof timer.unref === "function") timer.unref();
      });
    }
    const broker = await getServerSseBroker();
    if (broker) {
      if (attempt > 0) {
        log.warn(`[cockpit] SSE broker warmup succeeded on attempt ${attempt + 1}`);
      }
      return true;
    }
    const next =
      attempt + 1 < delaysMs.length
        ? `retrying in ${delaysMs[attempt + 1] ?? 0}ms`
        : `giving up — /api/events will retry init per client connection`;
    log.warn(
      `[cockpit] SSE broker warmup attempt ${attempt + 1}/${delaysMs.length} failed (persistence init did not complete); ${next}`
    );
  }
  return false;
}

/** Warmup retry schedule: immediate, then backing off to ~1 min. */
const SSE_WARMUP_DELAYS_MS: readonly number[] = [0, 5_000, 15_000, 30_000, 60_000];

/**
 * Post-bind background SSE-broker warmup (mt#2699). Fire-and-forget wrapper
 * over {@link runSseBrokerWarmup} — the returned promise is intentionally
 * detached, but every outcome is logged inside the runner (PR #1860 R1: a
 * bare dropped promise had no failure signal at the process level).
 */
export function startSseBrokerWarmup(): void {
  void runSseBrokerWarmup(SSE_WARMUP_DELAYS_MS);
}

/**
 * Test-only: reset the module-level broker cache so init-concurrency and
 * retry semantics can be exercised across test cases. Never call outside
 * tests.
 */
export function __resetServerSseBrokerForTests(): void {
  assertTestEnv("__resetServerSseBrokerForTests");
  _cachedSseBroker = null;
  _sseBrokerInitPromise = null;
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

/** Options accepted by {@link mountEventsRoutes}. */
export interface EventsRoutesOptions {
  /** Override the SseBroker used by the endpoint (used in tests). */
  sseBrokerOverride: SseBroker | null;
}

/** Mount /api/events (SSE) on `app`. */
export function mountEventsRoutes(app: express.Express, opts: EventsRoutesOptions): void {
  const { sseBrokerOverride } = opts;

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
}
