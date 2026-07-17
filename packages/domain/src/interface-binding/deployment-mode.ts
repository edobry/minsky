/**
 * Deployment-mode gate for the iTerm-tab correlator (mt#1628).
 *
 * The correlator shells out to `osascript` to enumerate iTerm2's live
 * session-id set. That is only meaningful (and only possible) when:
 *
 * 1. This process is running as LOCAL Minsky, not the hosted HTTP server.
 *    Reuses the existing hosted/local discriminator (`isHostedMode()`,
 *    `packages/domain/src/configuration/guard.ts`) rather than inventing a
 *    second mechanism — that flag is already the source of truth for
 *    "is this an operator's local machine or the hosted service," set once
 *    at MCP-server boot (`--http` flips it true; local/stdio launches never
 *    call `setHostedMode`, so it stays `false`).
 * 2. The local machine is macOS (`darwin`) — iTerm2 itself is macOS-only, so
 *    even a local (non-hosted) Minsky running on Linux/Windows has nothing
 *    to correlate against.
 *
 * Both conditions are cheap, synchronous, side-effect-free checks — no
 * `osascript` or other subprocess is spawned to determine support. This
 * matters for the "hosted-Minsky sessions report `surface_kind: unbound`
 * without errors (the iTerm correlator skips gracefully)" acceptance test:
 * the gate below is checked BEFORE any `osascript` invocation, so a hosted
 * or non-darwin caller never shells out at all.
 */
import { isHostedMode } from "../configuration/guard";

/**
 * Whether this process can run the iTerm-tab correlator: local (non-hosted)
 * Minsky on macOS. `platformOverride` exists purely for tests — production
 * callers never pass it (defaults to the real `process.platform`).
 */
export function isLocalItermCorrelationSupported(platformOverride?: string): boolean {
  const platform = platformOverride ?? process.platform;
  if (platform !== "darwin") return false;
  if (isHostedMode()) return false;
  return true;
}
