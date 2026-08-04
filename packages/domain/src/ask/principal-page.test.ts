/**
 * Tests for the severity → principal page transport (mt#3595).
 *
 * The controls that matter here are the NEGATIVE ones. A mechanism that pages
 * on a severity ask is easy to get right; the ways this class fails in practice
 * are paging when it should not (reaper escalations, non-operator routing) and
 * paging twice. Those get the most coverage.
 */

import { describe, expect, it } from "bun:test";
import type { Ask } from "./types";
import {
  PAGE_RATE_LIMIT_MAX,
  PAGE_RATE_LIMIT_WINDOW_MS,
  buildPageMessage,
  decidePrincipalPage,
  excerptQuestion,
  pagePrincipalForAsk,
  type PageMessage,
  type PrincipalPageDeps,
  type PrincipalPageRepo,
} from "./principal-page";

const NOW = new Date("2026-08-03T20:00:00.000Z");

/** Suppression reason asserted by both no-severity cases. */
const NOT_SEVERITY_MARKED = "not-severity-marked";

/** Stand-in delivery failure, in the shape notifyPrincipal actually returns. */
const DELIVERY_ERROR = "not-configured: no chat id";

function makeAsk(overrides: Partial<Ask> = {}): Ask {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    shortId: "6575",
    kind: "authorization.approve",
    classifierVersion: "v1.0.0",
    state: "suspended",
    requestor: "minsky.agent:test",
    routingTarget: "operator",
    title: "Reviewer is down",
    question: "The reviewer has been failing every review: 429 no credits remaining.",
    createdAt: NOW.toISOString(),
    metadata: {},
    ...overrides,
  } as Ask;
}

/** Records what was sent and what failed, without any transport. */
function makeDeps(
  overrides: Partial<PrincipalPageDeps> = {}
): PrincipalPageDeps & { sent: PageMessage[]; failures: string[] } {
  const sent: PageMessage[] = [];
  const failures: string[] = [];
  return {
    sent,
    failures,
    async send(message) {
      sent.push(message);
      return { delivered: true };
    },
    async recordFailure(_ask, error) {
      failures.push(error);
    },
    now: () => NOW,
    ...overrides,
  };
}

/** Minimal repo honoring the same claim-once rule the real backends do. */
function makeRepo(initial: Ask, recentPageCount = 0): PrincipalPageRepo & { ask: Ask } {
  const state = { ask: initial };
  return {
    get ask() {
      return state.ask;
    },
    async claimPrincipalPage(id, at) {
      if (state.ask.id !== id) throw new Error(`Ask not found: ${id}`);
      if (state.ask.principalPagedAt) return { claimed: false, ask: state.ask };
      state.ask = { ...state.ask, principalPagedAt: at.toISOString() };
      return { claimed: true, ask: state.ask };
    },
    async countPrincipalPagesSince() {
      return recentPageCount;
    },
  };
}

