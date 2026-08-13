/**
 * Unit tests for the exported helpers in start-command.ts.
 *
 * The classifier and the handler it feeds are extracted and exported
 * specifically so they can be tested in isolation — confirming that the
 * `unhandledRejection` handler stays up for a condition at the database,
 * degrades only when the connection is actually unusable, and still exits for
 * an unrelated error.
 *
 * gh#1761 R1 established the client-side half. mt#4100 added the server-side
 * SQLSTATE half, after a `57014` (query_canceled) statement timeout matched
 * none of the four client-side codes and killed a serving daemon.
 */
import { describe, test, expect } from "bun:test";
import {
  classifyUnhandledRejection,
  createUnhandledRejectionHandler,
  type UnhandledRejectionEffects,
} from "./start-command";
import { PersistenceInitTimeoutError } from "../../cockpit/shared-persistence";

describe("classifyUnhandledRejection — server-side SQLSTATE (mt#4100)", () => {
  // The observed instance. One statement was cancelled; the connection and the
  // pool behind it are fine, so tearing them down would be a self-inflicted
  // outage on a healthy database.
  test("57014 query_canceled survives — it does not exit, and does not degrade", () => {
    expect(classifyUnhandledRejection({ code: "57014" })).toBe("survive");
  });

  test("57P05 idle_session_timeout survives — one reaped session, not a dead pool", () => {
    expect(classifyUnhandledRejection({ code: "57P05" })).toBe("survive");
  });

  // Class 40 (Transaction Rollback) is per-transaction by definition.
  test("40001 serialization_failure survives", () => {
    expect(classifyUnhandledRejection({ code: "40001" })).toBe("survive");
  });

  test("40P01 deadlock_detected survives", () => {
    expect(classifyUnhandledRejection({ code: "40P01" })).toBe("survive");
  });

  // Connection-level members of the same classes: the pool really is unusable,
  // so the existing degrade-and-retry response is the right one.
  test("57P01 admin_shutdown degrades", () => {
    expect(classifyUnhandledRejection({ code: "57P01" })).toBe("degrade");
  });

  test("53300 too_many_connections degrades", () => {
    expect(classifyUnhandledRejection({ code: "53300" })).toBe("degrade");
  });

  test("08006 connection_failure degrades", () => {
    expect(classifyUnhandledRejection({ code: "08006" })).toBe("degrade");
  });

  // The rule is over the CLASS, not an enumerated list — these members are
  // named nowhere in the source and must still be covered.
  test("an unenumerated member of a covered class is still classified", () => {
    expect(classifyUnhandledRejection({ code: "08001" })).toBe("degrade");
    expect(classifyUnhandledRejection({ code: "53200" })).toBe("degrade");
    expect(classifyUnhandledRejection({ code: "40002" })).toBe("survive");
  });
});

describe("classifyUnhandledRejection — client-side codes (gh#1761 R1 regression)", () => {
  test.each(["ECIRCUITBREAKER", "EDBHANDLEREXITED", "CONNECTION_CLOSED", "CONNECTION_DESTROYED"])(
    "%s still degrades",
    (code) => {
      expect(classifyUnhandledRejection({ code })).toBe("degrade");
    }
  );

  test("PersistenceInitTimeoutError still degrades", () => {
    expect(classifyUnhandledRejection(new PersistenceInitTimeoutError(5000))).toBe("degrade");
  });
});

