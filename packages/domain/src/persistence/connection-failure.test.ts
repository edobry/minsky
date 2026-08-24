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
  databaseConditionSqlStateClass,
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

  it("classifies resolver failures as dns, not as a connect timeout (PR #2732 R1)", () => {
    // `ESERVFAIL` is a getaddrinfo/c-ares RESOLVER failure — the DNS server
    // answered SERVFAIL — so the connect phase is never reached. Reporting it
    // as a timeout would tell an operator "nothing answered on the database
    // port" about a host that was never resolved.
    for (const code of ["ESERVFAIL", "EAI_FAIL", "ENODATA"]) {
      expect(classifyConnectionFailure(driverError(code)).kind).toBe("dns");
    }
  });

  it("classifies ECONNRESET as connection-lost, not refused (PR #2732 R1)", () => {
    // A reset is a peer dropping a connection that WAS working — the transient
    // shape a fresh pool fixes. Filing it under `refused` would put it in the
    // escalating set and back the recycle off against a recoverable failure.
    const failure = classifyConnectionFailure(driverError("ECONNRESET"));
    expect(failure.kind).toBe("connection-lost");
    expect(
      nextRecycleIntervalMs({ failure, consecutiveRecycles: 500, baseIntervalMs: 60_000 })
    ).toBe(60_000);
  });

  it("keeps unreachable-path codes in the escalating refused class", () => {
    // EHOSTUNREACH/ENETUNREACH are an active ICMP rejection, not silence, and
    // a fresh pool cannot fix either — so they classify as `refused` AND
    // escalate, unlike ECONNRESET above.
    for (const code of ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]) {
      const failure = classifyConnectionFailure(driverError(code));
      expect(failure.kind).toBe("refused");
      expect(
        nextRecycleIntervalMs({ failure, consecutiveRecycles: 500, baseIntervalMs: 60_000 })
      ).toBeGreaterThan(60_000);
    }
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

/**
 * mt#4519 — the SQLSTATE-class predicate, and the boundary that keeps it from
 * disturbing `classifyConnectionFailure`.
 *
 * `databaseConditionSqlStateClass` answers a DIFFERENT question from the
 * classifier above it ("is this a fact about the database?" vs "is the
 * connection unusable?"), which is why it is a separate export. The last
 * describe block is the one that matters most: two live consumers depend on
 * `classifyConnectionFailure` returning `"unknown"` for these codes, so a
 * regression there is silent and expensive.
 */
describe("databaseConditionSqlStateClass (mt#4519)", () => {
  const withCode = (code: string) => Object.assign(new Error(`error carrying ${code}`), { code });

  it("recognizes every DB-condition class PostgreSQL Appendix A defines", () => {
    // One member per class, named for what Postgres calls it.
    expect(databaseConditionSqlStateClass(withCode("08006"))).toBe("08"); // connection_failure
    expect(databaseConditionSqlStateClass(withCode("40001"))).toBe("40"); // serialization_failure
    expect(databaseConditionSqlStateClass(withCode("53300"))).toBe("53"); // too_many_connections
    expect(databaseConditionSqlStateClass(withCode("57014"))).toBe("57"); // query_canceled
  });

  it("covers a code the implementation never enumerates, because the rule is class-level", () => {
    // The mt#4100 SC3 requirement, restated for this consumer: a literal list
    // would need another incident to grow. `53400` and `08P01` appear nowhere
    // in the source.
    expect(databaseConditionSqlStateClass(withCode("53400"))).toBe("53");
    expect(databaseConditionSqlStateClass(withCode("08P01"))).toBe("08");
    expect(databaseConditionSqlStateClass(withCode("57P04"))).toBe("57");
  });

  it("rejects class 42 — a malformed query is OUR bug, not a database condition", () => {
    // The boundary that stops this becoming "swallow everything". mt#4100 drew
    // the same line for the daemon's exit path.
    expect(databaseConditionSqlStateClass(withCode("42601"))).toBeNull();
    expect(databaseConditionSqlStateClass(withCode("28P01"))).toBeNull(); // auth
    expect(databaseConditionSqlStateClass(withCode("22021"))).toBeNull(); // encoding — mt#3278's class
  });

  it("rejects client-side driver codes, which are the OTHER code space", () => {
    // These are postgres-js's own codes. They are handled by
    // `classifyConnectionFailure`; conflating the two spaces is what mt#4100 was.
    expect(databaseConditionSqlStateClass(withCode("CONNECTION_CLOSED"))).toBeNull();
    expect(databaseConditionSqlStateClass(withCode("ECIRCUITBREAKER"))).toBeNull();
  });

  it("returns null for a code-less error, null, and a non-object", () => {
    expect(databaseConditionSqlStateClass(new Error("no code"))).toBeNull();
    expect(databaseConditionSqlStateClass(null)).toBeNull();
    expect(databaseConditionSqlStateClass("57014")).toBeNull();
  });

  it("follows the cause chain, so a wrapped driver error still classifies", () => {
    const wrapped = new Error("ingest failed", { cause: withCode("57014") });
    expect(databaseConditionSqlStateClass(wrapped)).toBe("57");
  });
});

describe("classifyConnectionFailure is UNCHANGED by mt#4519", () => {
  // The regression this task's planning audit identified and deliberately
  // avoided. `shared-persistence.ts`'s `noteFailure` will not let an `unknown`
  // clobber a stronger classification — that guard is what preserves a real
  // `CONNECT_TIMEOUT` verdict on `/api/health` during a degraded run (mt#3826).
  // `ESCALATING_KINDS` is keyed on the same `kind`. Teaching the classifier to
  // return a connection-ish kind for a SQLSTATE would silently change both, so
  // this pins that it does not.
  it("still returns 'unknown' for every server-side SQLSTATE", () => {
    for (const code of ["57014", "57P01", "53300", "53400", "08006", "40001", "42601"]) {
      expect(classifyConnectionFailure(Object.assign(new Error("x"), { code })).kind).toBe(
        "unknown"
      );
    }
  });
});
