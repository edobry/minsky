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
import type {
  ReachabilityCheck,
  ReachabilityStatus,
} from "@minsky/domain/persistence/reachability";

/** The `service` identity every Minsky service emits (mt#3148). */
export const MCP_HEALTH_SERVICE = "minsky-mcp";

/**
 * The MCP daemon's `/health` response body.
 *
 * Field-by-field rationale lives in `contract/mcp-health-shape.json`; this type
 * is the compile-time half of the same contract.
 */
export interface McpHealthPayload {
  /**
   * Three states, not two (mt#4466).
   *
   * `"degraded"` is the state this daemon could not previously express: the
   * process is alive and a SQL-capable provider IS wired, but a query cannot
   * currently get through its pool. Before mt#4466 that case was
   * indistinguishable from full health, because `persistence.mode` is decided by
   * `getCapabilities().sql` — a static flag that stays `connected` with every
   * connection in the pool held (mem#1120 R2: ~50 minutes of that, at ~1ms,
   * across every conversation on the machine).
   *
   * It carries HTTP **200**, and that is deliberate rather than an oversight —
   * see {@link buildMcpHealthResponse}'s note on why the status code must not
   * move for this state.
   */
  status: "ok" | "degraded" | "unhealthy";
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
  /**
   * Live reachability of this process's own pool, as of the last out-of-band
   * probe (mt#4466). Present ONLY when a SQL-capable provider is wired — there
   * is nothing to probe otherwise, and emitting `"unreachable"` for the expected
   * local/dev boot would read as an alarm for the normal case.
   *
   * A bare string rather than a sub-object, matching the cockpit's `db` field
   * exactly: its dating field is the sibling {@link McpHealthPayload.dbCheck}.
   * That shape is not cosmetic — the tray's supervisor already parses the
   * cockpit's `db` out of the health body it has in hand
   * (`supervisor.rs`, `DB_DEGRADED_POLL_THRESHOLD`), so publishing the same key
   * here is what lets that policy generalize to this daemon instead of needing a
   * second, differently-shaped one.
   */
  db?: ReachabilityStatus;
  /**
   * When the last probe FINISHED, and how long the last successful one took.
   *
   * `checkedAt` is what distinguishes "ok, just measured" from a stale "ok" —
   * without it `db` would be another value a reader cannot date. A `checkedAt`
   * that stops advancing while `db` reads `"degraded"` is the never-settling
   * -query wedge, and is the single most diagnostic pair in this body.
   * Present under the same condition as {@link McpHealthPayload.db}.
   */
  dbCheck?: ReachabilityCheck;
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
  nowIso: string,
  reachability?: { status: ReachabilityStatus; check: ReachabilityCheck }
): McpHealthResponse {
  // mt#4466: a live probe only means something when a SQL-capable provider is
  // actually wired. In `unconfigured` there is no pool to reach, and in
  // `unavailable` initialization already failed — reporting reachability for
  // either would add a second, redundant alarm to a state the existing fields
  // already describe correctly.
  const probeApplies = health.mode === "connected" && reachability !== undefined;
  // `unreachable` cannot legitimately occur while `mode === "connected"` (the
  // provider IS initialized), so fold it in with `degraded` rather than adding a
  // fourth top-level state for a case that would indicate a wiring bug.
  const dbDegraded = probeApplies && reachability.status !== "ok";

  return {
    // **The status code deliberately does NOT move for `degraded`** (mt#4466),
    // and this is the one decision in this file most likely to be "corrected"
    // later, so the reasoning is here rather than in a commit message:
    //
    // 1. LIVENESS is what the code answers — "did the process boot?" — and in a
    //    pool wedge it did. `ready` answers READINESS. The fixture's own
    //    `$readyFieldNote` already forbids deriving either from the other; a
    //    degraded pool is exactly the case that separates them.
    // 2. A 503 would be actively WRONG for the one consumer that reads it.
    //    `classifyDaemonProbe` (src/mcp/setup/local-http-apply.ts) tests
    //    `kind === "http-error"` BEFORE it checks identity, so a non-2xx answer
    //    is classified **foreign** — "some other app holds the port". For a
    //    wedged-but-ours daemon that is a misdiagnosis with a destructive
    //    remedy. Its `ready: false` path already returns the correct
    //    `not-ready`, which refuses adoption without disowning the process.
    //    (The tray's Rust side gets this right independently — `is_ours` keys on
    //    identity, not status, and its docstring says so.)
    statusCode: health.healthy ? 200 : 503,
    body: {
      status: health.healthy ? (dbDegraded ? "degraded" : "ok") : "unhealthy",
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
      // mt#4466 widened this from `mode === "connected"` alone. `ready` claims
      // "it can serve DB-backed work", and a daemon whose pool is not answering
      // cannot — that claim was false for ~50 minutes on 2026-08-23 while this
      // field read true, which is the whole defect. The static-capability term
      // stays: both must hold.
      ready: health.mode === "connected" && !dbDegraded,
      ...(probeApplies ? { db: reachability.status, dbCheck: reachability.check } : {}),
    },
  };
}