describe("classifyUnhandledRejection — everything else still exits", () => {
  // The guard against criterion 1 becoming "swallow everything".
  test("a programming bug exits", () => {
    expect(classifyUnhandledRejection(new TypeError("x is not a function"))).toBe("exit");
  });

  test("42601 syntax_error exits — a malformed query is our bug, not the DB's", () => {
    expect(classifyUnhandledRejection({ code: "42601" })).toBe("exit");
  });

  test("a SQLSTATE class outside the covered set exits", () => {
    expect(classifyUnhandledRejection({ code: "23505" })).toBe("exit");
  });

  test.each([
    ["a plain Error", new Error("something exploded")],
    ["an unknown error code", { code: "SOME_UNRELATED_ERROR" }],
    ["null", null],
    ["undefined", undefined],
    ["a string", "some string error"],
    ["an object without a code property", { message: "no code here" }],
  ])("%s exits", (_label, reason) => {
    expect(classifyUnhandledRejection(reason)).toBe("exit");
  });

  // A five-character string that merely STARTS like a covered class must not be
  // matched by prefix alone.
  test("a non-SQLSTATE code sharing a class prefix does not match", () => {
    expect(classifyUnhandledRejection({ code: "08" })).toBe("exit");
    expect(classifyUnhandledRejection({ code: "5730012" })).toBe("exit");
  });
});

interface RecordedEffects {
  effects: UnhandledRejectionEffects;
  survived: unknown[];
  logged: string[];
  degradeCount: () => number;
  retryStarts: () => number;
  retryStops: () => number;
  cleanups: () => number;
  exits: () => number;
}

function recordingEffects(): RecordedEffects {
  const survived: unknown[] = [];
  const logged: string[] = [];
  let degradeCount = 0;
  let retryStarts = 0;
  let retryStops = 0;
  let cleanups = 0;
  let exits = 0;

  return {
    effects: {
      logSurvived: (reason) => survived.push(reason),
      log: (line) => logged.push(line),
      markDegraded: () => {
        degradeCount += 1;
      },
      startRetryBackoff: () => {
        retryStarts += 1;
        return () => {
          retryStops += 1;
        };
      },
      cleanup: () => {
        cleanups += 1;
      },
      exit: () => {
        exits += 1;
      },
    },
    survived,
    logged,
    degradeCount: () => degradeCount,
    retryStarts: () => retryStarts,
    retryStops: () => retryStops,
    cleanups: () => cleanups,
    exits: () => exits,
  };
}

describe("createUnhandledRejectionHandler (mt#4100)", () => {
  test("a 57014 rejection reaches NEITHER markDegraded nor the exit path", () => {
    const r = recordingEffects();
    createUnhandledRejectionHandler(r.effects)({ code: "57014" });

    expect(r.degradeCount()).toBe(0);
    expect(r.retryStarts()).toBe(0);
    expect(r.exits()).toBe(0);
    expect(r.cleanups()).toBe(0);
    // It is logged, so a survived condition is not invisible.
    expect(r.survived).toEqual([{ code: "57014" }]);
  });

  test("a 57P01 rejection degrades and starts the retry backoff, without exiting", () => {
    const r = recordingEffects();
    createUnhandledRejectionHandler(r.effects)({ code: "57P01" });

    expect(r.degradeCount()).toBe(1);
    expect(r.retryStarts()).toBe(1);
    expect(r.exits()).toBe(0);
    expect(r.cleanups()).toBe(0);
  });

  test("a programming bug cleans up and exits", () => {
    const r = recordingEffects();
    createUnhandledRejectionHandler(r.effects)(new TypeError("x is not a function"));

    expect(r.exits()).toBe(1);
    expect(r.cleanups()).toBe(1);
    expect(r.degradeCount()).toBe(0);
    expect(r.survived).toEqual([]);
  });

  test("a second degradation stops the first retry loop rather than stacking one", () => {
    const r = recordingEffects();
    const handle = createUnhandledRejectionHandler(r.effects);

    handle({ code: "ECIRCUITBREAKER" });
    handle({ code: "ECIRCUITBREAKER" });

    expect(r.retryStarts()).toBe(2);
    expect(r.retryStops()).toBe(1);
  });

  test("a survived rejection does not stop an in-flight retry loop", () => {
    const r = recordingEffects();
    const handle = createUnhandledRejectionHandler(r.effects);

    handle({ code: "08006" });
    handle({ code: "57014" });

    expect(r.retryStarts()).toBe(1);
    expect(r.retryStops()).toBe(0);
  });
});
