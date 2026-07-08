/**
 * Cockpit Express server factory (mt#1144)
 *
 * Composition root only (mt#2615 — the server was split from a 2,638-line
 * monolith into per-domain route modules under `./routes/*`, `./db-providers.ts`,
 * and `./sweepers.ts`). This file wires the widget registry, the preview-mode
 * guard, every route module, and the static SPA fallback — it contains no
 * route-handler bodies of its own.
 *
 * Serves:
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
 *
 * @see ./routes/health.ts, ./routes/tasks.ts, ./routes/agents.ts,
 *   ./routes/changesets.ts, ./routes/events.ts, ./routes/activity.ts,
 *   ./routes/asks.ts, ./routes/credentials.ts, ./routes/context-inspector.ts,
 *   ./routes/embeddings.ts — the per-domain route modules
 * @see ./db-providers.ts — shared lazy-cached persistence getters
 * @see ./sweepers.ts — the periodic-sweeper factory + concrete sweepers
 */
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { cockpitWebDistDir, cockpitIndexHtml } from "./web-dist";
import { WIDGET_REGISTRY } from "./widget-registry";
import type { WidgetRegistry } from "./widget-registry";
import { setLoadedWidgetCount } from "./widgets/basic-health";
import type { WidgetModule } from "./types";
import { SseBroker } from "./sse-broker";
import type { AskRepository } from "@minsky/domain/ask/repository";
import type { CredentialModuleOverride } from "./routes/credentials";
import { mountHealthRoutes } from "./routes/health";
import { mountTaskRoutes } from "./routes/tasks";
import { mountAgentRoutes } from "./routes/agents";
import { mountChangesetRoutes } from "./routes/changesets";
import { mountEventsRoutes } from "./routes/events";
import { mountActivityRoutes } from "./routes/activity";
import { mountAskRoutes } from "./routes/asks";
import { mountCredentialRoutes } from "./routes/credentials";
import { mountContextInspectorRoutes } from "./routes/context-inspector";
import { mountEmbeddingsRoutes } from "./routes/embeddings";

export type { CredentialModuleOverride } from "./routes/credentials";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the built SPA assets — bundle-aware (cwd + module-dir walk, mt#2283). */
const WEB_DIST_DIR = cockpitWebDistDir(__dirname);
const INDEX_HTML = cockpitIndexHtml(__dirname);

/** Options accepted by createCockpitServer */
export interface CockpitServerOptions {
  /** Additional widgets to register alongside builtins (used in tests) */
  overrideRegistry?: WidgetRegistry;
  /**
   * Override the AskRepository used by the ask endpoints (used in tests).
   * When absent, the routes lazily initialise a DrizzleAskRepository from
   * the default PersistenceService (same pattern as attention.ts).
   */
  overrideAskRepository?: AskRepository;
  /**
   * Override the SseBroker used by the /api/events endpoint (used in tests).
   * When absent, the route lazily initialises a real broker backed by a
   * PostgresChannelListener from the default PersistenceService.
   */
  overrideSseBroker?: SseBroker;
  /**
   * Override the credential module used by the /api/credentials/* endpoints
   * (used in tests). When absent, the routes dynamically import the real
   * domain credentials module which writes to ~/.config/minsky/.
   */
  overrideCredentialModule?: CredentialModuleOverride;
  /** When true, skip static/SPA asset serving — Vite middleware handles it. */
  dev?: boolean;
  /**
   * Override the web-dist directory the static SPA is served from (used in
   * tests, so the /assets 404 and SPA-fallback contracts are testable without
   * a real `cockpit:build` output).
   */
  webDistDirOverride?: string;
}

/**
 * Build and return an Express app serving the cockpit shell.
 *
 * Call `app.listen(port)` on the returned app to start the server.
 */
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

  const askRepoOverride = opts.overrideAskRepository ?? null;
  const sseBrokerOverride = opts.overrideSseBroker ?? null;
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

  // --- API endpoints (per-domain route modules) ---
  //
  // Registration order across DIFFERENT domains does not matter here: no two
  // domains share an ambiguous path prefix (Express only needs registration
  // order to disambiguate routes that could otherwise match the SAME
  // request — e.g. a static path vs. a `:param` at the same position). Each
  // domain's OWN internal ordering constraints (e.g. `/api/tasks/ids` before
  // `/api/tasks/:id`) are preserved inside that domain's mount function.
  mountHealthRoutes(app, { serverDirname: __dirname, availableWidgets });
  mountTaskRoutes(app);
  mountAgentRoutes(app);
  mountChangesetRoutes(app);
  mountEventsRoutes(app, { sseBrokerOverride });
  mountActivityRoutes(app);
  mountAskRoutes(app, { askRepoOverride });
  mountCredentialRoutes(app, { credModuleOverride });
  mountContextInspectorRoutes(app);
  mountEmbeddingsRoutes(app);

  // --- Static SPA assets ---

  if (!opts.dev) {
    const webDistDir = opts.webDistDirOverride ?? WEB_DIST_DIR;
    const indexHtml = opts.webDistDirOverride
      ? path.join(opts.webDistDirOverride, "index.html")
      : INDEX_HTML;

    /** GET /assets/* — served from web/dist/assets */
    if (fs.existsSync(path.join(webDistDir, "assets"))) {
      app.use("/assets", express.static(path.join(webDistDir, "assets")));
    }

    /**
     * A missing /assets file must 404 — NOT fall through to the SPA fallback.
     * The tray rebuilds the SPA on every merge, replacing the content-hashed
     * chunk files a stale window still references; serving index.html
     * (text/html) for such a chunk request makes the dynamic import fail with
     * "'text/html' is not a valid JavaScript MIME type" (mt#2674). A hard 404
     * instead surfaces as a load error the client's vite:preloadError
     * recovery can act on.
     */
    app.use("/assets", (_req, res) => {
      res.status(404).json({ error: "Asset not found" });
    });

    /**
     * SPA fallback — serve index.html for any GET that didn't match an API
     * or asset route. Required because React Router uses the History API:
     * a hard refresh on /agents would otherwise 404 at the server. Must be
     * registered LAST — Express matches routes in registration order and a
     * bare `*` would otherwise swallow every unmatched GET immediately.
     * The entry document is served no-cache so a reload always reflects the
     * latest build's chunk hashes (per Vite's load-error-handling guidance).
     */
    app.get("*", (_req, res) => {
      if (fs.existsSync(indexHtml)) {
        res.setHeader("Cache-Control", "no-cache");
        res.sendFile(indexHtml);
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
