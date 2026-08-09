/**
 * Connection-failure classification (mt#3826).
 *
 * The cockpit's DB recovery apparatus (`src/cockpit/shared-persistence.ts`)
 * treats every failed connection identically: probe fails, pool recycles, the
 * next probe rebuilds a pool and tries again, once per minute, forever. That is
 * the right remedy for the failure it was built for — a half-open pool wedge
 * (mt#3638), where a fresh pool genuinely fixes it — and the wrong remedy for a
 * network that is refusing the port outright, where no number of fresh pools
 * will help. On 2026-08-07 an operator on an outbound-80/443-only network took
 * ~500 recycles over ~9 hours, every one of them futile, because the two cases
 * are indistinguishable downstream.
 *
 * This module supplies the missing discrimination. It answers ONLY the factual
 * question — what kind of failure was this? — and deliberately does not decide
 * whether to keep retrying. That decision needs a streak, not a single sample
 * (one connect timeout is equally consistent with a blocked port and a briefly
 * overloaded server), and it lives in `shouldEscalateRecycleInterval` below.
 *
 * Classification reads the driver's structured `code`, never the message.
 * postgres-js builds every connection error through `Errors.connection`
 * (`node_modules/postgres/src/errors.js:16-28`), which attaches
 * `{ code, errno, address, port }`; OS-level socket errors reach the caller
 * unchanged with their own `code`. Message text varies by driver version and is
 * not a stable contract.
 */

/**
 * What kind of failure the driver reported.
 *
 * The values are named for the OBSERVATION, not for a remedy — "connect-timeout"
 * says nothing answered in time, which is what a firewalled port looks like AND
 * what a saturated server looks like. Naming these after conclusions
 * ("blocked", "unrecoverable") would bake a judgment into a fact.
 */
export type ConnectionFailureKind =
  /** Nothing answered before the connect deadline. The shape of a port-level block. */
  | "connect-timeout"
  /**
   * Something on the path actively rejected the attempt — a closed port on a
   * reachable host, or a router reporting the host/network unreachable. The
   * discriminator against `connect-timeout` is that a response came back at
   * all, rather than silence.
   */
  | "refused"
  /** Name resolution failed. A different problem from reachability. */
  | "dns"
  /** The server answered and rejected the credentials or the database name. */
  | "auth"
  /** An established connection went away, or the pool handed back a dead one. */
  | "connection-lost"
  /** Supavisor's per-tenant breaker is open; new connections are refused upstream. */
  | "circuit-breaker"
  /** Nothing matched. Deliberately distinct from a guess. */
  | "unknown";

/** A classified connection failure, safe to put on a health payload. */
export interface ConnectionFailure {
  kind: ConnectionFailureKind;
  /** The driver/OS code the classification was derived from, when there was one. */
  code: string | null;
  /** The error's own message, for an operator reading a health payload. */
  message: string;
}

/**
 * postgres-js's own connection-error codes (`src/connection.js`), which it
 * synthesizes rather than taking from the OS.
 */
const DRIVER_CONNECT_TIMEOUT = "CONNECT_TIMEOUT";

/**
 * Codes meaning an established connection went away.
 *
 * `ECONNRESET` belongs HERE rather than with the refusals: a reset is a peer
 * dropping a connection that was working, which is the transient shape a fresh
 * pool genuinely fixes. Classifying it as a refusal would put it in the
 * escalating set and back the recycle off against a recoverable failure —
 * precisely the over-correction success criterion 4 forbids.
 */
const CONNECTION_LOST_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "ECONNRESET",
]);

/** OS-level socket codes, as surfaced by node/bun's net module. */
const OS_TIMEOUT = new Set(["ETIMEDOUT"]);
const OS_REFUSED = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]);

/**
 * Name-resolution failures.
 *
 * `ESERVFAIL` is a getaddrinfo/c-ares RESOLVER failure (the DNS server answered
 * SERVFAIL), not a socket timeout — it never reaches the connect phase at all.
 * Grouping it with the timeouts would report "nothing answered on the database
 * port" for a host that was never resolved, pointing an operator at the network
 * path instead of at DNS.
 */
const OS_DNS = new Set(["ENOTFOUND", "EAI_AGAIN", "ESERVFAIL", "EAI_FAIL", "ENODATA"]);

/** Supavisor / pooler-level codes seen in this deployment (mem#597, gh#1761). */
const POOLER_BREAKER = new Set(["ECIRCUITBREAKER", "EDBHANDLEREXITED"]);

/**
 * SQLSTATE class 28 is `invalid_authorization_specification` — the server
 * answered and rejected us. `3D000` (invalid_catalog_name) is the same
 * situation for a wrong database name: a reachable server, a bad request.
 */
function isAuthSqlState(code: string): boolean {
  return code.startsWith("28") || code === "3D000";
}

/**
 * Read a `code` off an unknown thrown value, following the `cause` chain.
 *
 * The chain walk matters because this codebase wraps: the reachability probe
 * rejects with its own deadline Error whose `cause` is the driver's, and
 * `PersistenceService.initialize()` can rethrow through a layer. Taking only
 * the top-level `code` would classify every wrapped failure as "unknown",
 * which is exactly the information loss this module exists to stop.
 *
 * Bounded to avoid a cyclic `cause` chain spinning; depth 8 is far beyond any
 * wrapping this codebase does.
 */