describe("decidePrincipalPage", () => {
  it("sends for a severity-marked, operator-routed, never-paged ask", () => {
    const d = decidePrincipalPage(makeAsk({ severity: "incident" }), { recentPageCount: 0 });
    expect(d).toEqual({ send: true, reason: "send" });
  });

  it("does not send when no severity marker is present", () => {
    const d = decidePrincipalPage(makeAsk(), { recentPageCount: 0 });
    expect(d.send).toBe(false);
    expect(d.reason).toBe(NOT_SEVERITY_MARKED);
  });

  it("does not send when the ask is not routed to the operator", () => {
    // A severity ask routed to a subagent has no human on the other end;
    // paging would spend the principal's attention on something nobody asked
    // them to act on.
    const d = decidePrincipalPage(
      makeAsk({ severity: "incident", routingTarget: "subagent" as Ask["routingTarget"] }),
      { recentPageCount: 0 }
    );
    expect(d.send).toBe(false);
    expect(d.reason).toBe("not-operator-routed");
  });

  it("does not send when a page is already recorded", () => {
    const d = decidePrincipalPage(
      makeAsk({ severity: "incident", principalPagedAt: NOW.toISOString() }),
      { recentPageCount: 0 }
    );
    expect(d.send).toBe(false);
    expect(d.reason).toBe("already-paged");
  });

  it("suppresses at the rate-limit ceiling and reports the count", () => {
    const d = decidePrincipalPage(makeAsk({ severity: "incident" }), {
      recentPageCount: PAGE_RATE_LIMIT_MAX,
    });
    expect(d.send).toBe(false);
    expect(d.reason).toBe("rate-limited");
    expect(d.recentPageCount).toBe(PAGE_RATE_LIMIT_MAX);
  });

  it("still sends one below the ceiling", () => {
    const d = decidePrincipalPage(makeAsk({ severity: "incident" }), {
      recentPageCount: PAGE_RATE_LIMIT_MAX - 1,
    });
    expect(d.send).toBe(true);
  });

  it("pages on severity alone, with no forceImmediate (the fields are independent)", () => {
    // The rule tells authors to set both, so it must be unambiguous that
    // neither gates the other: `severity` decides whether the principal is
    // NOTIFIED, `forceImmediate` only decides whether the ask waits for a
    // service window. A reader who assumed forceImmediate was a precondition
    // would under-notify; this pins the direction the docs claim.
    const d = decidePrincipalPage(makeAsk({ severity: "incident", forceImmediate: false }), {
      recentPageCount: 0,
    });
    expect(d.send).toBe(true);
  });

  it("does NOT page a reaper-escalated ask (forceImmediate without severity)", () => {
    // The decision this test pins: the service-window reaper sets
    // forceImmediate autonomously on window-miss. If paging were bound to that
    // field, every reaper escalation would buzz the phone as a side effect
    // nobody decided on. Acceptance Test 6 in the spec.
    const d = decidePrincipalPage(makeAsk({ forceImmediate: true }), { recentPageCount: 0 });
    expect(d.send).toBe(false);
    expect(d.reason).toBe(NOT_SEVERITY_MARKED);
  });
});

describe("buildPageMessage", () => {
  it("carries the short-id label with the uuid as the link target", () => {
    // cockpit-deeplinks.mdc: short ids are a LABEL form; the uuid is the sole
    // deeplink target, so a link built on the short id would not resolve.
    const m = buildPageMessage(makeAsk({ severity: "incident" }));
    expect(m.message).toContain("[ask#6575]");
    expect(m.message).toContain("minsky://ask/11111111-2222-3333-4444-555555555555");
    expect(m.message).not.toContain("minsky://ask/ask#");
  });

  it("falls back to an id prefix when the ask has no short id", () => {
    const m = buildPageMessage(makeAsk({ severity: "incident", shortId: undefined }));
    expect(m.message).toContain("[11111111]");
  });

  it("routes to the parent task's topic when the ask names one", () => {
    const m = buildPageMessage(makeAsk({ severity: "incident", parentTaskId: "mt#3433" }));
    expect(m.taskId).toBe("mt#3433");
  });

  it("omits taskId entirely when the ask has no parent task", () => {
    expect(buildPageMessage(makeAsk({ severity: "incident" })).taskId).toBeUndefined();
  });
});

describe("excerptQuestion", () => {
  it("collapses whitespace to a single line", () => {
    expect(excerptQuestion("a\n\n  b\tc")).toBe("a b c");
  });

  it("truncates over-long questions with an ellipsis", () => {
    const out = excerptQuestion("x".repeat(500));
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves a short question untouched", () => {
    expect(excerptQuestion("short one")).toBe("short one");
  });
});

