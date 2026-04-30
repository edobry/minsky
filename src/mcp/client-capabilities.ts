/**
 * Client capability registry for the active MCP connection.
 *
 * The MCP server records each connected client's advertised capabilities
 * (per `clientCapabilities` in the initialization handshake — MCP spec
 * 2025-06-18 §Client capabilities). The Ask router consults this registry
 * to decide whether sync ask kinds should dispatch via `elicitation/create`
 * or fall back to the static kind→transport binding matrix.
 *
 * v1 surfaces only `hasElicitation()`. Future capabilities (notifications,
 * resources, sampling) extend the interface as routing decisions begin to
 * depend on them.
 *
 * The interface is the seam that mt#1457 (elicitation transport) consumes
 * to extend mt#1069's `pickTransport` with capability-aware routing. This
 * task ships the interface and a no-op default; mt#1457 ships the real
 * MCP-backed implementation and overrides the registration in the MCP
 * composition root.
 *
 * Reference:
 *   - docs/architecture/adr-008-attention-allocation-subsystem.md §Router
 *   - mt#1316 §Decisions — multi-host ambition; routing must work against
 *     any host's advertised capabilities, not just Claude Code.
 */

/**
 * Registry of capabilities advertised by the active MCP client connection.
 *
 * Implementations:
 *   - `NoopClientCapabilityRegistry` — default; always returns false.
 *     Used in CLI composition (no MCP host attached) and tests.
 *   - `MCPClientCapabilityRegistry` — lands in mt#1457 (elicitation
 *     transport); reads `clientCapabilities.elicitation` from the active
 *     MCP connection's initialization handshake.
 */
export interface ClientCapabilityRegistry {
  /**
   * Returns true when the active MCP connection advertises the
   * `elicitation` capability in its `clientCapabilities` object.
   *
   * Returns false when:
   *   - No MCP connection is active (CLI execution, tests).
   *   - The connected client did not advertise elicitation.
   *   - The registry is the no-op fake.
   *
   * The Ask router (mt#1069's `pickTransport`, extended by mt#1457)
   * uses this to choose between `elicitation` and the kind-based
   * transport fallback for sync ask kinds.
   */
  hasElicitation(): boolean;
}

/**
 * No-op `ClientCapabilityRegistry` implementation.
 *
 * Always returns `false` from every capability check. This causes the
 * router to fall back to the static kind→transport binding matrix, which
 * is the v1 baseline behavior shipped by mt#1069.
 *
 * Used as:
 *   - The default registration in CLI composition (`src/composition/cli.ts`).
 *   - The test fake in unit tests where no MCP server is present.
 *
 * Replaced at the MCP composition root by `MCPClientCapabilityRegistry`
 * (mt#1457) when running under the MCP server.
 */
export class NoopClientCapabilityRegistry implements ClientCapabilityRegistry {
  hasElicitation(): boolean {
    return false;
  }
}