function readErrorCode(err: unknown): { code: string | null; message: string } {
  let current: unknown = err;
  let message = "";
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth++) {
    if (typeof current !== "object") break;
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (message === "" && typeof candidate.message === "string") {
      message = candidate.message;
    }
    if (typeof candidate.code === "string" && candidate.code !== "") {
      return { code: candidate.code, message: message || candidate.code };
    }
    current = candidate.cause;
  }
  return { code: null, message: message || String(err) };
}

/**
 * Classify a connection failure by its driver/OS code.
 *
 * Never throws — it is called from error paths, including a health route that
 * must not be able to fail. An unrecognized or code-less error classifies as
 * `"unknown"`, which callers must treat as "no information", never as a
 * synonym for transient.
 */
export function classifyConnectionFailure(err: unknown): ConnectionFailure {
  const { code, message } = readErrorCode(err);
  if (code === null) {
    return { kind: "unknown", code: null, message };
  }
  const kind: ConnectionFailureKind =
    code === DRIVER_CONNECT_TIMEOUT || OS_TIMEOUT.has(code)
      ? "connect-timeout"
      : OS_REFUSED.has(code)
        ? "refused"
        : OS_DNS.has(code)
          ? "dns"
          : POOLER_BREAKER.has(code)
            ? "circuit-breaker"
            : CONNECTION_LOST_CODES.has(code)
              ? "connection-lost"
              : isAuthSqlState(code)
                ? "auth"
                : "unknown";
  return { kind, code, message };
}

/**
 * Futile recycles against one failure kind before the cadence starts backing off.
 *
 * Grounded in the apparatus's own existing evidence unit rather than a round
 * number, per `decision-defaults.mdc §Thresholds`: `RECYCLE_AFTER_DEGRADED_MS`
 * already treats "three probe deadlines' worth" as sufficient evidence of a
 * wedge, so three futile recycles is the matching amount of evidence that the
 * remedy is not working. At the 60 s floor that is three minutes of trying the
 * ordinary fix before concluding the ordinary fix does not apply.
 */
export const ESCALATE_AFTER_CONSECUTIVE_RECYCLES = 3;

/**
 * Ceiling on the backed-off interval.
 *
 * Chosen against the observed incident rather than a round number: the
 * 2026-08-07 window ran ~9 h. At this ceiling that window costs ~40 recycles
 * instead of the ~500 it actually cost, while still re-probing often enough
 * that an operator who rejoins a normal network waits at most this long for the
 * cockpit to notice — comfortably inside the "did I have to restart it?"
 * threshold that made the original incident visible in the first place.
 */
export const MAX_RECYCLE_INTERVAL_MS = 15 * 60_000;

/**
 * Failure kinds where a fresh pool is not the remedy.
 *
 * The excluded kinds are the point of the exclusion. `connection-lost` and
 * `unknown` cover the half-open pool wedge that `recycleSharedPersistence`
 * exists to fix (mt#3638) — there the recycle demonstrably works, and backing
 * it off would make a recoverable outage last longer. `circuit-breaker` is
 * upstream and self-clearing once connection attempts stop (mem#597), so it
 * also keeps the steady cadence rather than escalating.
 */
const ESCALATING_KINDS = new Set<ConnectionFailureKind>([
  "connect-timeout",
  "refused",
  "dns",
  "auth",
]);

/**
 * The recycle interval to use next, given what the last failure looked like and
 * how many consecutive same-kind failures preceded it.
 *
 * Pure, so the policy is testable without timers or a live pool — the same
 * reason `shouldRecycleNow` is pure.
 *
 * Returns `baseIntervalMs` unchanged for every case except a sustained streak
 * of a kind a fresh pool cannot fix, which doubles per failure past the
 * threshold up to {@link MAX_RECYCLE_INTERVAL_MS}.
 */
export function nextRecycleIntervalMs(input: {
  failure: ConnectionFailure | null;
  /** Recycles already attempted against this failure without success. */
  consecutiveRecycles: number;
  baseIntervalMs: number;
  maxIntervalMs?: number;
  escalateAfter?: number;
}): number {
  const max = input.maxIntervalMs ?? MAX_RECYCLE_INTERVAL_MS;
  const escalateAfter = input.escalateAfter ?? ESCALATE_AFTER_CONSECUTIVE_RECYCLES;
  if (input.failure === null || !ESCALATING_KINDS.has(input.failure.kind)) {
    return input.baseIntervalMs;
  }
  const past = input.consecutiveRecycles - escalateAfter;
  if (past <= 0) return input.baseIntervalMs;
  // Cap the exponent before computing the power: at ~1000 consecutive failures
  // `2 ** past` is Infinity, and Infinity * baseIntervalMs stays Infinity
  // through the Math.min, which would suspend recycling permanently rather
  // than clamping to the ceiling.
  const boundedExponent = Math.min(past, 32);
  return Math.min(max, input.baseIntervalMs * 2 ** boundedExponent);
}
