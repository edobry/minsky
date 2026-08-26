/**
 * Tests for the shared verify-script preflight (mt#4149).
 *
 * Two layers, deliberately:
 *
 *  - **Injected-`fetch` classification tests** pin the absent/slow/reached split
 *    deterministically, including the case that produced this task (a target that
 *    answers correctly but past its budget).
 *  - **Real-`fetch` binding tests** exercise the same classifier against a live
 *    `Bun.serve` and a port with nothing listening. They are what establishes
 *    that the error-shape discrimination actually holds in the runtime the
 *    scripts run in — an injected rejection proves only that the classifier reads
 *    the shape the test invented for it.
 */
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_HEALTH_BUDGET_MS,
  DEFAULT_REACH_BUDGET_MS,
  DEFAULT_SLOW_CONFIRM_BUDGET_MS,
  EXIT_INCOMPLETE,
  exitCodeForVerdict,
  HEALTH_BUDGET_ENV,
  isBudgetAbort,
  isDefinitelyAbsent,
  probeReachability,
  readHealthBody,
  REACH_BUDGET_ENV,
  resolveBudgets,
  SLOW_CONFIRM_BUDGET_ENV,
  verdictForReach,
  type FetchLike,
} from "./verify-preflight";

/** What `AbortSignal.timeout` rejects with — observed shape, not invented. */
function timeoutError(): DOMException {
  return new DOMException("The operation timed out.", "TimeoutError");
}

/** Bun's `code` for a connect that never landed. Observed, not invented. */
const CONNECTION_REFUSED_CODE = "ConnectionRefused";

/** What Bun rejects with when nothing is listening — observed shape. */
function connectionRefused(): Error {
  const err = new Error("Unable to connect. Is the computer able to access the url?");
  (err as Error & { code?: string }).code = CONNECTION_REFUSED_CODE;
  return err;
}

/** Bun's `code` for a socket that was accepted and then reset. Observed, not invented. */
const CONNECTION_RESET_CODE = "ECONNRESET";

/**
 * What Bun rejects with when a listener accepts the socket and then tears it
 * down. Observed shape (mt#4624) — the message is Bun's verbatim.
 */
function connectionReset(): Error {
  const err = new Error("The socket connection was closed unexpectedly.");
  (err as Error & { code?: string }).code = CONNECTION_RESET_CODE;
  return err;
}

const DESCRIBE = { absentReason: "no cockpit reachable at http://x", slowSubject: "the cockpit" };

