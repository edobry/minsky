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

import type { PgRetryCounters } from "@minsky/domain/persistence/postgres-retry";
import type { PersistenceHealthStatus } from "@minsky/domain/persistence/health";
import type { ReadinessResult } from "@minsky/domain/persistence/readiness-probe";

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
  /**
   * Live pool reachability as of the last probe (mt#4479).
   *
   * A MACHINE-READABLE rendering of the same `ReadinessResult` that decided
   * `ready`. Everything it says is already in `ready` + `persistence.reason` —
   * but `reason` is prose written "for an operator reading a health body at
   * 3am", and the consumer that needs this is Rust in a 5s poll loop
   * (`cockpit-tray/src-tauri/src/supervisor.rs`) which would otherwise have to
   * regex a sentence.
   *
   * **The field NAME is the point.** The tray's DB-degraded policy already
   * exists and is `CockpitPolicy`-only for one stated reason, verbatim in that
   * file: *"only the cockpit's `/api/health` publishes a `db` field"*. Matching
   * the cockpit's key exactly is what lets one policy read both daemons.
   *
   * Only `"ok"` and `"degraded"` are emitted. The cockpit's third value,
   * `"unreachable"`, is deliberately absent: this field is present only when
   * `persistence.mode === "connected"`, which already means a provider is
   * wired, so "no pool at all" is unrepresentable here rather than merely
   * unobserved. A consumer switching on the cockpit's three values still works.
   */
  db?: "ok" | "degraded";
  /**
   * When the probe behind `db` settled, and how long it took (mt#4479).
   *
   * Both come straight off `ReadinessResult` — never re-timed at the render
   * site, so `db`, `ready` and `persistence.reason` always describe the SAME
   * probe attempt.
   *
   * `durationMs` is the field with the most value beyond `reason`: on an
   * outstanding (never-settled) probe, mt#4471's `reason` names the wait in
   * prose, and a supervisor thresholding on it needs the number.
   *
   * ## This sub-object does NOT mirror the cockpit's, despite the shared name
   *
   * PR #3277 R1. `db` above matches the cockpit deliberately — `ok`/`degraded`
   * mean the same thing on both daemons. `dbCheck`'s MEMBERS do not, and a
   * reader who assumes symmetry gets both of them wrong:
   *
   * - **`durationMs` is NOT the cockpit's `latencyMs`, which is why it has a
   *   different name.** The cockpit's is "the round-trip of the last SUCCESSFUL
   *   probe … NOT reset when a later probe fails", i.e. a last-good-measurement
   *   that can sit next to `db: "degraded"`. Ours is how long THIS check took
   *   however it settled — success, timeout, or error. Emitting a 43-second
   *   timeout under the name `latencyMs` would tell a cross-daemon consumer it
   *   was a healthy round-trip.
   * - **`checkedAt` shares its name and has the OPPOSITE behaviour.** The
   *   cockpit deliberately does not restamp it while a probe is outstanding, so
   *   a stale value there IS the wedge signal. Here `assessProbeOutcome` stamps
   *   it on all four branches, so it always advances. Do NOT read a stale
   *   `checkedAt` as a wedge signal on THIS daemon; read `persistence.reason`
   *   (which names how long the outstanding round-trip has waited) or
   *   `durationMs`.
   */
  dbCheck?: { checkedAt: string; durationMs: number };
  /**
   * Connection-retry outcomes since process start (mt#4562).
   *
   * Unlike `db`/`dbCheck` above, this is NOT conditional on
   * `persistence.mode === "connected"`. Those describe a probe that only a
   * connected provider performs; these are monotonic counters of events that
   * already happened, and suppressing them on a daemon that has since gone
   * `unavailable` would hide exactly the history an operator diagnosing that
   * state wants.
   *
   * **Read `saturationRetries: 0` as "expected", not "healthy".** Pool
   * exhaustion is structurally near-unreachable on the transaction pooler
   * production uses (mt#3497), so a zero there carries no information on its
   * own. `retriesExhausted` is the field that is a fault in either class.
   *
   * Named `dbRetry` to sit beside the cockpit's `dbRecycle`: both are the
   * outcome counters of a DB recovery mechanism, and a cross-daemon consumer
   * should find them under parallel names.
   */
  dbRetry?: PgRetryCounters;
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
  readiness?: ReadinessResult,
  // mt#4562: INJECTED, not read from module state here. `getPgRetryCounters()`
  // is a module-level read, and calling it inside this function would make the
  // payload untestable without reaching into that state — the exact split this
  // file's own doc comment exists to preserve (functional core / imperative
  // shell). The route reads the counters; this function only renders them.
  retryCounters?: PgRetryCounters
): McpHealthResponse {
  // mt#4471: `ready` needs an OBSERVATION, not a type declaration. `health.mode`
  // is derived from `provider.getCapabilities().sql` — true for any SQL-capable
  // provider, including one whose pool has stopped serving. On 2026-08-23 that
  // gap let this endpoint answer `ready: true` twice during a 45-minute outage
  // in which every DB-backed call hung.
  //
  // The mode check is retained as a PRECONDITION rather than replaced: an
  // `unconfigured` daemon has nothing to round-trip against, and must keep
  // reporting `ready: false` without a probe ever running (that is the
  // offline/dev boot the CI smoke gate asserts a 200 against).
  //
  // A caller that supplies no probe result gets the pre-mt#4471 behaviour. That
  // is deliberate for the two non-route callers — the contract test and any
  // consumer building a body without a live provider — and the route itself
  // always passes one.
  const probeSatisfied = readiness === undefined || readiness.ok;
  const ready = health.mode === "connected" && probeSatisfied;

  // Prefer the assessment's own reason (the `unavailable` outage case, which is
  // more specific), and fall back to the probe's explanation so a `connected`
  // provider that cannot serve says WHY rather than reporting a bare
  // `ready: false` the operator has to go diagnose from scratch.
  const reason = health.reason ?? (ready ? undefined : readiness?.reason);

  // mt#4479: render the SAME `readiness` object as machine-readable fields.
  // Conditional on `connected` for the same reason `ready` uses that mode as a
  // precondition — an `unconfigured` daemon never probes, and an `unavailable`
  // one failed to initialize, so in both cases there is no pool reading to
  // report. Emitting one anyway would put an alarming-looking field on the
  // expected offline boot that `bundle-boot-smoke` asserts a 200 against.
  //
  // Derived from `readiness`, never recomputed: `db` is exactly `readiness.ok`
  // restated, so it cannot disagree with `ready` about the same probe.
  const dbFields =
    health.mode === "connected" && readiness !== undefined
      ? {
          db: (readiness.ok ? "ok" : "degraded") as "ok" | "degraded",
          dbCheck: { checkedAt: readiness.checkedAt, durationMs: readiness.durationMs },
        }
      : {};

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
        ...(reason ? { reason } : {}),
      },
      // mt#4297: LIVENESS and READINESS are different questions, and this
      // endpoint answered only the first. `status`/the status code say "the
      // process booted"; `ready` says "it can serve DB-backed work".
      //
      // Deliberately NOT derived from the process's own mode flags: a reader
      // asking "can this serve me?" should not have to know how the process was
      // launched, and a future transport gets the right answer here without
      // touching this line.
      //
      // mt#4471 changed WHAT it is derived from. It was `mode === "connected"`
      // alone, which is a claim about the provider's TYPE; it is now that
      // precondition AND an observed round trip. See the computation above.
      ready,
      ...dbFields,
      ...(retryCounters ? { dbRetry: retryCounters } : {}),
    },
  };
}
