/**
 * Tests for connection-failure classification and the recycle-backoff policy
 * (mt#3826).
 *
 * The driver-error fixtures below are constructed to match postgres-js's own
 * `Errors.connection` output exactly (`node_modules/postgres/src/errors.js`
 * lines 16-28: `Object.assign(new Error(...), { code, errno, address, port })`).
 * That is deliberate — the whole premise of this module is that classification
 * reads the driver's structured `code` rather than its message, so the fixtures
 * have to carry the same structure the driver actually produces or the tests
 * would be pinning an invention.
 */
import { describe, expect, it } from "bun:test";
import { connect } from "node:net";
import {
  classifyConnectionFailure,
  nextRecycleIntervalMs,
  ESCALATE_AFTER_CONSECUTIVE_RECYCLES,
  MAX_RECYCLE_INTERVAL_MS,
  type ConnectionFailure,
} from "./connection-failure";

/** Build an error shaped like postgres-js's `Errors.connection` output. */
function driverError(code: string, host = "db.example.com", port = 6543): Error {
  return Object.assign(new Error(`write ${code} ${host}:${port}`), {
    code,
    errno: code,
    address: host,
    port,
  });
}

describe("classifyConnectionFailure (mt#3826)", () => {
  it("classifies postgres-js CONNECT_TIMEOUT as connect-timeout", () => {
    const failure = classifyConnectionFailure(driverError("CONNECT_TIMEOUT"));
    expect(failure.kind).toBe("connect-timeout");
    expect(failure.code).toBe("CONNECT_TIMEOUT");
  });

  it("distinguishes refused from connect-timeout (AT2)", () => {
    // The acceptance test's discriminator: a host that ANSWERS and says no must
    // not land in the same bucket as a host that says nothing at all, because
    // the correct response differs — one is a wrong port, the other may be a
    // blocked one.
    const timeout = classifyConnectionFailure(driverError("CONNECT_TIMEOUT"));
    const refused = classifyConnectionFailure(driverError("ECONNREFUSED"));
    expect(refused.kind).toBe("refused");
    expect(timeout.kind).toBe("connect-timeout");
    expect(refused.kind).not.toBe(timeout.kind);
  });

  it("classifies a REAL OS connection-refused error (AT2, live socket)", async () => {
    // Grounds the OS-code half of the classifier in an actual socket error
    // rather than a fixture asserting what this codebase BELIEVES the OS emits.
    // Port 1 on loopback is reliably closed and needs no network.
    const err = await new Promise<unknown>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: 1 });
      socket.on("error", (e) => {
        socket.destroy();
        resolve(e);
      });
    });
    expect((err as { code?: string }).code).toBe("ECONNREFUSED");
    expect(classifyConnectionFailure(err).kind).toBe("refused");
  });

  it("classifies DNS failure separately from reachability failure", () => {
    expect(classifyConnectionFailure(driverError("ENOTFOUND")).kind).toBe("dns");
    expect(classifyConnectionFailure(driverError("EAI_AGAIN")).kind).toBe("dns");
  });

  it("classifies a SQLSTATE class-28 rejection as auth", () => {
    // postgres-js surfaces server errors as PostgresError with the SQLSTATE on
    // `code`; 28P01 is invalid_password, 28000 invalid_authorization.
    expect(classifyConnectionFailure(driverError("28P01")).kind).toBe("auth");
    expect(classifyConnectionFailure(driverError("28000")).kind).toBe("auth");
    expect(classifyConnectionFailure(driverError("3D000")).kind).toBe("auth");
  });

  it("classifies the pool-wedge and breaker codes as their own kinds", () => {
    // These are the kinds the recycle remedy DOES fix; keeping them distinct is
    // what stops the backoff from being applied to them.
    expect(classifyConnectionFailure(driverError("CONNECTION_CLOSED")).kind).toBe(
      "connection-lost"
    );
    expect(classifyConnectionFailure(driverError("CONNECTION_DESTROYED")).kind).toBe(
      "connection-lost"
    );
    expect(classifyConnectionFailure(driverError("ECIRCUITBREAKER")).kind).toBe("circuit-breaker");
  });

  it("follows the cause chain to the driver error", () => {
    // The reachability probe rejects with its OWN deadline Error whose `cause`
    // is the driver's. Reading only the top level would classify every wrapped
    // failure as unknown — the exact information loss this module exists to
    // stop.
    const wrapped = new Error("DB reachability probe exceeded 5000ms", {
      cause: driverError("CONNECT_TIMEOUT"),
    });
    expect(classifyConnectionFailure(wrapped).kind).toBe("connect-timeout");
  });

  it("returns unknown rather than guessing, and never throws", () => {
    expect(classifyConnectionFailure(new Error("no code here")).kind).toBe("unknown");
    expect(classifyConnectionFailure(undefined).kind).toBe("unknown");
    expect(classifyConnectionFailure("a string").kind).toBe("unknown");
    expect(classifyConnectionFailure({ code: 12345 }).kind).toBe("unknown");
  });

  it("terminates on a cyclic cause chain", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(classifyConnectionFailure(a).kind).toBe("unknown");
  });
});

