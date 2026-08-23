/**
 * Cockpit port resolution (mt#3988).
 *
 * ## Why this exists
 *
 * The cockpit daemon and the tray that supervises it have to agree on one
 * number. Before this module, they did not share a source: three `cockpit`
 * subcommands each carried their own `--port` default of `3737`, and the tray
 * carried FOUR separate constants (`supervisor.rs`'s `DAEMON_PORT` and
 * `HEALTH_URL`, `menu.rs`'s `COCKPIT_URL` and `COCKPIT_PORT`). A daemon on any
 * other port was therefore invisible to the tray — not adopted, not driven by
 * Start/Stop/Restart, and liable to have a second daemon spawned beside it.
 * That is the 2026-06-04 incident (a manual daemon on `:4317` alongside a
 * tray-spawned one on `:3737`, browser reading the stale one), recorded in
 * mt#2427 and carried forward here.
 *
 * ## Precedence, decided in ONE place
 *
 *   `--port <n>` (explicit flag)  >  `cockpit.port` config  >  3737
 *
 * `cockpit.port` itself already absorbs `MINSKY_COCKPIT_PORT` through the
 * normal environment-mapping layer, so this module does not read env directly.
 *
 * The tray does not re-implement any of this: it shells out to
 * `minsky config get cockpit.port` once at startup and passes the answer back
 * as an explicit `--port` when it spawns the daemon. So the resolution lives
 * here, and the supervisor consumes it rather than mirroring it.
 */

import { getConfiguration } from "@minsky/domain/configuration/index";

/** The port used when neither a flag nor configuration supplies one. */
export const DEFAULT_COCKPIT_PORT = 3737;

/**
 * Resolve the cockpit port for a command invocation.
 *
 * `flagValue` is the raw `--port` string, or undefined when the operator did
 * not pass one. The commander-level default was REMOVED from the cockpit
 * subcommands precisely so that undefined means "not specified" here — with a
 * commander default in place, an explicit `--port 3737` and an unset flag are
 * indistinguishable, and configuration could never take effect.
 *
 * Consumers were `install` / `start` / `status` at mt#3988; `restart` and `stop`
 * joined at mt#4232, when they gained a `--port` at all. Both initially shipped
 * a hand-rolled `parseInt` default and were routed here in PR #3097 R1 — the
 * validation was the reviewer's finding, but the config precedence was the
 * larger bug underneath it: a configured `cockpit.port` would have been ignored,
 * so restart would have signalled nothing and reported the daemon absent.
 *
 * Throws on a malformed or out-of-range explicit flag rather than silently
 * falling back: an operator who typed a port meant it, and quietly serving a
 * different one is the class of surprise this whole module exists to remove.
 */
export function resolveCockpitPort(flagValue?: string): number {
  if (flagValue !== undefined) {
    const parsed = Number.parseInt(flagValue, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`Invalid port: ${flagValue}. Must be a number between 1 and 65535`);
    }
    return parsed;
  }
  return getConfiguration().cockpit?.port ?? DEFAULT_COCKPIT_PORT;
}

/** Help text for the shared `--port` flag, so all three commands describe it identically. */
export const COCKPIT_PORT_FLAG_DESCRIPTION =
  `Port to listen on (default: the \`cockpit.port\` configuration value, ` +
  `else ${DEFAULT_COCKPIT_PORT})`;