describe("resolveBudgets", () => {
  it("falls back to the budgets the twelve copied scripts used", () => {
    const result = resolveBudgets({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.budgets).toEqual({
      reachMs: DEFAULT_REACH_BUDGET_MS,
      healthMs: DEFAULT_HEALTH_BUDGET_MS,
      slowConfirmMs: DEFAULT_SLOW_CONFIRM_BUDGET_MS,
    });
  });

  it("takes each budget from its own env var", () => {
    const result = resolveBudgets({
      [REACH_BUDGET_ENV]: "12000",
      [HEALTH_BUDGET_ENV]: "18000",
      [SLOW_CONFIRM_BUDGET_ENV]: "45000",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.budgets).toEqual({ reachMs: 12000, healthMs: 18000, slowConfirmMs: 45000 });
  });

  it("rejects a malformed budget instead of silently using the default", () => {
    // The silent-fallback version of this is the same defect one level up: an
    // operator who set a budget and got the default anyway would be looking at
    // a skip they thought they had raised the budget past.
    const result = resolveBudgets({ [REACH_BUDGET_ENV]: "30s" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(REACH_BUDGET_ENV);
    expect(result.message).toContain("30s");
  });

  it("rejects a non-positive budget", () => {
    expect(resolveBudgets({ [HEALTH_BUDGET_ENV]: "0" }).ok).toBe(false);
    expect(resolveBudgets({ [HEALTH_BUDGET_ENV]: "-1" }).ok).toBe(false);
  });
});

describe("isBudgetAbort", () => {
  it("recognizes the abort our own budget produces", () => {
    expect(isBudgetAbort(timeoutError())).toBe(true);
    expect(isBudgetAbort(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("does not treat a connection failure as a budget abort", () => {
    expect(isBudgetAbort(connectionRefused())).toBe(false);
    expect(isBudgetAbort(new TypeError("boom"))).toBe(false);
    expect(isBudgetAbort(undefined)).toBe(false);
  });
});

describe("isDefinitelyAbsent (mt#4624)", () => {
  it("recognizes the code Bun emits when nothing is listening", () => {
    expect(isDefinitelyAbsent(connectionRefused())).toBe(true);
  });

  it("does NOT treat a reset socket as absent — it reached a listener", () => {
    expect(isDefinitelyAbsent(connectionReset())).toBe(false);
  });

  it("defaults unknown failures to NOT-absent, so an unrecognized code fails closed", () => {
    // The allowlist direction is the point: a Bun release inventing a code we
    // have never seen must not silently become `skip` + exit 0.
    const novel = new Error("something new") as Error & { code?: string };
    novel.code = "ESOMETHINGNEW";
    expect(isDefinitelyAbsent(novel)).toBe(false);
    expect(isDefinitelyAbsent(new TypeError("boom"))).toBe(false);
    expect(isDefinitelyAbsent(timeoutError())).toBe(false);
    expect(isDefinitelyAbsent(undefined)).toBe(false);
  });
});

describe("probeReachability (classification)", () => {
  it("reports reached, with the elapsed time, when a response arrives in budget", async () => {
    let clock = 1000;
    const outcome = await probeReachability(
      "http://target",
      { budgetMs: 3000, confirmBudgetMs: 30000 },
      {
        fetchImpl: async () => {
          clock += 172;
          return {};
        },
        now: () => clock,
      }
    );
    expect(outcome).toEqual({ kind: "reached", elapsedMs: 172 });
  });

  it("reports absent when nothing is listening", async () => {
    const outcome = await probeReachability(
      "http://target",
      { budgetMs: 3000, confirmBudgetMs: 30000 },
      {
        fetchImpl: async () => {
          throw connectionRefused();
        },
      }
    );
    expect(outcome.kind).toBe("absent");
    if (outcome.kind !== "absent") return;
    expect(outcome.detail).toContain(CONNECTION_REFUSED_CODE);
  });

  it("stays slow — never absent — when the first socket is reset and the confirm answers", async () => {
    // mt#4624: a reset says the connection broke, not that nothing is listening.
    // The confirm answering proves the target was there the whole time.
    let clock = 1000;
    let attempt = 0;
    const outcome = await probeReachability(
      "http://target",
      { budgetMs: 3000, confirmBudgetMs: 30000 },
      {
        fetchImpl: async () => {
          attempt += 1;
          if (attempt === 1) throw connectionReset();
          clock += 41;
          return {};
        },
        now: () => clock,
      }
    );
    expect(outcome.kind).toBe("slow");
    if (outcome.kind !== "slow") return;
    expect(outcome.measuredMs).toBe(41);
    // The interruption is carried, not discarded — reporting it as plain
    // slowness would hide the only fact that explains the first failure.
    expect(outcome.detail).toContain(CONNECTION_RESET_CODE);
  });

  it("stays slow — never absent — for an unrecognized failure code", async () => {
    // Fail-closed: a code the allowlist has never seen must not become
    // `skip` + exit 0. Asserted with an injected error because there is no real
    // socket condition that produces an arbitrary novel code.
    const novel = new Error("brand new failure") as Error & { code?: string };
    novel.code = "ESOMETHINGNEW";
    const outcome = await probeReachability(
      "http://target",
      { budgetMs: 3000, confirmBudgetMs: 30000 },
      {
        fetchImpl: async () => {
          throw novel;
        },
      }
    );
    expect(outcome.kind).toBe("slow");
    if (outcome.kind !== "slow") return;
    expect(outcome.measuredMs).toBeNull();
    expect(outcome.detail).toContain("ESOMETHINGNEW");
  });

  it("reports slow — with the measured latency — for a target that answers past its budget", async () => {
    // The mt#4071 observation, reproduced: the target IS there and IS correct,
    // it just took 20.1s against a 3000ms budget. The old `reachable()` returned
    // false here and the caller exited 0.
    let clock = 0;
    let call = 0;
    const fetchImpl: FetchLike = async () => {
      call += 1;
      if (call === 1) throw timeoutError();
      clock += 20_134;
      return {};
    };
    const outcome = await probeReachability(
      "http://target",
      { budgetMs: 3000, confirmBudgetMs: 30000 },
      { fetchImpl, now: () => clock }
    );
    expect(outcome).toEqual({
      kind: "slow",
      budgetMs: 3000,
      measuredMs: 20_134,
      confirmBudgetMs: 30000,
    });
  });

  it("stays slow — never absent — when even the measuring probe does not complete", async () => {
    // The verdict was already settled by the first budget miss; the follow-up is
    // diagnostic only, so nothing it returns may flip a non-zero exit to zero.
    const outcome = await probeReachability(
      "http://target",
      { budgetMs: 3000, confirmBudgetMs: 30000 },
      {
        fetchImpl: async () => {
          throw timeoutError();
        },
      }
    );
    expect(outcome.kind).toBe("slow");
    if (outcome.kind !== "slow") return;
    expect(outcome.measuredMs).toBeNull();
  });

  it("stays slow even if the target disappears between the two probes", async () => {
    let call = 0;
    const outcome = await probeReachability(
      "http://target",
      { budgetMs: 3000, confirmBudgetMs: 30000 },
      {
        fetchImpl: async () => {
          call += 1;
          throw call === 1 ? timeoutError() : connectionRefused();
        },
      }
    );
    expect(outcome.kind).toBe("slow");
  });
});

describe("verdictForReach", () => {
  it("gives absent and slow DIFFERENT exit codes", () => {
    const absent = verdictForReach({ kind: "absent", detail: "ConnectionRefused" }, DESCRIBE);
    const slow = verdictForReach(
      { kind: "slow", budgetMs: 3000, measuredMs: 20_134, confirmBudgetMs: 30000 },
      DESCRIBE
    );

    expect(absent.action).toBe("skip");
    expect(slow.action).toBe("incomplete");
    expect(exitCodeForVerdict(absent)).toBe(0);
    expect(exitCodeForVerdict(slow)).toBe(EXIT_INCOMPLETE);
    expect(exitCodeForVerdict(absent)).not.toBe(exitCodeForVerdict(slow));
  });

  it("keeps the caller's absent wording, so today's SKIP lines are unchanged", () => {
    const verdict = verdictForReach({ kind: "absent", detail: "x" }, DESCRIBE);
    expect(verdict.action).toBe("skip");
    if (verdict.action !== "skip") return;
    expect(verdict.message).toBe("no cockpit reachable at http://x");
  });

  it("names the measured latency, the budget, and how to raise it", () => {
    const verdict = verdictForReach(
      { kind: "slow", budgetMs: 3000, measuredMs: 20_134, confirmBudgetMs: 30000 },
      DESCRIBE
    );
    expect(verdict.action).toBe("incomplete");
    if (verdict.action !== "incomplete") return;
    expect(verdict.message).toContain("20134ms");
    expect(verdict.message).toContain("3000ms");
    expect(verdict.message).toContain("NOT performed");
    expect(verdict.message).toContain(REACH_BUDGET_ENV);
  });

  it("says so explicitly when the latency could not be measured", () => {
    const verdict = verdictForReach(
      { kind: "slow", budgetMs: 3000, measuredMs: null, confirmBudgetMs: 30000, detail: "gone" },
      DESCRIBE
    );
    expect(verdict.action).toBe("incomplete");
    if (verdict.action !== "incomplete") return;
    expect(verdict.message).toContain("still had not answered 30000ms later");
    expect(verdict.message).toContain("gone");
  });

  it("proceeds on a reached target", () => {
    expect(verdictForReach({ kind: "reached", elapsedMs: 12 }, DESCRIBE)).toEqual({
      action: "proceed",
    });
  });
});

describe("readHealthBody", () => {
  it("returns the parsed body", async () => {
    const outcome = await readHealthBody("http://target/api/health", 5000, {
      fetchImpl: async () => ({ json: async () => ({ service: "minsky-cockpit" }) }),
    });
    expect(outcome).toEqual({ kind: "body", body: { service: "minsky-cockpit" } });
  });

  it("distinguishes the second budget being missed from an unparseable answer", async () => {
    const slow = await readHealthBody("http://target/api/health", 5000, {
      fetchImpl: async () => {
        throw timeoutError();
      },
    });
    expect(slow).toEqual({ kind: "slow", budgetMs: 5000 });

    const unreadable = await readHealthBody("http://target/api/health", 5000, {
      fetchImpl: async () => ({
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      }),
    });
    expect(unreadable.kind).toBe("unreadable");
    if (unreadable.kind !== "unreadable") return;
    expect(unreadable.detail).toContain("Unexpected token");
  });
});

describe("probeReachability (real fetch binding)", () => {
  it("classifies a live-but-over-budget target as slow, not absent", async () => {
    // The budget sits below the target's response time — but the response time
    // has to be made observable to get there. Measured 2026-08-16: an immediate
    // `Bun.serve` handler over loopback answers in UNDER 1ms, so even a 1ms
    // budget is met and the probe reports `reached`. Hence the small handler
    // delay: 50ms against a 5ms budget is a 10x margin that costs the suite
    // 50ms, rather than a budget large enough to make the test slow.
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(50);
        return new Response("ok");
      },
    });
    try {
      const outcome = await probeReachability(
        `http://127.0.0.1:${server.port}/`,
        { budgetMs: 5, confirmBudgetMs: 5000 },
        {}
      );
      expect(outcome.kind).toBe("slow");
      if (outcome.kind !== "slow") return;
      // The follow-up measurement succeeded against a real server, so the report
      // carries a latency rather than only a lower bound.
      expect(outcome.measuredMs).not.toBeNull();
    } finally {
      server.stop(true);
    }
  });

  it("classifies a port with nothing listening as absent", async () => {
    // Bind an ephemeral port, then close it, and probe THAT — rather than
    // asserting some well-known port is unbound. A hardcoded port is a claim
    // about the environment the suite happens to run in (PR #3013 R1: container
    // and CI shims can answer, or route, a privileged port differently); a port
    // the OS just handed us and we just released is a claim about this process.
    const doomed = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const closedPort = doomed.port;
    doomed.stop(true);

    const outcome = await probeReachability(
      `http://127.0.0.1:${closedPort}/`,
      { budgetMs: 3000, confirmBudgetMs: 5000 },
      {}
    );
    expect(outcome.kind).toBe("absent");
  });

  it("classifies a listener that resets the socket as slow, not absent", async () => {
    // mt#4624's defect, against a REAL socket rather than an injected shape.
    // `Bun.listen` + `terminate()` on open accepts the connection and tears it
    // down, which is what produced the `ECONNRESET` observed in the wild — and it
    // does so deterministically, unlike the ~1-in-5400 load-dependent original.
    //
    // Something IS listening here. Before this fix the probe reported `absent`,
    // which `verdictForReach` maps to `skip` + exit 0 — a check reported as
    // skipped when it was actually never performed.
    const resetter = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => socket.terminate(),
        data: () => {},
      },
    });
    try {
      const outcome = await probeReachability(
        `http://127.0.0.1:${resetter.port}/`,
        { budgetMs: 3000, confirmBudgetMs: 3000 },
        {}
      );
      expect(outcome.kind).toBe("slow");
      if (outcome.kind !== "slow") return;
      expect(outcome.detail).toContain(CONNECTION_RESET_CODE);
      // The consequence that actually matters: a non-zero exit, so no caller
      // downstream can read this as a performed-and-passed check.
      const verdict = verdictForReach(outcome, DESCRIBE);
      expect(verdict.action).toBe("incomplete");
      expect(exitCodeForVerdict(verdict)).toBe(EXIT_INCOMPLETE);
    } finally {
      resetter.stop(true);
    }
  });

  it("classifies a live, fast target as reached", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      const outcome = await probeReachability(
        `http://127.0.0.1:${server.port}/`,
        { budgetMs: 3000, confirmBudgetMs: 5000 },
        {}
      );
      expect(outcome.kind).toBe("reached");
    } finally {
      server.stop(true);
    }
  });
});