describe("nextRecycleIntervalMs (mt#3826)", () => {
  const base = 60_000;
  const failureOf = (kind: ConnectionFailure["kind"]): ConnectionFailure => ({
    kind,
    code: "TEST",
    message: "test",
  });

  it("holds the base interval until the escalation threshold", () => {
    for (let n = 0; n <= ESCALATE_AFTER_CONSECUTIVE_RECYCLES; n++) {
      const interval = nextRecycleIntervalMs({
        failure: failureOf("connect-timeout"),
        consecutiveRecycles: n,
        baseIntervalMs: base,
      });
      expect(interval).toBe(base);
    }
  });

  it("doubles past the threshold for a failure a fresh pool cannot fix", () => {
    const at = (n: number): number =>
      nextRecycleIntervalMs({
        failure: failureOf("connect-timeout"),
        consecutiveRecycles: n,
        baseIntervalMs: base,
      });
    expect(at(ESCALATE_AFTER_CONSECUTIVE_RECYCLES + 1)).toBe(base * 2);
    expect(at(ESCALATE_AFTER_CONSECUTIVE_RECYCLES + 2)).toBe(base * 4);
    expect(at(ESCALATE_AFTER_CONSECUTIVE_RECYCLES + 3)).toBe(base * 8);
  });

  it("clamps at the ceiling instead of growing without bound", () => {
    expect(
      nextRecycleIntervalMs({
        failure: failureOf("connect-timeout"),
        consecutiveRecycles: 500,
        baseIntervalMs: base,
      })
    ).toBe(MAX_RECYCLE_INTERVAL_MS);
  });

  it("clamps rather than overflowing to Infinity at an extreme streak", () => {
    // 2 ** 1000 is Infinity, and Infinity survives Math.min — which would
    // suspend recycling forever instead of holding it at the ceiling. The
    // exponent bound in the implementation is what this pins.
    const interval = nextRecycleIntervalMs({
      failure: failureOf("connect-timeout"),
      consecutiveRecycles: 1000,
      baseIntervalMs: base,
    });
    expect(Number.isFinite(interval)).toBe(true);
    expect(interval).toBe(MAX_RECYCLE_INTERVAL_MS);
  });

  it("does NOT escalate the kinds the recycle remedy actually fixes (AT3 guard)", () => {
    // The negative control against over-correction. `connection-lost` is the
    // half-open pool wedge mt#3638 built the recycle for, and `unknown` is the
    // never-settle wedge that produces no error at all. Backing either off
    // would make a RECOVERABLE outage last longer — the precise failure mode
    // criterion 4 forbids.
    for (const kind of ["connection-lost", "circuit-breaker", "unknown"] as const) {
      expect(
        nextRecycleIntervalMs({
          failure: failureOf(kind),
          consecutiveRecycles: 500,
          baseIntervalMs: base,
        })
      ).toBe(base);
    }
  });

  it("holds the base interval when nothing has been classified", () => {
    expect(
      nextRecycleIntervalMs({ failure: null, consecutiveRecycles: 500, baseIntervalMs: base })
    ).toBe(base);
  });

  it("bounds the 2026-08-07 incident to a fraction of its observed churn", () => {
    // The incident this task exists for: ~9h of a blocked port cost ~500
    // recycles at the flat 60s floor. Replaying that window against the policy
    // is the criterion-2 grounding check — the number has to come out
    // dramatically lower, or the backoff is decorative.
    const windowMs = 9 * 60 * 60_000;
    let elapsed = 0;
    let recycles = 0;
    while (elapsed < windowMs) {
      elapsed += nextRecycleIntervalMs({
        failure: failureOf("connect-timeout"),
        consecutiveRecycles: recycles,
        baseIntervalMs: base,
      });
      recycles++;
    }
    expect(recycles).toBeLessThan(50);
    // And the unbounded behaviour it replaces, for contrast.
    expect(Math.floor(windowMs / base)).toBeGreaterThan(500);
  });
});
