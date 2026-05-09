/**
 * Cockpit Express server factory (mt#1144)
 *
 * Creates an Express app serving:
 *   GET /api/health           — health + version + uptime
 *   GET /api/widgets          — enabled widget metadata list
 *   GET /api/widget/:id/data  — fetch a single widget's data
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
}

const serverStartTime = Date.now();

/**
 * Build and return an Express app serving the cockpit shell.
 *
 * Call `app.listen(port)` on the returned app to start the server.
 */
export function createCockpitServer(opts: CockpitServerOptions = {}): express.Express {
  // Resolve effective config and registry
  const config = opts.overrideConfig ?? loadCockpitConfig();
  const effectiveRegistry: WidgetRegistry = {
    ...WIDGET_REGISTRY,
    ...(opts.overrideRegistry ?? {}),
  };

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
    res.json({ status: "ok", version, uptime: uptimeSec });
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
