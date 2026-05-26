/**
 * Cockpit Express server factory (mt#1144)
 *
 * Creates an Express app serving:
 *   GET /api/health           — health + version + uptime
 *   GET /api/widgets          — enabled widget metadata list
 *   GET /api/widget/:id/data  — fetch a single widget's data
 *   GET /api/events           — SSE stream of Postgres NOTIFY events (mt#1853)
 *   GET /api/asks             — list pending operator-routed asks (mt#1916)
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
} from "@minsky/domain/mesh/postgres-channel-listener";
import { log } from "@minsky/shared/logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the built SPA assets */
const WEB_DIST_DIR = path.join(__dirname, "web", "dist");
const INDEX_HTML = path.join(WEB_DIST_DIR, "index.html");

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
}

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

  // Credential module override for tests
  const credModuleOverride = opts.overrideCredentialModule ?? null;

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
   * GET /api/tasks — lightweight task list for the command palette (mt#1917).
   *
   * Returns: { tasks: { id, title, status }[] }
   * Uses the shared task service singleton (same bootstrap pattern as
   * workstreams.ts). Returns 503 when the task service is unavailable.
   */
  app.get("/api/tasks", async (_req, res) => {
    try {
      const taskService = await getServerTaskService();
      if (!taskService) {
        res.status(503).json({
          error: "Task service unavailable — persistence provider not ready",
        });
        return;
      }
      const { formatTaskIdForDisplay } = await import("@minsky/domain/tasks/task-id-utils");
      const tasks = await taskService.listTasks({});
      const taskList = tasks.slice(0, 500).map((t) => ({
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
   * Query params:
   *   - eventType: filter by event type (ask.created | task.auto_created | pr.review_posted | subagent.failed)
   *   - limit: max results (default 100, max 500)
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
      const eventType =
        typeof req.query["eventType"] === "string" ? req.query["eventType"] : undefined;
      const limitParam =
        typeof req.query["limit"] === "string" ? parseInt(req.query["limit"], 10) : 100;
      const limit = isNaN(limitParam) ? 100 : Math.min(Math.max(limitParam, 1), 500);

      const events = await listEvents(db, {
        eventType: eventType as
          | import("@minsky/domain/storage/schemas/system-events-schema").SystemEventType
          | undefined,
        limit,
      });

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
      const snapshot = await assembleSessionContextSnapshot(db, sessionId);

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

  // --- Static SPA assets ---

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

  return app;
}
