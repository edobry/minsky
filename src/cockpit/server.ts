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
 *   GET /api/conversation/:agentSessionId/live-tail — conversation-keyed live
 *                               tail SSE stream, no workspace bridge (mt#2749)
 *   GET /api/asks             — list pending operator-routed asks (mt#1916)
 *   POST /api/asks/:id/resolve — mark an Ask as resolved (mt#1147)
 *   GET /assets/*             — static files from web/dist/assets
 *   GET /                     — serves web/dist/index.html
 *
 * @see ./routes/health.ts, ./routes/tasks.ts, ./routes/agents.ts,
 *   ./routes/conversations.ts, ./routes/changesets.ts, ./routes/events.ts,
 *   ./routes/activity.ts, ./routes/asks.ts, ./routes/credentials.ts,
 *   ./routes/context-inspector.ts, ./routes/embeddings.ts — the per-domain
 *   route modules
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
import { mountConversationRoutes } from "./routes/conversations";
import type { ConversationRoutesOptions } from "./routes/conversations";
import { mountChangesetRoutes } from "./routes/changesets";
import { mountEventsRoutes } from "./routes/events";
import { mountActivityRoutes } from "./routes/activity";
import { mountAskRoutes } from "./routes/asks";
import { mountCredentialRoutes } from "./routes/credentials";
import { mountContextInspectorRoutes } from "./routes/context-inspector";
import { mountEmbeddingsRoutes } from "./routes/embeddings";
import {
  buildAllowedHosts,
  cookieBootstrapMiddleware,
  getOrCreateCockpitToken,
  hostAllowlistMiddleware,
  isLoopbackHost,
  mutationAuthMiddleware,
} from "./auth";
import { cspMiddleware } from "./csp";

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
  overrideWebDistDir?: string;
  /**
   * Override the bearer token used by the mutation-auth middleware (used in
   * tests, so a run doesn't read/write the real
   * `~/.local/state/minsky/cockpit-token` file). When absent, the real
   * per-machine token is read from disk (generating one on first boot).
   */
  overrideToken?: string;
  /**
   * The `--host` value the daemon is (or will be) bound to, if not the
   * loopback default. Added to the Host-header allowlist alongside the
   * standard loopback aliases (mt#2538) so an explicit non-loopback opt-in
   * doesn't get rejected by its own daemon.
   */
  host?: string;
  /**
   * Set ONLY by `services/cockpit/src/server.ts`, the Railway-deployed
   * entrypoint — a separate consumer of this shared factory that binds
   * `0.0.0.0` deliberately for the platform proxy and is reached via a
   * Railway-assigned public hostname that can never satisfy the
   * loopback-only Host-header allowlist below. The mt#2538 local-daemon
   * hardening spec explicitly rules that deployment out of scope. Setting
   * this to `true` skips the Host-header allowlist and the bearer-token /
   * cookie mutation-auth requirement entirely, preserving that deployment's
   * pre-mt#2538 behavior exactly (it also skips generating/reading the local
   * `~/.local/state/minsky/cockpit-token` file, which has no meaning for a
   * multi-instance container deployment). The CSP header and the
   * no-permissive-CORS policy still apply — both are purely additive
   * response-header behavior with no request-handling impact.
   */
  isPublicDeployment?: boolean;
  /**
   * Test-only injection seams for the conversation-keyed live-tail endpoint
   * (mt#2749) — overrides the fs/tailer/timing primitives its
   * `resolveJsonlPath`/`startLiveTail` calls use, so tests can exercise the
   * full SSE integration path against in-memory fakes instead of real disk
   * I/O and real timers. See `./routes/conversations.ts`.
   */
  overrideConversationLiveTail?: ConversationRoutesOptions;
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

  // --- Security hardening (mt#2538) ---
  //
  // Loopback bind (start-command.ts default host `127.0.0.1`) is NOT by
  // itself a sufficient auth posture: any local process of any user on the
  // machine can reach loopback, and DNS-rebinding can drive a victim
  // browser at localhost. Hence the token + Host-allowlist below, in
  // addition to the bind default.
  //
  // `isPublicDeployment` (set only by the Railway entrypoint) skips the
  // loopback-oriented Host-allowlist and mutation-auth below — see the
  // CockpitServerOptions doc comment for the full rationale. The CSP header
  // and no-CORS policy are additive/response-only, so they still apply.
  const localAuthEnabled = !opts.isPublicDeployment;
  const cockpitToken = localAuthEnabled ? (opts.overrideToken ?? getOrCreateCockpitToken()) : null;
  const allowedHosts = buildAllowedHosts(opts.host);
  // Loopback bind unless `--host` opted into a routable address. Gates the
  // plain-HTTP cookie bootstrap (mt#2538 R1): non-loopback binds require an
  // explicit Authorization header rather than a Secure-less cookie.
  const isLoopbackBind = !opts.host || isLoopbackHost(opts.host);

  if (localAuthEnabled) {
    // Host-header allowlist (DNS-rebinding defense) — runs first, before any
    // handler that would otherwise trust `req.headers.host`.
    app.use(hostAllowlistMiddleware(allowedHosts));
  }

  app.use(express.json());

  // Content-Security-Policy on every GET/HEAD response (harmless on JSON API
  // responses; only has effect on the SPA's rendered HTML). See ./csp.ts.
  app.use(cspMiddleware(!!opts.dev));

  if (localAuthEnabled && cockpitToken) {
    // Cookie bootstrap: mints the `minsky_cockpit` cookie on the first GET so
    // the SPA's same-origin mutation fetches work without any URL/localStorage
    // token plumbing. Also accepts `?token=<t>` as an explicit bootstrap for a
    // future non-loopback opt-in consumer. See ./auth.ts.
    app.use(cookieBootstrapMiddleware(cockpitToken, isLoopbackBind));

    // Mutation auth: every non-GET/HEAD/OPTIONS request needs the bearer
    // token (Authorization header) or the bootstrap cookie. Read-only
    // GET/SSE surfaces are exempt — loopback bind already covers the LAN
    // read surface, and plumbing the token to every GET consumer (tray Rust
    // health poll, dev canary, curl operators) is disproportionate at this
    // tier. The Rung 2A WS channel (mt#2750) will REQUIRE the token. See
    // ./auth.ts.
    app.use(mutationAuthMiddleware(cockpitToken));
  }

  // NO permissive CORS is set anywhere in this file — that absence IS the
  // policy (same-origin only). There is no `cors` middleware and no
  // `Access-Control-Allow-Origin` response header, so a cross-origin
  // `fetch()` from a browser fails the CORS preflight/response check before
  // it ever reaches a route handler. `mutationAuthMiddleware` above adds a
  // second, server-side Origin check for non-browser HTTP clients that set
  // `Origin` manually. See docs/architecture/cockpit.md "Bind, auth, and
  // CSP posture" for the full rationale.

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
  mountConversationRoutes(app, opts.overrideConversationLiveTail ?? {});
  mountChangesetRoutes(app);
  mountEventsRoutes(app, { sseBrokerOverride });
  mountActivityRoutes(app);
  mountAskRoutes(app, { askRepoOverride });
  mountCredentialRoutes(app, { credModuleOverride });
  mountContextInspectorRoutes(app);
  mountEmbeddingsRoutes(app);

  // --- Static SPA assets ---

  if (!opts.dev) {
    const webDistDir = opts.overrideWebDistDir ?? WEB_DIST_DIR;
    const indexHtml = opts.overrideWebDistDir
      ? path.join(opts.overrideWebDistDir, "index.html")
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
