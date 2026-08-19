/**
 * Cockpit daemon configuration (mt#3641).
 *
 * Backs the operator-configured extra Host name(s) the daemon's Host-header
 * allowlist accepts, beyond the standard loopback aliases and the `--host`
 * bind value (see `buildAllowedHosts` in `src/cockpit/auth.ts`).
 *
 * ## Why this exists
 *
 * `tailscale serve` forwards the client's tailnet MagicDNS hostname
 * (`<node>.<tailnet>.ts.net`) as the `Host` header to the local backend.
 * Tailscale's documented best practice is to keep that backend bound to
 * loopback and put Serve in front of it — which means the daemon's
 * Host-header allowlist (a DNS-rebinding defense, mt#2538) needs an
 * explicit ADDITION for that one name, never a bypass (mt#3641 criterion 1
 * — any other Host still 403s).
 *
 * There is deliberately no standalone cockpit config file: mt#2294 (DONE)
 * removed `~/.config/minsky/cockpit.json`. This section lives in the same
 * declarative configuration tree every other subsystem already uses
 * (`ai`, `persistence`, `mcp`, `reviewer`, `principalChannel`), satisfying
 * mt#3641 criterion 2 (declarative config, not a CLI flag) by EXTENDING an
 * existing pattern rather than introducing a new one.
 *
 * `strictObject` so a typo in this section fails loud at load time instead
 * of silently doing nothing.
 */
import { z } from "zod";

export const cockpitConfigSchema = z
  .strictObject({
    /**
     * Additional Host-header names the daemon accepts on top of the
     * standard loopback aliases and the `--host` bind value — e.g. a
     * Tailscale MagicDNS name (`my-node.tail1234.ts.net`). Purely
     * ADDITIVE: any Host not in this list (and not a loopback alias or the
     * bind value) still 403s. Override via `MINSKY_COCKPIT_ALLOWED_HOSTS`
     * (comma-separated; see `sources/environment.ts`).
     *
     * Once a name is here, the daemon is reachable off-box BY
     * CONSTRUCTION — see `cookieBootstrapMiddleware` in
     * `src/cockpit/auth.ts`, which withholds the plain-HTTP cookie
     * bootstrap for a request whose Host matches one of these names
     * regardless of the bind address. That is the mt#3641 re-derivation of
     * the mt#2538 R1 `isLoopbackBind` gate: bind address stopped being a
     * valid proxy for "only local processes can reach me" the moment this
     * list can carry a tailnet name while the bind stays loopback.
     */
    allowedHosts: z.array(z.string().min(1)).default([]),

    /**
     * TCP port the cockpit daemon serves on, and the port the tray supervises
     * (mt#3988). Override via `MINSKY_COCKPIT_PORT`; `cockpit start --port`
     * still wins over both.
     *
     * This exists to give the daemon and its supervisor ONE source of truth.
     * Before it, `cockpit-tray/src-tauri/src/supervisor.rs` hardcoded
     * `DAEMON_PORT = 3737` and `menu.rs` hardcoded the URL and a second port
     * constant for the same-origin check — so a daemon started on any other
     * port was invisible to the tray: not adopted, not controlled by
     * Start/Stop/Restart, and liable to have a SECOND daemon spawned beside it
     * on 3737. That happened on 2026-06-04 (a manual daemon on :4317 plus a
     * tray-spawned one on :3737, with the browser reading the stale one).
     *
     * The tray does not re-implement this resolution: it shells out to
     * `minsky config get cockpit.port` once at startup, so precedence is
     * decided here and in one place only.
     */
    port: z.number().int().min(1).max(65535).default(3737),

    /**
     * Settings for driven sessions — the genuine `claude` processes the
     * cockpit spawns (`src/cockpit/driven-session-host.ts`), including every
     * session a Telegram message starts through the principal channel.
     */
    drivenSession: z
      .strictObject({
        /**
         * Which MCP servers a driven session is provisioned with (mt#4239).
         *
         * Names are resolved against the operator's `.mcp.json` and copied
         * verbatim into the `--mcp-config` payload. `minsky` is always
         * present and is always SYNTHESIZED rather than inherited — it must
         * point at the running build and at the session's own repo path, which
         * no file on disk knows.
         *
         * **Local command servers only.** A name resolving to a REMOTE entry
         * (a `url` rather than a `command`) is refused with a log line, because
         * a headless `claude -p` child cannot complete an OAuth flow — verified
         * live against `claude` 2.1.226, and vendor-documented at
         * code.claude.com/docs/en/mcp ("In non-interactive mode there's no
         * `/mcp` panel, so Claude Code can't run the OAuth flow for you").
         * Shipping one anyway would cost up to `MCP_TIMEOUT` (30s default) of
         * first-turn latency per spawn and still deliver no tools.
         *
         * Default is deliberately narrow. `supabase` is resolvable but NOT a
         * default: driven sessions run under `bypassPermissions` and can be
         * triggered from a phone with nobody watching, and that server carries
         * `execute_sql` / `apply_migration` against the production project.
         * Adding it is an explicit operator decision, not an inherited one.
         */
        mcpServers: z.array(z.string().min(1)).default(["minsky", "github"]),
      })
      .optional(),
  })
  .optional();

export type CockpitConfig = z.infer<typeof cockpitConfigSchema>;