describe("pagePrincipalForAsk", () => {
  it("sends exactly one page and records the claim", async () => {
    const ask = makeAsk({ severity: "incident" });
    const repo = makeRepo(ask);
    const deps = makeDeps();

    const outcome = await pagePrincipalForAsk(ask, repo, deps);

    expect(outcome).toEqual({ sent: true, reason: "send" });
    expect(deps.sent).toHaveLength(1);
    expect(repo.ask.principalPagedAt).toBe(NOW.toISOString());
  });

  it("does not page twice for the same ask", async () => {
    const ask = makeAsk({ severity: "incident" });
    const repo = makeRepo(ask);
    const deps = makeDeps();

    await pagePrincipalForAsk(ask, repo, deps);
    // Re-run with the ask as the repo now holds it — the shape a repeated
    // create or a later edit produces.
    const second = await pagePrincipalForAsk(repo.ask, repo, deps);

    expect(second.sent).toBe(false);
    expect(second.reason).toBe("already-paged");
    expect(deps.sent).toHaveLength(1);
  });

  it("does not send a second page when the claim is lost to a concurrent caller", async () => {
    // The pre-read says un-paged, but the claim loses. Only the conditional
    // write can catch this; a read-then-write would double-notify.
    const ask = makeAsk({ severity: "incident" });
    const repo: PrincipalPageRepo = {
      async claimPrincipalPage(_id, _at) {
        return { claimed: false, ask: { ...ask, principalPagedAt: NOW.toISOString() } };
      },
      async countPrincipalPagesSince() {
        return 0;
      },
    };
    const deps = makeDeps();

    const outcome = await pagePrincipalForAsk(ask, repo, deps);

    expect(outcome.reason).toBe("already-paged");
    expect(deps.sent).toHaveLength(0);
  });

  it("records a delivery failure instead of throwing", async () => {
    const ask = makeAsk({ severity: "incident" });
    const repo = makeRepo(ask);
    const deps = makeDeps({
      async send() {
        return { delivered: false, error: DELIVERY_ERROR };
      },
    });

    const outcome = await pagePrincipalForAsk(ask, repo, deps);

    expect(outcome.sent).toBe(false);
    expect(outcome.reason).toBe("delivery-failed");
    expect(outcome.error).toBe(DELIVERY_ERROR);
    expect(deps.failures).toEqual([DELIVERY_ERROR]);
  });

  it("suppresses at the ceiling and surfaces the dropped count", async () => {
    const ask = makeAsk({ severity: "incident" });
    const repo = makeRepo(ask, PAGE_RATE_LIMIT_MAX);
    const deps = makeDeps();

    const outcome = await pagePrincipalForAsk(ask, repo, deps);

    expect(outcome.sent).toBe(false);
    expect(outcome.reason).toBe("rate-limited");
    expect(outcome.recentPageCount).toBe(PAGE_RATE_LIMIT_MAX);
    expect(deps.sent).toHaveLength(0);
  });

  it("pages anyway when the rate-limit counter itself fails", async () => {
    // Fail OPEN: a limiter that cannot read its counter must not become the
    // reason an incident goes unreported. The failure is still recorded.
    const ask = makeAsk({ severity: "incident" });
    const repo: PrincipalPageRepo = {
      async claimPrincipalPage(_id, at) {
        return { claimed: true, ask: { ...ask, principalPagedAt: at.toISOString() } };
      },
      async countPrincipalPagesSince() {
        throw new Error("db down");
      },
    };
    const deps = makeDeps();

    const outcome = await pagePrincipalForAsk(ask, repo, deps);

    expect(outcome.sent).toBe(true);
    expect(deps.sent).toHaveLength(1);
    expect(deps.failures[0]).toContain("db down");
  });

  it("never touches the repository for an ask with no severity marker", async () => {
    // The common path by an enormous margin — it must not cost a query.
    let queried = false;
    const ask = makeAsk();
    const repo: PrincipalPageRepo = {
      async claimPrincipalPage() {
        throw new Error("must not claim");
      },
      async countPrincipalPagesSince() {
        queried = true;
        return 0;
      },
    };
    const deps = makeDeps();

    const outcome = await pagePrincipalForAsk(ask, repo, deps);

    expect(outcome.reason).toBe("not-severity-marked");
    expect(queried).toBe(false);
    expect(deps.sent).toHaveLength(0);
  });

  it("replays the 2026-07-31 reviewer-outage ask and pages", async () => {
    // Acceptance Test 4: the R1 ask (cb89ecf1 / ask#6575) as it was actually
    // filed — authorization.approve, incident vocabulary, operator-routed —
    // with the severity marker this task adds.
    const ask = makeAsk({
      severity: "incident",
      kind: "authorization.approve",
      question:
        "The reviewer bot has been failing every review since 02:30Z: " +
        "429 You have no credits remaining. Top up at the billing page to restore it.",
      parentTaskId: "mt#3433",
    });
    const repo = makeRepo(ask);
    const deps = makeDeps();

    const outcome = await pagePrincipalForAsk(ask, repo, deps);

    expect(outcome.sent).toBe(true);
    expect(deps.sent[0]?.message).toContain("ask#6575");
    expect(deps.sent[0]?.taskId).toBe("mt#3433");
  });
});

describe("rate-limit constants", () => {
  it("uses the project's 24h burst-detection window", () => {
    expect(PAGE_RATE_LIMIT_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});
