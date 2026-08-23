/**
 * The MCP daemon's `GET /health` body, built in one place (mt#4322).
 *
 * ## Why this is a module rather than an object literal in the route
 *
 * mt#4322's SC3 asks for a golden contract on this response, following
 * `contract/cockpit-health-shape.json`'s pattern, so that removing or renaming
 * a field FAILS A TEST rather than surfacing as a downstream misread. The
 * cockpit's equivalent test asserts a LIVE server response, which it can afford
 * because the cockpit is an Express app a test can mount cheaply. Booting the
 * MCP server to read one route is not cheap — it resolves a DI container,
 * binds a port and installs shutdown handlers.
 *
 * Extracting the payload into a pure function is the alternative that keeps the
 * assertion honest: the test asserts the SAME function the route calls, so a
 * field renamed here fails the contract test, and a field renamed only in the
 * test fails nothing (which is correct — the fixture is the contract, not the
 * test's own copy of it). Per `testing-standards.mdc §Testable Design`, this is
 * the functional core / imperative shell split: the decision returns a value,
 * and the route does the I/O.
 *
 * @see contract/mcp-health-shape.json — the golden fixture this satisfies
 * @see src/mcp/health-payload.test.ts — the contract assertion
 */

import type { PersistenceHealthStatus } from "@minsky/domain/persistence/health";

/** The `service` identity every Minsky service emits (mt#3148). */
export const MCP_HEALTH_SERVICE = "minsky-mcp";

/**
 * The MCP daemon's `/health` response body.
 *
 * Field-by-field rationale lives in `contract/mcp-health-shape.json`; this type
 * is the compile-time half of the same contract.
 */
export interface McpHealthPayload {
  status: "ok" | "unhealthy";
  service: typeof MCP_HEALTH_SERVICE;
  server: string;
  /**
   * Always `"http"`, and typed as the literal rather than `string` (PR #3238 R1).
   *
   * This route only exists on the HTTP transport — a stdio process serves no
   * HTTP surface — so the value is correct by construction rather than derived
   * from mt#4322's transport resolution. The literal type is what makes that
   * invariant visible to the compiler instead of only to the fixture's
   * `$transportFieldNote`.
   */
  transport: "http";
  timestamp: string;
  persistence: { mode: PersistenceHealthStatus["mode"]; reason?: string };
  ready: boolean;
}

/** The response as the route will send it: a status code plus a body. */
export interface McpHealthResponse {
  statusCode: 200 | 503;
  body: McpHealthPayload;
}

/**
 * Build the `/health` response from an already-assessed persistence health.
 *
 * `nowIso` is injected rather than read from the clock so the payload is
 * assertable without freezing time.
 *
 * **The status code is deliberately NOT derived from `ready`** (mt#4297).
 * `unconfigured` is reported HEALTHY on purpose — it is the expected
 * local/dev/offline boot and the exact state `bundle-boot-smoke` asserts a 200
 * against — while `ready` is false there, because the daemon cannot serve
 * DB-backed work. Collapsing the two would either break that CI gate or
 * re-introduce the 31-hour outage `ready` was added to make visible.
 */
export function buildMcpHealthResponse(
  health: PersistenceHealthStatus,
  nowIso: string
): McpHealthResponse {
  return {
    statusCode: health.healthy ? 200 : 503,
    body: {
      status: health.healthy ? "ok" : "unhealthy",
      // mt#3148: `service` is the uniform, assertable identity key every
      // Minsky service emits. `server` is retained UNCHANGED alongside it —
      // mt#3142's own diagnosis read `server` to identify the wrong app on the
      // reviewer host, and mem#704's probe recipe still cites it. Renaming
      // would break the diagnostic path this field exists to strengthen.
      service: MCP_HEALTH_SERVICE,
      server: "Minsky MCP Server",
      transport: "http",
      timestamp: nowIso,
      persistence: {
        mode: health.mode,
        ...(health.reason ? { reason: health.reason } : {}),
      },
      // mt#4297: LIVENESS and READINESS are different questions, and this
      // endpoint answered only the first. `status`/the status code say "the
      // process booted"; `ready` says "it can serve DB-backed work".
      //
      // Deliberately derived from `mode` alone rather than from the process's
      // own mode flags: a reader asking "can this serve me?" should not have to
      // know how the process was launched, and a future transport gets the
      // right answer here without touching this line.
      ready: health.mode === "connected",
    },
  };
}
