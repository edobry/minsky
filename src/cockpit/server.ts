/**
 * Cockpit Express server factory (mt#1144)
 *
 * Creates an Express app serving:
 *   GET /api/health           — health + version + uptime
 *   GET /api/widgets          — enabled widget metadata list
 *   GET /api/widget/:id/data  — fetch a single widget's data
 *   GET /api/events           — SSE stream of Postgres NOTIFY events (mt#1853)
 *   POST /api/asks/:id/resolve — mark an Ask as resolved (mt#1147)
 *   GET /assets/*             — static files from web/dist/assets
 *   GET /                     — serves web/dist/index.html
 */
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { loadCockpitConfig } from "./config";
import { WIDGET_REGISTRY } from "./widget-registry";
import type { WidgetRegistry } from "./widget-registry";
import { setLoadedWidgetCount } from "./widgets/basic-health";
import type { WidgetModule, CockpitConfig } from "./types";
import { SseBroker } from "./sse-broker";
import type { SseClient, SseEvent } from "./sse-broker";
import {
  PostgresChannelListener,
  createNoopChannelListener,
} from "../domain/mesh/postgres-channel-listener";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the built SPA assets */
const WEB_DIST_DIR = path.join(__dirname, "web", "dist");
const INDEX_HTML = path.join(WEB_DIST_DIR, "index.html");

/** Options accepted by createCockpitServer */
export interface CockpitServerOptions {
  /** Override the cockpit.json config (used in tests) */
  overrideConfig?: CockpitConfig;
  /** Additional widgets to register alongside builtins (used in tests) */
  overrideRegistry?: WidgetRegistry;
  /**
   * Override the AskRepository used by the resolve endpoint (used in tests).
   * When absent, the server lazily initialises a DrizzleAskRepository from
   * the default PersistenceService (same pattern as attention.ts).
   */
  overrideAskRepository?: import("../domain/ask/repository").AskRepository;
  /**
   * Override the SseBroker used by the /api/events endpoint (used in tests).
   * When absent, the server lazily initialises a real broker backed by a
   * PostgresChannelListener from the default PersistenceService.
   */
  overrideSseBroker?: SseBroker;
}

const serverStartTime = Date.now();

/**
 * Build and return an Express app serving the cockpit shell.
 *
 * Call `app.listen(port)` on the returned app to start the server.
 */
// ---------------------------------------------------------------------------
// AskRepository lazy init — shared across requests (same singleton pattern
// as agents.ts defaultProviderFactory).
// ---------------------------------------------------------------------------

let _cachedServerAskRepo: import("../domain/ask/repository").AskRepository | null = null;

async function getServerAskRepository(): Promise<
  import("../domain/ask/repository").AskRepository | null
> {
  if (_cachedServerAskRepo) return _cachedServerAskRepo;
  try {
    const { PersistenceService } = await import("../domain/persistence/service");
    const { DrizzleAskRepository } = await import("../domain/ask/repository");
    const svc = new PersistenceService();
    await svc.initialize();
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
// Attention-window channel names — must match notify.ts emit side
// ---------------------------------------------------------------------------

const CHANNEL_ATTENTION_OPENED = "minsky.attention_window_opened";
const CHANNEL_ATTENTION_CLOSED = "minsky.attention_window_closed";

/**
 * Canonical list of all Postgres NOTIFY channels this cockpit-server process
 * pre-subscribes to at broker init time.
 *
 * IMPORTANT: postgres-js `sql.listen()` does NOT support wildcard channel
 * names. Clients may subscribe with patterns like `attention.*`, but the
 * broker must enumerate and pre-subscribe concrete channel names here. When
 * mt#1854 adds new channels, add them to this list so they are active before
 * any client connects.
 */
export const COCKPIT_SSE_CHANNELS: readonly string[] = [
  CHANNEL_ATTENTION_OPENED,
  CHANNEL_ATTENTION_CLOSED,
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
 * When the persistence provider is not Postgres (e.g. SQLite, offline mode),
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
    const { PersistenceService } = await import("../domain/persistence/service");
    const svc = new PersistenceService();
    await svc.initialize();
    const provider = svc.getProvider();

    // Require getListenCapableSqlConnection — only the Postgres provider has it
    if (
      !("getListenCapableSqlConnection" in provider) ||
      typeof (provider as { getListenCapableSqlConnection?: unknown })
        .getListenCapableSqlConnection !== "function"
    ) {
      // Non-Postgres provider (SQLite, offline) — use a no-op listener so the
      // broker exists but the stream is open-but-silent. The /api/events
      // endpoint returns 200 (not 503) and streams no events. This is correct
      // for non-Postgres backends: clients connect successfully but never
      // receive events because there is no Postgres NOTIFY source wired.
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

    // Pre-subscribe to ALL canonical channels at init time.
    // postgres-js does not support wildcard channel names — each channel must
    // be explicitly subscribed. Clients may connect with patterns like
    // `attention.*` but the broker must have already called sql.listen() on
    // the matching concrete channels for those events to arrive.
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
  // Resolve effective config and registry
  const config = opts.overrideConfig ?? loadCockpitConfig();
  const effectiveRegistry: WidgetRegistry = {
    ...WIDGET_REGISTRY,
    ...(opts.overrideRegistry ?? {}),
  };

  // AskRepository override for tests
  const askRepoOverride = opts.overrideAskRepository ?? null;

  // SseBroker override for tests
  const sseBrokerOverride = opts.overrideSseBroker ?? null;

  // Build the enabled widget set
  const enabledWidgets = new Map<string, WidgetModule>();
  for (const entry of config.widgets) {
    if (!entry.enabled) continue;
    const widget = effectiveRegistry[entry.id];
    if (widget) {
      enabledWidgets.set(entry.id, widget);
    }
  }

  // Inform basic-health of the loaded widget count
  setLoadedWidgetCount(enabledWidgets.size);

  const app = express();
  app.use(express.json());

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
    res.json({ status: "ok", version, uptimeSec });
  });

  /** GET /api/widgets */
  app.get("/api/widgets", (_req, res) => {
    const widgets = Array.from(enabledWidgets.values()).map((w) => ({
      id: w.id,
      title: w.title,
      updateMode: w.updateMode,
    }));
    res.json(widgets);
  });

  /** GET /api/widget/:id/data */
  app.get("/api/widget/:id/data", async (req, res) => {
    const widget = enabledWidgets.get(req.params.id);
    if (!widget) {
      res.status(404).json({ error: "Widget not found" });
      return;
    }
    try {
      const data = await widget.fetch({ id: req.params.id });
      res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ state: "degraded", reason: `Widget crashed: ${message}` });
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
          | import("../domain/ask/types").AttentionCost
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

  // --- Static SPA assets ---

  /** GET /assets/* — served from web/dist/assets */
  if (fs.existsSync(path.join(WEB_DIST_DIR, "assets"))) {
    app.use("/assets", express.static(path.join(WEB_DIST_DIR, "assets")));
  }

  /** GET / — serve index.html or 404 gracefully if bundle not built */
  app.get("/", (_req, res) => {
    if (fs.existsSync(INDEX_HTML)) {
      res.sendFile(INDEX_HTML);
    } else {
      res.status(404).json({
        error: "Cockpit bundle not built",
        hint: "Run `bun run cockpit:build` first",
      });
    }
  });

  return app;
}
