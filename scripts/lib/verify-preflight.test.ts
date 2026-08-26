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
  type ReachOutcome,
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

/**
 * Render an outcome for comparison against an EXPECTED kind, folding `detail`
 * into the compared value only when the kind does NOT match (mt#4550).
 *
 * Why not a bare `expect(outcome.kind).toBe(...)`: that renders
 * `Expected: "slow" / Received: "absent"` and discards the one field that
 * explains it. `describeError` has already built that string by the time the
 * outcome exists — the assertion is where it gets thrown away.
 *
 * That is not hypothetical. mt#4550's originating occurrence, in a full gated
 * run on 2026-08-25, recorded exactly those two lines and nothing else. Naming
 * the error took a separate investigation that had to reproduce the failure
 * from scratch; the run that saw it first had the answer in hand and dropped it.
 *
 * Folding `detail` in ONLY on mismatch is load-bearing: since mt#4624 a correct
 * `slow` can legitimately carry a `detail` (an interrupted first probe), so
 * folding it in unconditionally would fail a passing case.
 */
function kindOrCause(outcome: ReachOutcome, expected: ReachOutcome["kind"]): string {
  if (outcome.kind === expected) return expected;
  const detail = (outcome as { detail?: string }).detail;
  return detail === undefined ? outcome.kind : `${outcome.kind}: ${detail}`;
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

describe("kindOrCause — the assertion helper itself (mt#4550)", () => {
  // A self-naming assertion that names nothing is worse than a bare one: it
  // reads as though the evidence problem were solved. So the helper gets its
  // own coverage rather than being trusted because it looks right.

  it("returns the bare kind on a match, even when the outcome carries a detail", () => {
    // The passing case must be unaffected. Since mt#4624 a CORRECT `slow` can
    // carry a detail (an interrupted first probe), so a helper that folded it in
    // unconditionally would fail this — which is the whole reason for the guard.
    const slowWithDetail: ReachOutcome = {
      kind: "slow",
      budgetMs: 5,
      measuredMs: 41,
      confirmBudgetMs: 5000,
      detail: "first attempt: reset",
    };
    expect(kindOrCause(slowWithDetail, "slow")).toBe("slow");
  });

  it("folds the detail into the compared value on a mismatch — the whole point", () => {
    const absentWithCause: ReachOutcome = {
      kind: "absent",
      detail: "The socket connection was closed unexpectedly. (ECONNRESET)",
    };
    // This is what mt#4550's originating failure would have printed as
    // `Received:` had the assertion been written this way.
    expect(kindOrCause(absentWithCause, "slow")).toBe(
      "absent: The socket connection was closed unexpectedly. (ECONNRESET)"
    );
  });

  it("falls back to the bare kind on a mismatch with no detail to report", () => {
    expect(kindOrCause({ kind: "reached", elapsedMs: 12 }, "slow")).toBe("reached");
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

  it("lets OUR budget abort win over the absence allowlist, whatever code it carries", async () => {
    // PR #3372 R1. `isBudgetAbort` reads `name`, `isDefinitelyAbsent` reads
    // `code`, and one error can carry both — a proxy or a rethrowing wrapper can
    // stamp a connect code onto an abort. Asking the allowlist first would turn
    // our own timeout into `absent` + exit 0, the exact fail-open this task
    // exists to close. Order is behaviour, so it gets a test.
    // A plain Error rather than a DOMException, because `DOMException.code` is a
    // readonly accessor and cannot be stamped — which is itself the point: the
    // realistic carrier of both fields is a wrapper that rethrows, and what it
    // rethrows is an ordinary Error.
    const abortWearingAConnectCode = new Error("The operation timed out.") as Error & {
      code?: string;
    };
    abortWearingAConnectCode.name = "TimeoutError";
    abortWearingAConnectCode.code = CONNECTION_REFUSED_CODE;
    expect(isBudgetAbort(abortWearingAConnectCode)).toBe(true);
    expect(isDefinitelyAbsent(abortWearingAConnectCode)).toBe(true);

    let clock = 1000;
    let attempt = 0;
    const outcome = await probeReachability(
      "http://target",
      { budgetMs: 3000, confirmBudgetMs: 30000 },
      {
        fetchImpl: async () => {
          attempt += 1;
          if (attempt === 1) throw abortWearingAConnectCode;
          clock += 88;
          return {};
        },
        now: () => clock,
      }
    );
    expect(outcome.kind).toBe("slow");
    if (outcome.kind !== "slow") return;
    expect(outcome.measuredMs).toBe(88);
    // A budget abort is not an interruption either — nothing to annotate.
    expect(outcome.detail).toBeUndefined();
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
      // mt#4550: compared through `kindOrCause` so a future mismatch names the
      // error instead of reporting only `Received: "absent"`. This is the test
      // whose 2026-08-25 failure recorded no cause at all.
      expect(kindOrCause(outcome, "slow")).toBe("slow");
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
    expect(kindOrCause(outcome, "absent")).toBe("absent");
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
      expect(kindOrCause(outcome, "slow")).toBe("slow");
      if (outcome.kind !== "slow") return;
      // Deliberately NOT coupled to Bun's exact code string (PR #3372 R1): the
      // behaviour under test is the CLASSIFICATION, so assert the outcome and
      // that the interruption was named at all. The exact strings are pinned
      // once, on purpose, by the canary describe below.
      expect(outcome.detail).toMatch(/^first attempt: /);
      expect(outcome.detail).toMatch(/closed|reset/i);
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
      expect(kindOrCause(outcome, "reached")).toBe("reached");
    } finally {
      server.stop(true);
    }
  });
});

/**
 * The one place that couples to Bun's exact `code` strings — on purpose.
 *
 * `isDefinitelyAbsent`'s allowlist is a literal string match, so PRODUCTION
 * correctness depends on these codes, not just the tests. Pinning them here
 * keeps the coupling in a single named place instead of scattered through the
 * behaviour tests (PR #3372 R1), and a Bun upgrade that renames one fails HERE,
 * with a name that says what actually moved.
 *
 * Deliberately NOT gated on `Bun.version`, contrary to the review's suggestion:
 * a version-gated canary stops checking on exactly the version where the premise
 * may have changed, which is the one run where you need it. Note the failure
 * direction is safe either way — a renamed absent-code makes `isDefinitelyAbsent`
 * stop matching, so everything becomes `slow`/`EXIT_INCOMPLETE`. Noisy, never a
 * silent exit 0.
 */
describe("Bun's error surface — canary for the isDefinitelyAbsent allowlist (mt#4624)", () => {
  it("emits ConnectionRefused when nothing is listening", async () => {
    const doomed = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const closedPort = doomed.port;
    doomed.stop(true);

    const err = await fetch(`http://127.0.0.1:${closedPort}/`, {
      signal: AbortSignal.timeout(3000),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).not.toBeNull();
    expect((err as Error & { code?: string }).code).toBe(CONNECTION_REFUSED_CODE);
    // The premise the production allowlist rests on, asserted directly.
    expect(isDefinitelyAbsent(err)).toBe(true);
  });

  it("emits ECONNRESET — NOT an absent code — when a listener resets the socket", async () => {
    const resetter = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => socket.terminate(),
        data: () => {},
      },
    });
    try {
      const err = await fetch(`http://127.0.0.1:${resetter.port}/`, {
        signal: AbortSignal.timeout(3000),
      }).then(
        () => null,
        (e: unknown) => e
      );
      expect(err).not.toBeNull();
      expect((err as Error & { code?: string }).code).toBe(CONNECTION_RESET_CODE);
      // The whole point of mt#4624: this reached a listener, so it is not absent.
      expect(isDefinitelyAbsent(err)).toBe(false);
      expect(isBudgetAbort(err)).toBe(false);
    } finally {
      resetter.stop(true);
    }
  });
});
