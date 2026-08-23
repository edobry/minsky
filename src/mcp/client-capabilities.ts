/**
 * Client capability registry — MCP-server-backed implementation.
 *
 * Domain-side types (ClientCapabilityRegistry, NoopClientCapabilityRegistry,
 * ElicitationCapableServer, etc.) live in packages/domain/src/client-capabilities.ts.
 * This file re-exports them for backward compatibility and adds the two
 * MCP-SDK-backed classes that depend on the `Server` class:
 * `SingleConnectionCapabilityRegistry` (caller-scoped, the one the ask router
 * consumes) and `MCPConnectionTracker` (fleet-wide, diagnostics only).
 *
 * @see mt#2133 — types moved to domain package to fix Docker path resolution
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

// Re-export all domain-side types and the no-op implementation
export type {
  ElicitInputParams,
  ElicitInputOptions,
  ElicitInputResult,
  ElicitationCapableServer,
  ClientCapabilityRegistry,
} from "@minsky/domain/client-capabilities";
export { NoopClientCapabilityRegistry } from "@minsky/domain/client-capabilities";

// Import types needed by MCPClientCapabilityRegistry
import type {
  ClientCapabilityRegistry,
  ElicitationCapableServer,
} from "@minsky/domain/client-capabilities";

// ---------------------------------------------------------------------------
// MCP-SDK-backed implementations (mt#4451: caller-scoped vs fleet-wide)
// ---------------------------------------------------------------------------

/**
 * Connection TRACKER for the MCP server. **Not** a `ClientCapabilityRegistry`.
 *
 * Tracks the live `Server` instances so the process can answer questions ABOUT
 * THE FLEET (how many connections, is anyone elicitation-capable). It
 * deliberately does NOT implement `ClientCapabilityRegistry` — under ADR-038's
 * shared daemon every conversation registers into this one process, so a
 * fleet-wide answer is the wrong answer for a specific caller's ask. The
 * caller-scoped implementation is `SingleConnectionCapabilityRegistry` below;
 * `src/mcp/server.ts` builds one per CallTool request from the connection that
 * actually made the call.
 *
 * mt#4451: this class used to implement the interface, and its two query
 * methods carried the interface's names. That is how one connected client came
 * to decide routing for asks filed by every other — `hasElicitation()` returned
 * true if ANY connection advertised it, and `activeElicitationServer()` returned
 * the FIRST match in `Set` iteration order rather than the caller's. The methods
 * below are renamed rather than deleted because the fleet-wide question is still
 * a legitimate thing to ask (diagnostics, tests); the names now say so, so a
 * future caller cannot reach for them expecting caller scope.
 *
 * Lifecycle: created once in `createStartCommand` and handed to
 * `MinskyMCPServer` for per-connection register/unregister. It is deliberately
 * NOT registered in the DI container under `clientCapabilityRegistry` — see
 * that registration's comment in `packages/domain/src/composition/domain.ts`.
 */
export class MCPConnectionTracker {
  private servers: Set<Server> = new Set();

  get registeredCount(): number {
    return this.servers.size;
  }

  registerServer(server: Server): void {
    this.servers.add(server);
  }

  unregisterServer(server: Server): void {
    this.servers.delete(server);
  }

  /**
   * True when AT LEAST ONE registered connection advertises elicitation.
   *
   * Fleet-wide by design. Never use this to decide how a particular ask routes
   * — that is `SingleConnectionCapabilityRegistry`.
   */
  anyConnectionHasElicitation(): boolean {
    for (const server of this.servers) {
      const caps = server.getClientCapabilities();
      if (caps?.elicitation) return true;
    }
    return false;
  }
}

/**
 * Caller-scoped `ClientCapabilityRegistry` over exactly ONE connection.
 *
 * This is the implementation the ask router should see: it answers for the
 * connection that filed the ask and for no other. There is no iteration, so
 * there is no iteration order to accidentally depend on, and a second connected
 * client cannot change the answer.
 *
 * Capabilities are read live from the SDK `Server` on every call rather than
 * captured at construction — the SDK populates `getClientCapabilities()` during
 * `initialize`, and this object may be built before that completes.
 */
export class SingleConnectionCapabilityRegistry implements ClientCapabilityRegistry {
  constructor(private readonly server: Server) {}

  hasElicitation(): boolean {
    return Boolean(this.server.getClientCapabilities()?.elicitation);
  }

  activeElicitationServer(): ElicitationCapableServer | null {
    return this.hasElicitation() ? (this.server as ElicitationCapableServer) : null;
  }
}
