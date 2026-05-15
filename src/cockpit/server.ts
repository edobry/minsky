/**
 * Cockpit Express server factory (mt#1144)
 *
 * Creates an Express app serving:
 *   GET /api/health           — health + version + uptime
 *   GET /api/widgets          — enabled widget metadata list
 *   GET /api/widget/:id/data  — fetch a single widget's data
 *   POST /api/asks/:id/resolve — mark an Ask as resolved (mt#1147)
 *   GET /assets/*             — static files from web/dist/assets
 *   GET /                     — serves web/dist/index.html
 */
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadCockpitConfig } from "./config";
import { WIDGET_REGISTRY } from "./widget-registry";
import type { WidgetRegistry } from "./widget-registry";
import { setLoadedWidgetCount } from "./widgets/basic-health";
import type { WidgetModule, CockpitConfig } from "./types";

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

export function createCockpitServer(opts: CockpitServerOptions = {}): express.Express {
  // Resolve effective config and registry
  const config = opts.overrideConfig ?? loadCockpitConfig();
  const effectiveRegistry: WidgetRegistry = {
    ...WIDGET_REGISTRY,
    ...(opts.overrideRegistry ?? {}),
  };

  // AskRepository override for tests
  const askRepoOverride = opts.overrideAskRepository ?? null;

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
   * POST /api/asks/:id/resolve — mark an Ask as resolved (mt#1147)
   *
   * Body: { responder: "operator", payload: unknown, attentionCost?: {...} }
   *
   * Uses the AskRepository.respondAndClose() atomic operation to transition
   * the Ask from "suspended" to "closed" in a single write.
   *
   * Returns 200 on success, 403 if Ask is not operator-routed (algedonic
   * selection — see mt#1147 PR #1125 R1), 404 if Ask not found, 409 on
   * concurrent transition, 503 if the Ask repository is unavailable.
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
