/**
 * Tests for the decision-group + staleness helpers (mt#2882).
 *
 * Fixtures mirror the 2026-07-16 live-audit queue shapes: five
 * authorization.approve asks sharing one PR anchor (gh#1761), two
 * direction.decide asks sharing a task anchor (mt#2505), and singletons.
 */
import { describe, expect, test } from "bun:test";
import {
  groupAsks,
  askSubject,
  inlineActionsFor,
  consequenceSnippet,
  isStanding,
  STANDING_AGE_MS,
} from "./ask-groups";
import type { AskItem } from "../widgets/AskDetail";

const AUTH_KIND = "authorization.approve" as const;
const DECIDE_KIND = "direction.decide" as const;

const NOW = new Date("2026-07-17T12:00:00Z").getTime();

function ask(overrides: Partial<AskItem> & Pick<AskItem, "id" | "kind" | "createdAt">): AskItem {
  return {
    state: "routed",
    title: `Ask ${overrides.id}`,
    question: "q",
    requestor: "fixture-agent",
    windowMissedCount: 0,
    metadata: {},
    ...overrides,
  } as AskItem;
}

describe("isStanding", () => {
  test("open >24h is standing; younger is not", () => {
    expect(
      isStanding({ createdAt: new Date(NOW - STANDING_AGE_MS - 1000).toISOString() }, NOW)
    ).toBe(true);
    expect(isStanding({ createdAt: new Date(NOW - 60_000).toISOString() }, NOW)).toBe(false);
  });
});

describe("askSubject", () => {
  test("parent task ref is the anchor; absent means ungroupable", () => {
    expect(askSubject({ parentTaskId: "gh#1761" })).toBe("gh#1761");
    expect(askSubject({ parentTaskId: undefined })).toBeNull();
  });
});

describe("groupAsks", () => {
  const fiveAuth = Array.from({ length: 5 }, (_, i) =>
    ask({
      id: `auth-${i}`,
      kind: AUTH_KIND,
      parentTaskId: "gh#1761",
      createdAt: new Date(NOW - (30 - i) * 24 * 60 * 60 * 1000).toISOString(),
    })
  );
  const twoDecide = [
    ask({
      id: "dec-0",
      kind: DECIDE_KIND,
      parentTaskId: "mt#2505",
      createdAt: "2026-06-17T00:00:00Z",
    }),
    ask({
      id: "dec-1",
      kind: DECIDE_KIND,
      parentTaskId: "mt#2505",
      createdAt: "2026-06-19T00:00:00Z",
    }),
  ];
  const singleton = ask({
    id: "solo",
    kind: "quality.review",
    createdAt: "2026-07-17T11:00:00Z",
  });

  test("live-audit queue collapses 8 asks into 3 decision groups", () => {
    const groups = groupAsks([...fiveAuth, ...twoDecide, singleton], NOW);
    expect(groups.length).toBe(3);
    const auth = groups.find((g) => g.subject === "gh#1761");
    expect(auth?.asks.length).toBe(5);
    const decide = groups.find((g) => g.subject === "mt#2505");
    expect(decide?.asks.length).toBe(2);
  });

  test("group members sort oldest-first; oldestCreatedAt tracks the true oldest", () => {
    const groups = groupAsks([...twoDecide].reverse(), NOW);
    const g = groups[0];
    expect(g?.asks[0]?.id).toBe("dec-0");
    expect(g?.oldestCreatedAt).toBe("2026-06-17T00:00:00Z");
  });

  test("standing counts accumulate per group", () => {
    const groups = groupAsks(fiveAuth, NOW);
    expect(groups[0]?.standingCount).toBe(5);
  });

  test("same kind, different subjects do NOT merge", () => {
    const other = ask({
      id: "auth-other",
      kind: AUTH_KIND,
      parentTaskId: "mt#999",
      createdAt: "2026-07-17T11:00:00Z",
    });
    const groups = groupAsks([...fiveAuth, other], NOW);
    expect(groups.length).toBe(2);
  });

  test("subject-less asks stay singleton groups", () => {
    const a = ask({ id: "a", kind: "quality.review", createdAt: "2026-07-17T10:00:00Z" });
    const b = ask({ id: "b", kind: "quality.review", createdAt: "2026-07-17T11:00:00Z" });
    const groups = groupAsks([a, b], NOW);
    expect(groups.length).toBe(2);
  });
});

describe("consequenceSnippet", () => {
  test("takes the lead sentence when a boundary lands within the cap", () => {
    expect(
      consequenceSnippet("Approves push to prod config. Reversible via rollback within 5m.")
    ).toBe("Approves push to prod config.");
  });

  test("truncates a long single-sentence lead with an ellipsis", () => {
    const long = `Authorize commit in session abc: ${"x".repeat(200)}`;
    const out = consequenceSnippet(long);
    expect(out.length).toBeLessThanOrEqual(141);
    expect(out.endsWith("…")).toBe(true);
  });

  test("skips leading blank lines", () => {
    expect(consequenceSnippet("\n\nDo the thing.")).toBe("Do the thing.");
  });
});

describe("inlineActionsFor", () => {
  test("explicit options render as lettered resolve actions + Defer", () => {
    const actions = inlineActionsFor({
      kind: DECIDE_KIND,
      options: [
        { label: "Ship it", value: "ship" },
        { label: "Hold", value: "hold" },
      ],
    });
    expect(actions.map((a) => a.label)).toEqual(["Ship it", "Hold", "Defer"]);
    expect(actions[0]).toMatchObject({ action: "resolve", optionLetter: "A" });
    expect(actions[1]).toMatchObject({ action: "resolve", optionLetter: "B" });
    expect(actions[2]).toMatchObject({ action: "defer" });
  });

  test("optionless authorization asks get Approve(A)/Deny(B)/Defer — matching the resolve payload contract", () => {
    const actions = inlineActionsFor({ kind: AUTH_KIND, options: undefined });
    expect(actions.map((a) => a.label)).toEqual(["Approve", "Deny", "Defer"]);
    expect(actions[0]?.optionLetter).toBe("A");
    expect(actions[1]?.optionLetter).toBe("B");
  });

  test("optionless quality.review asks label B as Request changes — AskDetail contract (PR #2027 R1)", () => {
    const actions = inlineActionsFor({ kind: "quality.review", options: undefined });
    expect(actions.map((a) => a.label)).toEqual(["Approve", "Request changes", "Defer"]);
    expect(actions[1]?.optionLetter).toBe("B");
  });
});
