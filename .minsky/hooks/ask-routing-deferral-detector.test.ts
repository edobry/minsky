import { describe, expect, test } from "bun:test";
import {
  DEFERRAL_MENU_PATTERNS,
  MENU_SHAPE_REQUIRED_PATTERNS,
  detectDeferralPhrases,
  hasMenuShape,
  lineAt,
  turnHasAsksCreate,
  elideQuotedContexts,
  buildReminder,
  ASKS_CREATE_TOOL,
  INJECTION_ENABLED,
  OVERRIDE_ENV_VAR,
  run,
  type DeferralMatch,
} from "./ask-routing-deferral-detector";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";

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

describe("reminder + rollout gate", () => {
  test("gate flipped to live injection (mt#2694, operator-approved 2026-07-08)", () => {
    expect(INJECTION_ENABLED).toBe(true);
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

// ---------------------------------------------------------------------------
// run() — dispatcher-compatible pure function (ADR-028 D1/D2 — mt#2652)
//
// No real fs needed: run() reads ctx.transcriptLines directly (resolved
// once by the dispatcher's D6 shared context) rather than re-parsing a
// transcript_path itself — so transcriptLines is built in-memory here.
// ---------------------------------------------------------------------------

function makeRunUserLine(text = "test user message"): TranscriptLine {
  return { type: "user", message: { role: "user", content: text } } as TranscriptLine;
}

function makeRunAssistantLine(text: string): TranscriptLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as TranscriptLine;
}

const RUN_HOOK_EVENT_NAME = "UserPromptSubmit";

const RUN_HOOK_INPUT: ClaudeHookInput = {
  session_id: "test-session",
  transcript_path: "/mock/transcript.jsonl",
  cwd: "/test",
  hook_event_name: RUN_HOOK_EVENT_NAME,
};

function makeCtx(transcriptLines: TranscriptLine[]): DispatchContext {
  return {
    event: RUN_HOOK_EVENT_NAME,
    hostCapSec: 15,
    budgets: { overallBudgetMs: 9000, fetchTimeoutMs: 4950, gitTimeoutMs: 1530 },
    transcriptCandidates: ["/mock/transcript.jsonl"],
    transcriptLines,
  };
}

describe("run() (dispatcher-compatible)", () => {
  test("deferral match -> calibration record AND additionalContext (live injection, mt#2694)", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(
        "The rail-axis question needs your call before any lens model gets encoded."
      ),
      makeRunUserLine(),
    ];
    const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
    expect(outcome?.calibration).toBeDefined();
    expect(outcome?.additionalContext).toBeDefined();
    expect(outcome?.additionalContext).toContain("asks_create");
    const cal = outcome?.calibration as { matches: Array<{ class: string; phrase: string }> };
    expect(cal.matches.some((m) => m.class === PRINCIPAL_RESERVED)).toBe(true);
  });

  test("no match -> null (silent allow)", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine("I merged the PR and the task is DONE."),
      makeRunUserLine(),
    ];
    expect(run(RUN_HOOK_INPUT, makeCtx(transcriptLines))).toBeNull();
  });

  test("suppressed when the turn already routed via asks_create -> null", () => {
    const transcriptLines: TranscriptLine[] = [
      makeRunUserLine(),
      makeRunAssistantLine("The rail-axis question needs your call."),
      { type: "tool_use", name: ASKS_CREATE_TOOL } as unknown as TranscriptLine,
      makeRunUserLine(),
    ];
    expect(run(RUN_HOOK_INPUT, makeCtx(transcriptLines))).toBeNull();
  });

  test("no transcript_path -> null", () => {
    const input: ClaudeHookInput = {
      session_id: "test",
      cwd: "/test",
      hook_event_name: RUN_HOOK_EVENT_NAME,
    };
    const ctx = makeCtx([makeRunUserLine(), makeRunAssistantLine("x"), makeRunUserLine()]);
    expect(run(input, ctx)).toBeNull();
  });

  test("legacy override env var suppresses detection and returns an audit line", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine("What's your call?"),
      makeRunUserLine(),
    ];
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
      expect(outcome?.calibration).toBeUndefined();
      expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
    } finally {
      delete process.env[OVERRIDE_ENV_VAR];
    }
  });
});

// ---------------------------------------------------------------------------
// mt#3271 — quoted-prose elision + menu-shape gating for the pause/stop family
//
// The 2026-07-28T19:45:31Z fire on session `b5295d70` cited "I'll pause here"
// against a turn that never contained it. Replaying the real transcript showed
// two compounding defects: the scanned window was the PREVIOUS turn (mt#3280,
// the shared turn-extraction contract), and that window matched only because
// the phrase appeared as a double-quoted example in prose about the detector —
// a class `elideQuotedContexts` does not cover. This file fixes the second.
// ---------------------------------------------------------------------------

