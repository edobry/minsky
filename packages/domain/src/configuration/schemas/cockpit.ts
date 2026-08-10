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
  })
  .optional();

export type CockpitConfig = z.infer<typeof cockpitConfigSchema>;
