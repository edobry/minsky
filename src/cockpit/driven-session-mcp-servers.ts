/**
 * Which MCP servers driven sessions are provisioned with (mt#4239).
 *
 * ## Why this is its own module
 *
 * `driven-session-host.ts` and `driven-session-mcp-config.ts` both hold a
 * no-domain-imports invariant: they must build spawn argv without pulling the
 * DI container, the configuration system, or persistence into a module whose
 * whole job is to shape a command line. Reading `cockpit.drivenSession` is a
 * domain read, so it cannot live in either of them.
 *
 * This module is the seam. It sits in the cockpit layer, which already imports
 * domain freely, and hands the resulting names DOWN to the host as plain data.
 *
 * @see ./driven-session-mcp-config.ts — the resolver that consumes these names
 * @see packages/domain/src/configuration/schemas/cockpit.ts — the schema
 */

import { log } from "@minsky/shared/logger";
import { getConfiguration } from "@minsky/domain/configuration/index";
import { DEFAULT_DRIVEN_SESSION_MCP_SERVERS } from "./driven-session-mcp-config";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

/**
 * The configured server names, or the default set.
 *
 * Never throws. A configuration system that cannot be read must not stop a
 * driven session from spawning — the same posture `startPrincipalChannel` takes
 * for a missing credential, and for the same reason: the cockpit daemon has to
 * boot and answer the principal even when a config read is broken. Falling back
 * costs the operator some tools; propagating costs them the whole channel.
 *
 * An explicitly EMPTY array is honored rather than treated as absent — it is
 * the only way to say "provision `minsky` and nothing else", which is exactly
 * the pre-mt#4239 behavior and a legitimate thing to want back.
 */
export function drivenSessionMcpServerNames(): readonly string[] {
  try {
    const configured = getConfiguration().cockpit?.drivenSession?.mcpServers;
    if (Array.isArray(configured)) return configured;
  } catch (err: unknown) {
    log.warn(
      "[driven-session] could not read cockpit.drivenSession.mcpServers; using the default set",
      { error: getLoggableErrorSummary(err) }
    );
  }
  return DEFAULT_DRIVEN_SESSION_MCP_SERVERS;
}