describe("quoted-prose elision (mt#3271)", () => {
  test("a trigger phrase quoted while discussing the detector does not fire", () => {
    const text =
      'The detector fired citing "I\'ll pause here" on a turn that never contained it. ' +
      'It also matches "Say the word" and "what\'s your call".';
    expect(detectDeferralPhrases(text)).toEqual([]);
  });

  test("curly-quoted mentions are elided too", () => {
    expect(detectDeferralPhrases("The phrase “say the word” is on the list.")).toEqual([]);
  });

  test("backtick and blockquote elision still works (no regression)", () => {
    expect(detectDeferralPhrases("The pattern `say the word` is matched.")).toEqual([]);
    expect(detectDeferralPhrases("> What's your call?")).toEqual([]);
  });

  test("an UNQUOTED deferral still fires — elision must not swallow real positives", () => {
    const matches = detectDeferralPhrases("Say the word and I'll take it.");
    expect(matches.some((m) => m.cls === DEFERRAL_MENU)).toBe(true);
  });
});

describe("menu-shape gating for pause/stop (mt#3271)", () => {
  test("bare pause/stop at turn end does not fire", () => {
    expect(detectDeferralPhrases("Merged and verified. I'll pause here.")).toEqual([]);
    expect(detectDeferralPhrases("That closes the queue. I'll stop here.")).toEqual([]);
  });

  test("recommend/suggest-we-stop is NOT gated — it hands a call over, it is not a report", () => {
    const matches = detectDeferralPhrases("I recommend we stop here.");
    expect(matches.some((m) => m.cls === DEFERRAL_MENU)).toBe(true);
  });

  test("`unless` counts as a menu shape — it offers a choice without asking", () => {
    const matches = detectDeferralPhrases("I'll stop here unless you want more.");
    expect(matches.some((m) => m.cls === DEFERRAL_MENU)).toBe(true);
  });

  test("pause/stop alongside an explicit question DOES fire", () => {
    const matches = detectDeferralPhrases("I'll pause here — should I take mt#A next?");
    expect(matches.some((m) => m.cls === DEFERRAL_MENU)).toBe(true);
  });

  test("pause/stop alongside an offered disjunction DOES fire", () => {
    const matches = detectDeferralPhrases("I'll stop here or keep going on the backlog.");
    expect(matches.some((m) => m.cls === DEFERRAL_MENU)).toBe(true);
  });

  test("a question in a DIFFERENT paragraph does not license a bare pause", () => {
    const text = "Should I file that separately?\n\nEither way, merged and green. I'll pause here.";
    const matches = detectDeferralPhrases(text);
    expect(matches.some((m) => m.matchedPhrase.toLowerCase().includes("pause here"))).toBe(false);
  });

  test("the real positives from the ask#6136 review still fire", () => {
    const cases = [
      "Say the word and I'll start.",
      "Want me to run it, or would you rather I park mt#3151 and pick up mt#3171 instead?",
      "Want me to check bot status on mt#3217 or dig into anything else?",
    ];
    for (const text of cases) {
      expect(detectDeferralPhrases(text).length).toBeGreaterThan(0);
    }
  });

  // PR #2359 R1: line-scoped, not paragraph-scoped — single-newline prose must
  // not collapse into one block where any question licenses a bare pause.
  test("a question on a different LINE does not license a bare pause (single newlines)", () => {
    const text = "Should I file that separately?\nEither way, merged and green. I'll pause here.";
    const matches = detectDeferralPhrases(text);
    expect(matches.some((m) => m.matchedPhrase.toLowerCase().includes("pause here"))).toBe(false);
  });

  // PR #2359 R1: the gate matches by object identity, so the gated pattern must
  // be the SAME object the menu list holds — not a copy with equal source.
  test("the gated pattern is shared by identity with DEFERRAL_MENU_PATTERNS", () => {
    for (const p of MENU_SHAPE_REQUIRED_PATTERNS) {
      expect(DEFERRAL_MENU_PATTERNS).toContain(p);
    }
  });

  test("hasMenuShape / lineAt behave as documented", () => {
    expect(hasMenuShape("plain sentence")).toBe(false);
    expect(hasMenuShape("do X?")).toBe(true);
    expect(hasMenuShape("take A or B")).toBe(true);
    expect(lineAt("one\n\ntwo\n\nthree", 6)).toBe("two");
  });
});
