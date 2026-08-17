/* eslint-disable custom/no-real-fs-in-tests -- the mt#3620 handoff tests exercise the real turn-end-scan-store roundtrip (Stop writes -> prompt-time reads) in an isolated mkdtemp dir, mirroring turn-end-untaken-action-scan.test.ts's precedent */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFERRAL_MENU_PATTERNS,
  MENU_SHAPE_REQUIRED_PATTERNS,
  detectDeferralPhrases,
  findOfferShape,
  hasMenuShape,
  namesAgentAction,
  lineAt,
  turnHasAsksCreate,
  elideQuotedContexts,
  buildReminder,
  ASKS_CREATE_TOOL,
  INJECTION_ENABLED,
  OVERRIDE_ENV_VAR,
  SUPPRESSION_ASKS_CREATE_THIS_TURN,
  SUPPRESSION_STOP_GUARD_ALREADY_INJECTED,
  resolveStopOverlap,
  run,
  type DeferralMatch,
} from "./ask-routing-deferral-detector";
import { run as runUntakenAction } from "./turn-end-untaken-action-scan";
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
    const m: DeferralMatch[] = [
      {
        cls: PRINCIPAL_RESERVED,
        matchedPhrase: "needs your call",
        context: "Naming the surface needs your call.",
      },
    ];
    const reminder = buildReminder(m);
    expect(reminder).toContain("asks_create");
    expect(reminder).toContain("direction.decide");
  });

  test("deferral-menu reminder routes through classify-before-deferring", () => {
    const m: DeferralMatch[] = [
      {
        cls: DEFERRAL_MENU,
        matchedPhrase: "what's your call?",
        context: "I could do A or B — what's your call?",
      },
    ];
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

/**
 * mt#3620 — the Stop→prompt handoff, end to end.
 *
 * The originating incident (2026-08-03): a turn closed with "Say the word and
 * I'll do it", offering to restart a daemon rather than probing whether it
 * needed restarting at all. The Stop guard detected it and then suppressed its
 * own injection under mt#3336's dedup, yielding to THIS detector — which runs
 * on `UserPromptSubmit` and therefore could not speak until the principal had
 * already read the deferral and replied. These tests pin the inverted contract:
 * the Stop guard speaks, and this one goes quiet about that same sentence.
 */
describe("mt#3620 — Stop guard speaks first, this guard defers to it", () => {
  const INCIDENT_CLOSING_SENTENCE =
    "The running cockpit needs a main pull plus a daemon restart. Say the word and I'll do it.";
  const SESSION = "mt3620-handoff";

  let storeDir: string;
  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "mt3620-handoff-"));
  });
  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  function promptInput(): ClaudeHookInput {
    return { ...RUN_HOOK_INPUT, session_id: SESSION };
  }

  test("the Stop guard injects about the incident's closing sentence", () => {
    const outcome = runUntakenAction(
      { session_id: SESSION, last_assistant_message: INCIDENT_CLOSING_SENTENCE } as never,
      { event: "Stop" } as never,
      storeDir
    );
    expect(outcome?.additionalContext).toBeDefined();
  });

  test("this guard then stays quiet about the same sentence — one injection, not two", () => {
    runUntakenAction(
      { session_id: SESSION, last_assistant_message: INCIDENT_CLOSING_SENTENCE } as never,
      { event: "Stop" } as never,
      storeDir
    );

    const lines = [
      makeRunUserLine(),
      makeRunAssistantLine(INCIDENT_CLOSING_SENTENCE),
      makeRunUserLine(),
    ];
    const outcome = run(promptInput(), makeCtx(lines), storeDir);

    // Still RECORDED — the overlap has to stay measurable — but not injected.
    expect(outcome?.calibration).toBeDefined();
    expect((outcome?.calibration as { suppressionReasons: string[] }).suppressionReasons).toContain(
      SUPPRESSION_STOP_GUARD_ALREADY_INJECTED
    );
    expect(outcome?.additionalContext).toBeUndefined();
  });

  test("without a prior Stop fire, this guard injects as before", () => {
    const lines = [
      makeRunUserLine(),
      makeRunAssistantLine(INCIDENT_CLOSING_SENTENCE),
      makeRunUserLine(),
    ];
    const outcome = run(promptInput(), makeCtx(lines), storeDir);
    expect(outcome?.additionalContext).toBeDefined();
  });

  // PR #2574 R1 — the decision both entrypoints share, tested directly. `main()`
  // ends in `process.exit`, so driving it in-process is not practical; testing
  // the function it delegates to covers the CLI path's behaviour without it.
  describe("resolveStopOverlap (shared by run() and main())", () => {
    function matchesFor(text: string): DeferralMatch[] {
      return detectDeferralPhrases(text);
    }

    test("suppressedAll when the Stop guard covered every matched phrase", () => {
      runUntakenAction(
        { session_id: SESSION, last_assistant_message: INCIDENT_CLOSING_SENTENCE } as never,
        { event: "Stop" } as never,
        storeDir
      );
      const result = resolveStopOverlap(
        SESSION,
        INCIDENT_CLOSING_SENTENCE,
        matchesFor(INCIDENT_CLOSING_SENTENCE),
        storeDir
      );
      expect(result.suppressedAll).toBe(true);
      expect(result.remaining).toEqual([]);
    });

    // R1 BLOCKING: `?? "unknown"` put every id-less session in one shared bucket,
    // where one session's Stop fire could silence another's real deferral.
    test("an ABSENT session_id disables the dedup rather than sharing an 'unknown' bucket", () => {
      runUntakenAction(
        { session_id: "unknown", last_assistant_message: INCIDENT_CLOSING_SENTENCE } as never,
        { event: "Stop" } as never,
        storeDir
      );
      const result = resolveStopOverlap(
        undefined,
        INCIDENT_CLOSING_SENTENCE,
        matchesFor(INCIDENT_CLOSING_SENTENCE),
        storeDir
      );
      expect(result.suppressedAll).toBe(false);
      expect(result.remaining.length).toBeGreaterThan(0);
    });

    test("no Stop fire -> nothing suppressed", () => {
      const result = resolveStopOverlap(
        SESSION,
        INCIDENT_CLOSING_SENTENCE,
        matchesFor(INCIDENT_CLOSING_SENTENCE),
        storeDir
      );
      expect(result.suppressedAll).toBe(false);
    });

    test("zero matches is not 'suppressed' — there was nothing to say", () => {
      const result = resolveStopOverlap(SESSION, INCIDENT_CLOSING_SENTENCE, [], storeDir);
      expect(result.suppressedAll).toBe(false);
    });
  });

  test("a DIFFERENT turn's deferral is unaffected by the flag", () => {
    runUntakenAction(
      { session_id: SESSION, last_assistant_message: INCIDENT_CLOSING_SENTENCE } as never,
      { event: "Stop" } as never,
      storeDir
    );
    const lines = [
      makeRunUserLine(),
      makeRunAssistantLine("The rail-axis question needs your call before anything gets encoded."),
      makeRunUserLine(),
    ];
    const outcome = run(promptInput(), makeCtx(lines), storeDir);
    expect(outcome?.additionalContext).toBeDefined();
  });
});

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

  /** A turn that defers nothing — no deferral phrase in any class. */
  const NO_DEFERRAL_TURN = "I merged the PR and the task is DONE.";
  /** A turn that defers a principal-reserved decision. */
  const PRINCIPAL_RESERVED_TURN = "The rail-axis question needs your call.";

  test("no match -> null (silent allow)", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(NO_DEFERRAL_TURN),
      makeRunUserLine(),
    ];
    expect(run(RUN_HOOK_INPUT, makeCtx(transcriptLines))).toBeNull();
  });

  // mt#3207: this used to assert `null`. The gate returned BEFORE detection
  // ran, so a suppressed deferral was indistinguishable from a clean turn and
  // the gate looked costless to the sweep. It now records and stays silent.
  test("suppressed when the turn already routed via asks_create -> records, no injection", () => {
    const transcriptLines: TranscriptLine[] = [
      makeRunUserLine(),
      makeRunAssistantLine(PRINCIPAL_RESERVED_TURN),
      { type: "tool_use", name: ASKS_CREATE_TOOL } as unknown as TranscriptLine,
      makeRunUserLine(),
    ];
    const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
    expect(outcome?.additionalContext).toBeUndefined();
    const cal = outcome?.calibration as { suppressionReasons: string[] };
    expect(cal.suppressionReasons).toEqual([SUPPRESSION_ASKS_CREATE_THIS_TURN]);
  });

  test("mt#3207: an INJECTED fire records an empty suppressionReasons, not an absent one", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(PRINCIPAL_RESERVED_TURN),
      makeRunUserLine(),
    ];
    const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
    expect(outcome?.additionalContext).toBeDefined();
    const cal = outcome?.calibration as { suppressionReasons: string[] };
    expect(cal.suppressionReasons).toEqual([]);
  });

  test("mt#3207: a turn that routed an ask and deferred NOTHING still records nothing", () => {
    const transcriptLines: TranscriptLine[] = [
      makeRunUserLine(),
      makeRunAssistantLine(NO_DEFERRAL_TURN),
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

  // The mt#3801 refactor moved these four legs into MENU_SHAPE_LEGS so one
  // declaration serves both the gate and the trigger. Pin all four here: the
  // case above covers two, and a leg silently dropped in the move would leave
  // the gate quietly narrower with nothing failing.
  test("all four menu-shape legs survive the MENU_SHAPE_LEGS refactor (mt#3801)", () => {
    expect(hasMenuShape("do X?")).toBe(true);
    expect(hasMenuShape("take A or B")).toBe(true);
    expect(hasMenuShape("I'll hold unless told otherwise")).toBe(true);
    expect(hasMenuShape("go ahead if you'd rather")).toBe(true);
    expect(hasMenuShape("merged and green")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mt#3801 — the OFFER shape as a first-class trigger.
//
// The originating sentence closed a turn by proposing a next step and handing
// the choice over. It matched no entry in either deferral corpus, so this
// detector stayed silent and the Stop sibling emitted the COMMITMENT directive
// ("take it now") for a sentence whose defect was offering rather than acting.
//
// The fix is a conjunction over two constituents this file already had, not a
// ninth phrase — see `findOfferShape`.
// ---------------------------------------------------------------------------

/** Verbatim from the 2026-08-05 incident turn (R9 of the family, mem#831). */
const OFFER_SHAPE_MESSAGE =
  "Next step is /plan-task mt#3799 unless you'd rather I go straight at it.";

/** AT4's negative control: `unless` as a factual qualifier, with no actor. */
const FACTUAL_UNLESS =
  "The migration ran cleanly unless a row was locked, in which case it retried.";

describe("offer-shape trigger (mt#3801)", () => {
  test("AT1: the originating sentence now fires the menu class", () => {
    const matches = detectDeferralPhrases(OFFER_SHAPE_MESSAGE);
    expect(matches.some((m) => m.cls === DEFERRAL_MENU)).toBe(true);
  });

  test("AT4: a factual `unless` with no actor stays quiet", () => {
    expect(detectDeferralPhrases(FACTUAL_UNLESS)).toEqual([]);
  });

  // The conjunction, asserted on its own rather than only through its effect.
  // This is what makes AT4 a real control: the menu leg MATCHES the negative
  // control, so promoting `hasMenuShape` unguarded would fire on it. Measured,
  // not argued.
  test("the guarding conjunction is menu-shape AND an agent-action clause", () => {
    expect(hasMenuShape(FACTUAL_UNLESS)).toBe(true);
    expect(namesAgentAction(FACTUAL_UNLESS)).toBe(false);
    expect(findOfferShape(FACTUAL_UNLESS)).toBeNull();

    expect(hasMenuShape(OFFER_SHAPE_MESSAGE)).toBe(true);
    expect(namesAgentAction(OFFER_SHAPE_MESSAGE)).toBe(true);
    expect(findOfferShape(OFFER_SHAPE_MESSAGE)).not.toBeNull();
  });

  // Every agent-action form is non-past by construction. A first-person REPORT
  // beside a menu token is not an offer, and this is the case a naive "does the
  // line mention `I`?" predicate would get wrong.
  test("a past-tense first-person report beside `unless` does NOT fire", () => {
    expect(namesAgentAction("I fixed the migration unless a row was locked.")).toBe(false);
    expect(detectDeferralPhrases("I fixed the migration unless a row was locked.")).toEqual([]);
  });

  test("each agent-action form is recognized", () => {
    expect(namesAgentAction("I'll take it")).toBe(true);
    expect(namesAgentAction("I can take it")).toBe(true);
    expect(namesAgentAction("you'd rather I go")).toBe(true);
    expect(namesAgentAction("want me to file it")).toBe(true);
    expect(namesAgentAction("the sweep retried it")).toBe(false);
  });

  // PR #3088 R1 (BLOCKING) — the patterns match the SHAPE of a first-person
  // action clause, and that shape is identical whether the agent is offering to
  // act or saying it will not. Every case below satisfies `hasMenuShape` via a
  // bare `unless`, so without the polarity check the conjunction fires on all
  // of them — into a LIVE-injecting guard. The reviewer named two; the rest are
  // the same class, found by scanning for it rather than waiting to be handed
  // each one.
  describe("polarity: a negated clause is not an offer (PR #3088 R1)", () => {
    const NOT_OFFERS = [
      // The reviewer's two, verbatim.
      "There is no need for me to rerun this unless the logs show errors.",
      "It would be unusual for me to change that, unless you prefer otherwise.",
      // Same class, found by scanning: `\b` sits between `can` and `'t`, so the
      // modal leg matched the contraction.
      "I can't reproduce it unless you give me the log.",
      "I won't touch it unless you say so.",
      "I shouldn't merge it unless CI is green.",
      "I would not rerun it unless the logs show errors.",
    ];

    test.each(NOT_OFFERS)("does not name an agent action: %s", (line) => {
      // Asserted alongside the menu leg, so a future change that makes these
      // pass by breaking `hasMenuShape` instead cannot be mistaken for a fix.
      expect(hasMenuShape(line)).toBe(true);
      expect(namesAgentAction(line)).toBe(false);
      expect(findOfferShape(line)).toBeNull();
    });

    // The control that makes the block above meaningful: the near-identical
    // POSITIVE forms must keep firing. `"I can take it"` and `"I can't
    // reproduce it"` differ by two characters.
    test.each([
      "Next step is /plan-task mt#3799 unless you'd rather I go straight at it.",
      "I can take it now unless you'd rather review first.",
      "Do you want me to file it, or should I hold?",
    ])("still fires on the offer it is meant to catch: %s", (line) => {
      expect(namesAgentAction(line)).toBe(true);
      expect(findOfferShape(line)).not.toBeNull();
    });

    // `for` is the DESCRIPTIVE object form and was dropped from the alternation
    // outright, so it is quiet even without a negator anywhere in the sentence.
    test("the bare `for me to` form is not an agent-action clause at all", () => {
      expect(namesAgentAction("It is cheaper for me to batch these unless you object.")).toBe(
        false
      );
      expect(namesAgentAction("want me to batch these")).toBe(true);
    });
  });

  // Line-scoped, for the reason lineAt records: a menu token and an
  // agent-action clause in different paragraphs were not said in one breath.
  test("the two constituents must land on the SAME line", () => {
    expect(
      findOfferShape("Merged and green. I can take mt#3799 next unless you'd rather stop.")
    ).not.toBeNull();
    // Menu token on line 1, agent-action clause on line 2 — no offer.
    expect(findOfferShape("Anything else?\nI can take mt#3799 next.")).toBeNull();
  });

  // A deliberate boundary, not an oversight. The INVERTED modal ("Should I file
  // it?") is a permission-ask question, and it is already the literal corpus's
  // territory — `PERMISSION_DEFERRAL_PATTERNS` carries `/(shall|should)\s+I/`
  // on the surface where it matters. Adding it here would widen a live guard
  // past the class this task measured, so the trigger stays on the declarative
  // offer shape and the question form keeps its existing owner.
  test("the inverted-modal question form is left to the literal corpus", () => {
    expect(namesAgentAction("Should I file it separately?")).toBe(false);
  });

  // The phrase field feeds the sweep's diversity axis, which decides when this
  // log gets reviewed. A per-turn-unique phrase would make every record
  // distinct and stall the review trigger — so the trigger reports a stable
  // label, never the matched sentence.
  test("the reported phrase is a stable low-cardinality label, not the sentence", () => {
    const [match] = detectDeferralPhrases(OFFER_SHAPE_MESSAGE);
    expect(match?.matchedPhrase).toBe("offer-shape:unless");
    expect(match?.matchedPhrase).not.toContain("mt#3799");
    // The sentence is still recoverable — it lives in `context`, which is what
    // a calibration reviewer classifies from.
    expect(match?.context).toContain("straight at it");
  });

  // Additive by construction: the structural trigger runs only when the literal
  // corpus produced nothing for this class, so no pre-existing record changes
  // shape. "I'll stop here unless you want more" satisfies BOTH, and must keep
  // reporting the literal phrase it has always reported.
  test("a literal menu match keeps its own phrase — the trigger runs second", () => {
    const [match] = detectDeferralPhrases("I'll stop here unless you want more.");
    expect(match?.matchedPhrase).toBe("I'll stop here");
  });

  test("the offer shape reaches the ask-routing suppression unchanged", () => {
    // Quoted discussion OF the shape must not fire it — the same elision the
    // literal corpus gets, since the trigger runs over the elided copy.
    expect(detectDeferralPhrases(`The phrase "unless you'd rather I go" is on the list.`)).toEqual(
      []
    );
  });

  // KNOWN MISS, pinned deliberately so it is a recorded decision rather than an
  // untested belief. Closing it means widening `hasMenuShape`, which is also
  // the pause/stop suppression gate — the false-positive direction on a
  // live-injecting guard. See that function's docblock.
  test("known miss: a comma before `or` is not recognized as a disjunction", () => {
    const commaOr = "Next step is mt#3799, or I can go straight at it.";
    expect(namesAgentAction(commaOr)).toBe(true);
    expect(hasMenuShape(commaOr)).toBe(false);
    expect(findOfferShape(commaOr)).toBeNull();
  });
});
