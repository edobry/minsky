import { describe, expect, test } from "bun:test";
import {
  detectDeferralPhrases,
  turnHasAsksCreate,
  elideQuotedContexts,
  buildReminder,
  ASKS_CREATE_TOOL,
  INJECTION_ENABLED,
  type DeferralMatch,
} from "./ask-routing-deferral-detector";
import type { TranscriptLine } from "./transcript";

const PRINCIPAL_RESERVED = "principal-reserved" as const;
const DEFERRAL_MENU = "deferral-menu" as const;

// ---------------------------------------------------------------------------
// PRINCIPAL-RESERVED sub-class
// ---------------------------------------------------------------------------

describe("principal-reserved deferral phrases", () => {
  const cases = [
    "that decision is his before any lens model gets encoded",
    "the rail-axis question needs your call",
    "you decide which axis is primary",
    "reserved for Eugene to decide",
    "I'm surfacing this to you for a decision",
    "waiting on your decision before proceeding",
  ];
  for (const phrase of cases) {
    test(`matches: "${phrase}"`, () => {
      const matches = detectDeferralPhrases(phrase);
      expect(matches.some((m) => m.cls === PRINCIPAL_RESERVED)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// DEFERRAL-MENU sub-class (the 2026-06-11 post-closeout incident shape)
// ---------------------------------------------------------------------------

describe("deferral-menu phrases", () => {
  const cases = [
    "What's your call?",
    "say the word and I'll set it CLOSED",
    "I recommend we stop here",
    "I'll stop here unless you want more",
    "Want me to resume mt#2369 or start fresh?",
    "Nothing is dropped if we do nothing",
  ];
  for (const phrase of cases) {
    test(`matches: "${phrase}"`, () => {
      const matches = detectDeferralPhrases(phrase);
      expect(matches.some((m) => m.cls === DEFERRAL_MENU)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Negative cases — ordinary collaborative prose must NOT fire
// ---------------------------------------------------------------------------

describe("non-deferral prose does not fire", () => {
  const cases = [
    "I merged the PR and the task is DONE.",
    "Running the tests now; all 10 pass.",
    "The advancement sweep drained the backlog to zero detected.",
    "Next I'll plan mt#2471 per the agreed sequence.",
  ];
  for (const phrase of cases) {
    test(`no match: "${phrase}"`, () => {
      expect(detectDeferralPhrases(phrase).length).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Quoted/code-context suppression — describing the pattern must NOT fire
// ---------------------------------------------------------------------------

describe("quoted/code contexts are elided", () => {
  test("inline code span with a trigger phrase does not fire", () => {
    const text = "The detector matches the phrase `needs your call` in prose.";
    expect(detectDeferralPhrases(text).length).toBe(0);
  });

  test("fenced code block with a trigger phrase does not fire", () => {
    const text = ["Example pattern:", "```", "what's your call?", "```", "done."].join("\n");
    expect(detectDeferralPhrases(text).length).toBe(0);
  });

  test("blockquote with a trigger phrase does not fire", () => {
    const text = "> that decision is his\n\nThat was the prior incident's shape.";
    expect(detectDeferralPhrases(text).length).toBe(0);
  });

  test("elideQuotedContexts preserves length (offset stability)", () => {
    const text = "a `needs your call` b";
    expect(elideQuotedContexts(text).length).toBe(text.length);
  });
});

// ---------------------------------------------------------------------------
// asks_create suppression
// ---------------------------------------------------------------------------

describe("turnHasAsksCreate", () => {
  test("true when an asks_create tool_use is present", () => {
    const turn: TranscriptLine[] = [
      { type: "tool_use", name: ASKS_CREATE_TOOL } as unknown as TranscriptLine,
    ];
    expect(turnHasAsksCreate(turn)).toBe(true);
  });

  test("false when no asks_create tool_use is present", () => {
    const turn: TranscriptLine[] = [
      { type: "tool_use", name: "mcp__minsky__tasks_status_get" } as unknown as TranscriptLine,
    ];
    expect(turnHasAsksCreate(turn)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Walk tests — the originating incidents (R4 + 2026-06-11)
// ---------------------------------------------------------------------------

describe("originating-incident walk", () => {
  test("R4: mt#2372 rail-axis chat deferral fires principal-reserved", () => {
    const r4 =
      "mt#2372's rail-axis question needs your call before any lens model gets encoded — that decision is his.";
    const matches = detectDeferralPhrases(r4);
    expect(matches.some((m) => m.cls === PRINCIPAL_RESERVED)).toBe(true);
  });

  test("2026-06-11: post-closeout menu fires deferral-menu", () => {
    const incident = "mt#2394 is CLOSED. Want me to resume mt#2369 or stop here? What's your call?";
    const matches = detectDeferralPhrases(incident);
    expect(matches.some((m) => m.cls === DEFERRAL_MENU)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reminder + rollout gate
// ---------------------------------------------------------------------------

describe("reminder + calibration-first rollout", () => {
  test("calibration-first: INJECTION_ENABLED is false in v1", () => {
    expect(INJECTION_ENABLED).toBe(false);
  });

  test("principal-reserved reminder names asks_create", () => {
    const m: DeferralMatch[] = [{ cls: PRINCIPAL_RESERVED, matchedPhrase: "needs your call" }];
    const reminder = buildReminder(m);
    expect(reminder).toContain("asks_create");
    expect(reminder).toContain("direction.decide");
  });

  test("deferral-menu reminder routes through classify-before-deferring", () => {
    const m: DeferralMatch[] = [{ cls: DEFERRAL_MENU, matchedPhrase: "what's your call?" }];
    const reminder = buildReminder(m);
    expect(reminder).toContain("classify-before-deferring");
  });
});
