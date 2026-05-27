/**
 * Client capability registry — MCP-server-backed implementation.
 *
 * Domain-side types (ClientCapabilityRegistry, NoopClientCapabilityRegistry,
 * ElicitationCapableServer, etc.) live in packages/domain/src/client-capabilities.ts.
 * This file re-exports them for backward compatibility and adds the MCP-SDK-backed
 * MCPClientCapabilityRegistry that depends on the Server class.
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
// MCPClientCapabilityRegistry — the MCP-server-backed implementation
// ---------------------------------------------------------------------------

/**
 * MCP-server-backed `ClientCapabilityRegistry`.
 *
 * Tracks active `Server` instances registered via `registerServer()`.
 * `hasElicitation()` returns true when at least one registered server's
 * connected client advertises `elicitation` in its capabilities.
 *
 * Lifecycle: created once in `createStartCommand` and wired into both the
 * DI container (for Ask-router consumers) and the `MinskyMCPServer` (for
 * per-connection register/unregister calls).
 */
export class MCPClientCapabilityRegistry implements ClientCapabilityRegistry {
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

  hasElicitation(): boolean {
    for (const server of this.servers) {
      const caps = server.getClientCapabilities();
      if (caps?.elicitation) return true;
    }
    return false;
  }

  activeElicitationServer(): ElicitationCapableServer | null {
    for (const server of this.servers) {
      const caps = server.getClientCapabilities();
      if (caps?.elicitation) {
        return server as ElicitationCapableServer;
      }
    }
    return null;
  }
}
