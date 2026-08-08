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
 *   GET /api/sweeps           — per-sweep liveness registry (mt#2894)
 *   GET /api/widgets          — metadata for every registered widget
 *   GET /api/widget/:id/data  — fetch a single widget's data (registry-gated;
 *                               404 only for ids absent from WIDGET_REGISTRY)
 *   GET /api/events           — SSE stream of Postgres NOTIFY events (mt#1853)
 *   GET /api/agents/:id       — workspace-session detail: meta, commits, PR
 *                               state, transcript bridge (mt#1919)
 *   POST /api/agents/:id/focus — resolve + raise the session's externally
 *                               attached terminal (mt#2284 + mt#2285, local-
 *                               only, mt#2286)
 *   GET /api/conversation/:agentSessionId/live-tail — conversation-keyed live
 *                               tail SSE stream, no workspace bridge (mt#2749)
 *   GET /api/asks             — list pending operator-routed asks (mt#1916)
 *   POST /api/asks/:id/resolve — mark an Ask as resolved (mt#1147)
 *   GET /api/engprod/proposals — EngProd toil-miner proposal digest: filed
 *                               proposal tasks + recent miner runs (mt#3331)
 *   POST /api/engprod/proposals/:taskId/accept — accept a proposal (unblock +
 *                               ledger verdict=accepted, atomically, mt#3331)
 *   POST /api/engprod/proposals/:taskId/reject — reject a proposal (close +
 *                               ledger verdict=rejected+reason, atomically, mt#3331)
 *   POST /api/driven-session  — spawn a driven session (genuine `claude`
 *                               child, local daemon only, mt#2750)
 *   POST /api/driven-session/:id/stop — graceful stop of a driven session
 *   GET /api/driven-session   — list app-started driven sessions
 *   ANY  /api/*                — 404 JSON for any unmatched /api route (mt#3111;
 *                               registered after every route module above, so it
 *                               only fires when nothing else matched — never the SPA)
 *   GET /assets/*             — static files from web/dist/assets
 *   GET /                     — serves web/dist/index.html
 *
 * @see ./routes/health.ts, ./routes/tasks.ts, ./routes/agents.ts,
 *   ./routes/agent-focus.ts, ./routes/conversations.ts, ./routes/changesets.ts,
 *   ./routes/events.ts, ./routes/activity.ts, ./routes/asks.ts,
 *   ./routes/credentials.ts, ./routes/context-inspector.ts,
 *   ./routes/embeddings.ts, ./routes/driven-sessions.ts — the per-domain
 *   route modules
 * @see ./driven-session-host.ts, ./driven-session-ws.ts — Rung 2A
 *   driven-session spawn/registry logic + its WS channel (mt#2750; the WS
 *   channel is attached separately by
 *   src/commands/cockpit/start-command.ts — see that file's docblock)
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
import { mountAgentFocusRoutes } from "./routes/agent-focus";
import type { AgentFocusRouteOptions } from "./routes/agent-focus";
import { mountConversationRoutes } from "./routes/conversations";
import type { ConversationRoutesOptions } from "./routes/conversations";
import { mountConversationSearchRoutes } from "./routes/conversation-search";
import type { ConversationSearchRouteOptions } from "./routes/conversation-search";
import { mountChangesetRoutes } from "./routes/changesets";
import { mountProjectRoutes, type ProjectRoutesOptions } from "./routes/projects";
import { mountEventsRoutes } from "./routes/events";
import { mountActivityRoutes } from "./routes/activity";
import { mountAskRoutes } from "./routes/asks";
import { mountEngprodProposalRoutes } from "./routes/engprod-proposals";
import { mountCredentialRoutes } from "./routes/credentials";
import { mountContextInspectorRoutes } from "./routes/context-inspector";
import { mountSessionFilmRoutes } from "./routes/session-film";
import { mountEmbeddingsRoutes } from "./routes/embeddings";
import { mountSweepRoutes } from "./routes/sweeps";
import { mountFollowUpRoutes } from "./routes/follow-ups";
import { mountDrivenSessionRoutes } from "./routes/driven-sessions";
import { mountEntityThreadRoutes } from "./routes/entity-threads";
import { mountConversationRunStateRoutes } from "./routes/conversation-run-state";
import { mountConversationPresenceRoutes } from "./routes/conversation-presence";
import type { ConversationPresenceRoutesOptions } from "./routes/conversation-presence";
import type { DrivenSessionRoutesOptions } from "./routes/driven-sessions";
import {
  buildAllowedHosts,
  buildOffBoxHostSet,
  cookieBootstrapMiddleware,
  getOrCreateCockpitToken,
  hostAllowlistMiddleware,
  isLoopbackHost,
  mutationAuthMiddleware,
} from "./auth";
import { cspMiddleware } from "./csp";
import { getConfiguration } from "@minsky/domain/configuration/index";
import { log } from "@minsky/shared/logger";

export type { CredentialModuleOverride } from "./routes/credentials";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the built SPA assets — bundle-aware (cwd + module-dir walk, mt#2283). */
const WEB_DIST_DIR = cockpitWebDistDir(__dirname);
const INDEX_HTML = cockpitIndexHtml(__dirname);

/**
 * Accepted JSON request-body ceiling (mt#3539). Sits above the run-state
 * writer hook's own 64kb body bound (`MAX_BODY_CHARS` in
 * `.minsky/hooks/record-conversation-run-state.ts`) with headroom for the
 * other POST routes, and is stated here rather than inherited from
 * body-parser's 100kb default. See the `express.json` callsite below.
 */
export const JSON_BODY_LIMIT = "256kb";

/**
 * Resolve the operator-configured extra Host-header allowlist entries
 * (mt#3641). `override` (test-only, `CockpitServerOptions.extraAllowedHosts`)
 * takes precedence; otherwise reads `cockpit.allowedHosts` from Minsky
 * configuration. An unavailable/unparseable config degrades to no extra
 * hosts — the same restrictive default the daemon had before this option
 * existed — mirroring the fail-open posture `principal-channel-launch.ts`'s
 * `readPrincipalChannelSection` takes for a missing/broken config: the
 * daemon must still boot.
 */
export function resolveExtraAllowedHosts(override?: readonly string[]): string[] {
  if (override) return [...override];
  try {
    return [...(getConfiguration().cockpit?.allowedHosts ?? [])];
  } catch (err) {
    log.warn("[cockpit] could not read cockpit.allowedHosts config; no extra hosts allowed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

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
   * Test-only override for the operator-configured extra Host-header
   * allowlist entries (mt#3641). When absent (production), these are read
   * from `cockpit.allowedHosts` config (`MINSKY_COCKPIT_ALLOWED_HOSTS`) —
   * see `resolveExtraAllowedHosts` below. Passing this directly lets tests
   * exercise the tailnet-Host allowlist addition and the off-box cookie gate
   * without writing a real config file. Never set in production.
   */
  extraAllowedHosts?: readonly string[];
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
  /**
   * Test-only injection seams for the Rung 2A driven-session routes
   * (mt#2750) — overrides the registry/spawnFn/command
   * `POST /api/driven-session` uses, so tests exercise the full
   * spawn/registry/lifecycle path against an injected FAKE process instead
   * of the real `claude` binary. See ./routes/driven-sessions.ts and
   * ./driven-session-host.ts. Never set in production.
   */
  overrideDrivenSession?: DrivenSessionRoutesOptions;
  /**
   * Test seam for the /api/projects route's database resolution (mt#3254).
   * Without it a test process reaches the production resolution path, which
   * the live-database guard refuses.
   */
  overrideProjectRoutes?: ProjectRoutesOptions;
  /**
   * Test-only injection seams for the Agents-view "go to" focus endpoint
   * (mt#2286) — overrides the SQL-connection getter and the mt#2285 focus
   * executor so tests exercise the full attachment-resolution + delegation
   * path against injected fakes instead of a real DB and a real terminal
   * focus action. See ./routes/agent-focus.ts. Never set in production.
   */
  overrideAgentFocus?: AgentFocusRouteOptions;
  /**
   * Test-only injection seam for the conversation search endpoint (mt#2523)
   * — overrides the SQL-connection getter so tests can force a deterministic
   * db-unavailable (503) or db-available response instead of depending on
   * whatever `getContextInspectorDb()`'s module-level singleton happens to
   * resolve to in-process (mt#3016). Never set in production. See
   * ./routes/conversation-search.ts.
   */
  overrideConversationSearch?: ConversationSearchRouteOptions;
  /**
   * Test-only injection seam for the conversation-presence endpoint (mt#3201)
   * — overrides the run-state / open-ask / workspace-id readers so tests
   * exercise the real HTTP contract against plain injected values rather than
   * mocking drizzle's query builder or depending on whatever connection
   * happens to exist in-process (the mt#3016 lesson). Never set in
   * production. See ./routes/conversation-presence.ts.
   */
  overrideConversationPresence?: ConversationPresenceRoutesOptions;
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
  // Operator-configured extra Host name(s) — e.g. a Tailscale MagicDNS name
  // (mt#3641) — layered onto the allowlist ADDITIVELY (never a wildcard/bypass;
  // see buildAllowedHosts's docblock). Resolved once here so both the
  // allowlist and the off-box cookie gate below agree on the same list.
  const extraAllowedHosts = resolveExtraAllowedHosts(opts.extraAllowedHosts);
  const allowedHosts = buildAllowedHosts(opts.host, extraAllowedHosts);
  // Loopback bind unless `--host` opted into a routable address. Gates the
  // plain-HTTP cookie bootstrap (mt#2538 R1): non-loopback binds require an
  // explicit Authorization header rather than a Secure-less cookie.
  const isLoopbackBind = !opts.host || isLoopbackHost(opts.host);

  if (localAuthEnabled) {
    // Host-header allowlist (DNS-rebinding defense) — runs first, before any
    // handler that would otherwise trust `req.headers.host`.
    app.use(hostAllowlistMiddleware(allowedHosts));
  }

  /**
   * Body limit stated DELIBERATELY rather than inherited (mt#3539).
   *
   * body-parser's default is 100kb. Nothing chose it, and nothing surfaced
   * what it rejected: the run-state writer hook forwarded harness payloads
   * whole, so every `PostToolUse` carrying a large `tool_response` was
   * rejected 413 and dropped by a hook that treats any failure as
   * "daemon down". The hook now bounds its body (MAX_BODY_CHARS, 64kb);
   * this ceiling sits comfortably above that so a bounded body always fits,
   * while still refusing a genuinely unbounded one rather than buffering it.
   */
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Content-Security-Policy on every GET/HEAD response (harmless on JSON API
  // responses; only has effect on the SPA's rendered HTML). See ./csp.ts.
  app.use(cspMiddleware(!!opts.dev));

  if (localAuthEnabled && cockpitToken) {
    // Cookie bootstrap: mints the `minsky_cockpit` cookie on the first GET so
    // the SPA's same-origin mutation fetches work without any URL/localStorage
    // token plumbing. Also accepts `?token=<t>` as an explicit bootstrap for a
    // future non-loopback opt-in consumer. See ./auth.ts. `buildOffBoxHostSet`
    // (mt#3641) withholds the cookie for a request whose Host matches one of
    // the operator-configured extra hosts, regardless of `isLoopbackBind` —
    // once a tailnet name is allowlisted the daemon is reachable off-box by
    // construction, even while bound to loopback (Tailscale's own recommended
    // posture, see this file's docblock).
    app.use(
      cookieBootstrapMiddleware(cockpitToken, isLoopbackBind, buildOffBoxHostSet(extraAllowedHosts))
    );

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
  mountAgentFocusRoutes(app, opts.overrideAgentFocus ?? {});
  mountConversationRoutes(app, opts.overrideConversationLiveTail ?? {});
  mountConversationSearchRoutes(app, opts.overrideConversationSearch ?? {});
  mountChangesetRoutes(app);
  mountProjectRoutes(app, opts.overrideProjectRoutes ?? {}); // mt#2418 — GET /api/projects (shell project selector)
  mountEventsRoutes(app, { sseBrokerOverride });
  mountActivityRoutes(app);
  mountAskRoutes(app, { askRepoOverride });
  mountEngprodProposalRoutes(app); // mt#3331 — EngProd toil-miner proposal digest
  mountCredentialRoutes(app, { credModuleOverride });
  mountContextInspectorRoutes(app);
  mountSessionFilmRoutes(app); // mt#3184 — GET /api/cockpit/session-film/{events,sessions}
  mountConversationRunStateRoutes(app);
  mountConversationPresenceRoutes(app, opts.overrideConversationPresence ?? {});
  mountEmbeddingsRoutes(app);
  mountSweepRoutes(app); // mt#2894 — GET /api/sweeps (per-sweep liveness registry)
  mountFollowUpRoutes(app); // mt#2322 — GET/POST /api/follow-ups (scheduled-follow-up primitive)

  // Rung 2A driven-session routes (mt#2750) — LOCAL DAEMON ONLY. Spawning a
  // genuine `claude` binary with the operator's own credentials has no
  // meaning on the Railway-deployed public entrypoint (isPublicDeployment) —
  // see ./routes/driven-sessions.ts's docblock.
  if (!opts.isPublicDeployment) {
    mountDrivenSessionRoutes(app, opts.overrideDrivenSession ?? {});
    // mt#3364 — entity discussion threads spawn the same genuine `claude`
    // binary as the driven sessions above, so they carry the same
    // local-daemon-only constraint and share this guard.
    mountEntityThreadRoutes(app);
  }

  /**
   * A GET (or any other method) to an unmatched /api/* path must 404 as JSON
   * — NOT fall through to the SPA. Mirrors the /assets guard below (mt#2674):
   * without this, a mistyped or renamed API path returns index.html
   * (text/html, HTTP 200), which reads to a client doing `await res.json()`
   * as a transport/serialization bug instead of a routing bug (mt#3111).
   * Registered unconditionally (not inside the `!opts.dev` block below) so it
   * also covers dev mode: `--dev` attaches Vite's own SPA-fallback middleware
   * OUTSIDE this factory (see start-command.ts), after every route this
   * function registers — so this guard must run here, before that, to
   * intercept an unmatched /api/* request in both modes.
   */
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

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
     * GET /fonts/* — served from web/dist/fonts.
     *
     * The self-hosted design-system webfonts (mt#3111) are vendored under
     * web/public/fonts/, and Vite copies its publicDir to the ROOT of outDir
     * — so they build to web/dist/fonts/, NOT under web/dist/assets/. Without
     * this mount the SPA fallback below would answer
     * /fonts/geist-latin.woff2 with index.html at HTTP 200, the browser would
     * reject the text/html body as a font, and every page would silently fall
     * back to system fonts — exactly the defect this task set out to fix, and
     * the same failure shape mt#2674 fixed for content-hashed chunks.
     */
    if (fs.existsSync(path.join(webDistDir, "fonts"))) {
      app.use("/fonts", express.static(path.join(webDistDir, "fonts")));
    }

    /**
     * A missing /fonts file must 404 — NOT fall through to the SPA fallback,
     * for the MIME-type reason above. Registered unconditionally so the 404
     * holds even when the fonts dir itself is absent (an unbuilt or partial
     * bundle), rather than degrading to a 200 text/html.
     */
    app.use("/fonts", (_req, res) => {
      res.status(404).json({ error: "Font not found" });
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
