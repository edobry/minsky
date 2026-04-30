/**
 * Client capability registry for the active MCP connection.
 *
 * The MCP server records each connected client's advertised capabilities
 * (per `clientCapabilities` in the initialization handshake — MCP spec
 * 2025-06-18 §Client capabilities). The Ask router consults this registry
 * to decide whether sync ask kinds should dispatch via `elicitation/create`
 * or fall back to the static kind→transport binding matrix.
 *
 * v1 surfaces `hasElicitation()` (the routing-decision input) and
 * `activeElicitationServer()` (the dispatch handle). Future capabilities
 * (notifications, resources, sampling) extend the interface as routing
 * decisions begin to depend on them.
 *
 * Reference:
 *   - docs/architecture/adr-008-attention-allocation-subsystem.md §Router
 *   - mt#1316 §Decisions — multi-host ambition; routing must work against
 *     any host's advertised capabilities, not just Claude Code.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

// ---------------------------------------------------------------------------
// ElicitationCapableServer — structural type the elicitation transport needs
// ---------------------------------------------------------------------------

/**
 * Form-mode parameters for `elicitation/create`. v1 uses form mode only;
 * URL mode is a future extension (mt#1331 / Shape C).
 *
 * Matches the MCP SDK's `ElicitRequestFormParams` shape — the live `Server`
 * implementation satisfies this structurally. Defining it here lets the
 * elicitation transport and tests depend on a narrow contract instead of
 * the full SDK surface.
 */
export interface ElicitInputParams {
  /** Human-readable prompt shown by the host to the user. */
  message: string;
  /** JSON Schema for the response shape (form mode: flat object, primitive properties). */
  requestedSchema: Record<string, unknown>;
}

/** Options accepted by `elicitInput`. v1 uses only `timeout`. */
export interface ElicitInputOptions {
  /** Per-elicitation timeout in milliseconds. */
  timeout?: number;
}

/** Result returned by `elicitInput`. Matches the SDK's `ElicitResult`. */
export interface ElicitInputResult {
  /**
   * The user's choice on the elicitation. `accept` carries the structured
   * `content` payload; `decline` and `cancel` do not.
   */
  action: "accept" | "decline" | "cancel";
  /** Present when `action === "accept"`. Shape conforms to `requestedSchema`. */
  content?: Record<string, unknown>;
}

/**
 * Structural subset of the MCP SDK `Server` that the elicitation transport
 * needs. The real `Server` from `@modelcontextprotocol/sdk` implements this;
 * tests can pass a fake without pulling in the full SDK surface.
 */
export interface ElicitationCapableServer {
  elicitInput(params: ElicitInputParams, options?: ElicitInputOptions): Promise<ElicitInputResult>;
}

// ---------------------------------------------------------------------------
// ClientCapabilityRegistry interface
// ---------------------------------------------------------------------------

/**
 * Registry of capabilities advertised by the active MCP client connection.
 *
 * Implementations:
 *   - `NoopClientCapabilityRegistry` — default; always reports no elicitation
 *     and returns null from `activeElicitationServer`. Used in CLI composition
 *     (no MCP host attached) and tests.
 *   - `MCPClientCapabilityRegistry` — the MCP-server-backed registry. Tracks
 *     active `Server` instances; reads `clientCapabilities.elicitation` per
 *     instance via `Server.getClientCapabilities()`.
 */
export interface ClientCapabilityRegistry {
  /**
   * Returns true when at least one registered MCP connection advertises the
   * `elicitation` capability in its `clientCapabilities` object.
   *
   * Returns false when:
   *   - No MCP connection is active (CLI execution, tests with the no-op fake).
   *   - No connected client advertised elicitation.
   *   - The registry is the no-op fake.
   *
   * The Ask router (`pickTransport` in mt#1069's router, extended by mt#1457)
   * uses this to choose between `elicitation` and the kind-based transport
   * fallback for sync ask kinds.
   */
  hasElicitation(): boolean;

