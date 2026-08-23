/**
 * Client capability registry — domain-side types and no-op implementation.
 *
 * These types define the interface for checking MCP client capabilities
 * (e.g., elicitation). They live in the domain package because domain code
 * (ask router, composition types) depends on them. The MCP-server-backed
 * implementations stay in src/mcp/ since they depend on the MCP SDK's Server
 * class: `SingleConnectionCapabilityRegistry` (caller-scoped, what the router
 * actually consumes) and `MCPConnectionTracker` (fleet-wide, diagnostics only —
 * deliberately NOT an implementation of the interface below, per mt#4451).
 *
 * @see mt#2133 — moved here from src/mcp/client-capabilities.ts to fix
 *   Docker container path resolution (packages/domain/ couldn't reach
 *   ../../../../src/mcp/ in the container layout)
 */

export interface ElicitInputParams {
  message: string;
  requestedSchema: Record<string, unknown>;
}

export interface ElicitInputOptions {
  timeout?: number;
}

export interface ElicitInputResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export interface ElicitationCapableServer {
  elicitInput(params: ElicitInputParams, options?: ElicitInputOptions): Promise<ElicitInputResult>;
}

export interface ClientCapabilityRegistry {
  hasElicitation(): boolean;
  activeElicitationServer(): ElicitationCapableServer | null;
}

export class NoopClientCapabilityRegistry implements ClientCapabilityRegistry {
  hasElicitation(): boolean {
    return false;
  }

  activeElicitationServer(): ElicitationCapableServer | null {
    return null;
  }
}