  /**
   * Returns the first registered MCP connection whose client advertises
   * `elicitation`, or null if none.
   *
   * The elicitation transport calls `elicitInput()` on this server to drive
   * the dialog. v1 scope: one client connection at a time; if multiple
   * connections advertise elicitation, the first registered wins.
   */
  activeElicitationServer(): ElicitationCapableServer | null;
}

// ---------------------------------------------------------------------------
// NoopClientCapabilityRegistry — default for CLI / tests
// ---------------------------------------------------------------------------

/**
 * No-op `ClientCapabilityRegistry` implementation.
 *
 * Always returns `false` from `hasElicitation` and `null` from
 * `activeElicitationServer`. This causes the router to fall back to the
 * static kind→transport binding matrix, which is the v1 baseline behavior
 * shipped by mt#1069.
 *
 * Used as:
 *   - The default registration in CLI composition (`src/composition/cli.ts`).
 *   - The test fake in unit tests where no MCP server is present.
 *
 * Replaced at the MCP composition root (`src/commands/mcp/start-command.ts`)
 * by `MCPClientCapabilityRegistry` when running under the MCP server.
 */
export class NoopClientCapabilityRegistry implements ClientCapabilityRegistry {
  hasElicitation(): boolean {
    return false;
  }

  activeElicitationServer(): ElicitationCapableServer | null {
    return null;
  }
}

// ---------------------------------------------------------------------------
// MCPClientCapabilityRegistry — real MCP-backed implementation (mt#1457)
// ---------------------------------------------------------------------------

/**
 * MCP-backed `ClientCapabilityRegistry`. Tracks active MCP `Server` instances
 * and exposes their advertised `clientCapabilities` to the Ask router and
 * elicitation transport.
 *
 * Lifecycle:
 *   - `MinskyMCPServer.createConfiguredServer` calls `registerServer(server)`
 *     immediately after constructing each `Server` instance.
 *   - Stdio mode: one `Server` for the process lifetime.
 *   - HTTP mode: one `Server` per session; the HTTP transport's onclose
 *     handler (and the idle-session reaper) calls `unregisterServer(server)`.
 *
 * Capability lookup is live: `hasElicitation()` calls
 * `server.getClientCapabilities()` on every check, so a connection that
 * completes its `initialize` handshake after registration is picked up
 * automatically without any additional bookkeeping. Before initialize,
 * `getClientCapabilities()` returns undefined and the registry reports no
 * elicitation — correct, because no client has yet declared capabilities.
 */
export class MCPClientCapabilityRegistry implements ClientCapabilityRegistry {
  private readonly servers: Server[] = [];

  /**
   * Add a server to the active set. Idempotent — re-registering the same
   * `Server` instance is a no-op so HTTP-mode reconnect/replay paths are
   * safe.
   */
  registerServer(server: Server): void {
    if (!this.servers.includes(server)) {
      this.servers.push(server);
    }
  }

  /**
   * Remove a server from the active set. Called from the HTTP transport's
   * onclose handler and the idle-session reaper. Safe to call with a server
   * that was never registered (no-op).
   */
  unregisterServer(server: Server): void {
    const idx = this.servers.indexOf(server);
    if (idx !== -1) {
      this.servers.splice(idx, 1);
    }
  }

  /** Number of currently-registered servers. Test seam. */
  get registeredCount(): number {
    return this.servers.length;
  }

  hasElicitation(): boolean {
    return this.servers.some((s) => Boolean(s.getClientCapabilities()?.elicitation));
  }

  activeElicitationServer(): ElicitationCapableServer | null {
    for (const server of this.servers) {
      if (server.getClientCapabilities()?.elicitation) {
        // The MCP SDK's `Server` class implements the `ElicitationCapableServer`
        // structural type (it has the `elicitInput` method with matching shape).
        // The cast is for the type system — the structural compatibility is
        // verified by the SDK's index.d.ts.
        return server as ElicitationCapableServer;
      }
    }
    return null;
  }
}
