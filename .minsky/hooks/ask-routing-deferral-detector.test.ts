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
  MAX_RENDERED_PHRASE_CHARS,
  citesFiledAsk,
  resolveAskCitation,
  SUPPRESSION_CITES_FILED_ASK,
  settlesDecision,
  resolveSettledDecision,
  SUPPRESSION_SETTLED_DECISION,
  ASKS_CREATE_TOOL,
  INJECTION_ENABLED,
  OVERRIDE_ENV_VAR,
  SUPPRESSION_ASKS_CREATE_THIS_TURN,
  SUPPRESSION_STOP_GUARD_ALREADY_INJECTED,
  resolveStopOverlap,
  run,
  resolveSettledDecisionRung2,
  SUPPRESSION_SETTLED_DECISION_RUNG2,
  SETTLED_DECISION_RUNG2_THRESHOLD,
  SETTLED_DECISION_EXEMPLARS,
  SETTLED_DECISION_EXEMPLAR_SET,
  SETTLED_DECISION_PATTERNS,
  isRung2NominationEnabled,
  RUNG2_NOMINATION_ENV_VAR,
  type DeferralMatch,
  type SettledDecisionNominator,
} from "./ask-routing-deferral-detector";
import { run as runUntakenAction } from "./turn-end-untaken-action-scan";
import { nominate } from "../../packages/domain/src/detectors/embedding-nomination";
import type { NominationDeps } from "../../packages/domain/src/detectors/embedding-nomination";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";

const PRINCIPAL_RESERVED = "principal-reserved" as const;
const DEFERRAL_MENU = "deferral-menu" as const;

/**
 * The canonical AT2 regression-floor turn: a genuine deferral, no decision
 * taken. Shared by the mt#4175 (Rung 1) and mt#4404 (Rung 2) blocks so the two
 * rungs are measured against the SAME floor case rather than two copies of it
 * that could drift apart.
 */
const UNSETTLED_TURN = "**Next.** Say the word and I'll plan any of the three.";

/** The degraded reason `resolveNominationDeps` produces when nothing is configured. */
const PROVIDER_UNCONFIGURED = "provider-unconfigured";

/** The degraded reason a `local`-hash-stub (non-semantic) provider produces. */
const NON_SEMANTIC_PROVIDER = "non-semantic-provider";

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
// mt#4483 — a negating complement inverts the phrase the matcher reports
// ---------------------------------------------------------------------------

describe("mt#4483 — a principal-reserved phrase negated by its own complement", () => {
  /**
   * The captured fire, verbatim from
   * `.minsky/ask-routing-deferral-calibration.jsonl` at 2026-08-23T18:34:29.951Z
   * (session 3f37535b), match `[principal-reserved/needs your call]`.
   */
  const CAPTURED_FIRE = "- **mt#4458 needs your call on nothing — it needs the daemon.";

  test("SC2: the captured fire produces no principal-reserved match", () => {
    const matches = detectDeferralPhrases(CAPTURED_FIRE);
    expect(matches.some((m) => m.cls === PRINCIPAL_RESERVED)).toBe(false);
  });

  for (const complement of ["on nothing", "for nothing", "about nothing"]) {
    test(`SC1: "${complement}" suppresses`, () => {
      const matches = detectDeferralPhrases(`mt#4458 needs your call ${complement}.`);
      expect(matches.some((m) => m.cls === PRINCIPAL_RESERVED)).toBe(false);
    });
  }

  // PR #3330 R1: punctuation between the phrase and its complement.
  for (const sep of ["—", "–", "-", ",", ":"]) {
    test(`PR #3330 R1: "${sep}" between phrase and complement still suppresses`, () => {
      const matches = detectDeferralPhrases(`mt#4458 needs your call${sep}on nothing.`);
      expect(matches.some((m) => m.cls === PRINCIPAL_RESERVED)).toBe(false);
    });
  }

  /**
   * The separator class must not swallow a clause boundary: after a period the
   * next words are a new assertion, not this phrase's complement.
   */
  test("PR #3330 R1: a clause-ending period does NOT bridge to the complement", () => {
    const matches = detectDeferralPhrases("mt#4458 needs your call. On nothing else does it wait.");
    expect(matches.some((m) => m.cls === PRINCIPAL_RESERVED)).toBe(true);
  });

  test("SC1: the complement match is case-insensitive", () => {
    const matches = detectDeferralPhrases("mt#4458 needs your call ON NOTHING.");
    expect(matches.some((m) => m.cls === PRINCIPAL_RESERVED)).toBe(false);
  });

  /**
   * SC3, load-bearing. Without this the fix is indistinguishable from deleting
   * the pattern: `needs your call` is the class's most-fired phrase, and a
   * suppression that swallows the un-negated form has removed the class rather
   * than narrowed it.
   */
  test("SC3 (negative control): the un-negated form still fires", () => {
    const matches = detectDeferralPhrases("mt#4458 needs your call on the daemon question.");
    expect(matches.some((m) => m.cls === PRINCIPAL_RESERVED)).toBe(true);
  });

  /**
   * The narrowing must not trade a false positive for a false negative. The
   * detector takes ONE match per class, so a naive "skip and move to the next
   * pattern" would drop the genuine second mention here.
   */
  test("a negated mention does not mask a genuine one later in the same turn", () => {
    const text =
      "mt#4458 needs your call on nothing — it needs the daemon. " +
      "But mt#4460 needs your call on the retention window.";
    const matches = detectDeferralPhrases(text);
    const principal = matches.find((m) => m.cls === PRINCIPAL_RESERVED);
    expect(principal).toBeDefined();
    expect(principal?.sentence).toContain("mt#4460");
  });

  /** SC1's stated non-coverage, pinned so a later widening is a deliberate edit. */
  test("sentence-level negation is NOT covered, deliberately", () => {
    const matches = detectDeferralPhrases("This does not need your call.");
    expect(matches.some((m) => m.cls === PRINCIPAL_RESERVED)).toBe(true);
  });

  /** SC4: the sibling class is untouched by this change. */
  test("SC4: deferral-menu still fires on a negated-complement turn", () => {
    const text = "mt#4458 needs your call on nothing. What's your call?";
    const matches = detectDeferralPhrases(text);
    expect(matches.some((m) => m.cls === PRINCIPAL_RESERVED)).toBe(false);
    expect(matches.some((m) => m.cls === DEFERRAL_MENU)).toBe(true);
  });
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
        sentence: "Naming the surface needs your call.",
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
        sentence: "I could do A or B — what's your call?",
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

  test("this guard then stays quiet about the same sentence — one injection, not two", async () => {
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
    const outcome = await run(promptInput(), makeCtx(lines), storeDir);

    // Still RECORDED — the overlap has to stay measurable — but not injected.
    expect(outcome?.calibration).toBeDefined();
    expect((outcome?.calibration as { suppressionReasons: string[] }).suppressionReasons).toContain(
      SUPPRESSION_STOP_GUARD_ALREADY_INJECTED
    );
    expect(outcome?.additionalContext).toBeUndefined();
  });

  test("without a prior Stop fire, this guard injects as before", async () => {
    const lines = [
      makeRunUserLine(),
      makeRunAssistantLine(INCIDENT_CLOSING_SENTENCE),
      makeRunUserLine(),
    ];
    const outcome = await run(promptInput(), makeCtx(lines), storeDir);
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

  test("a DIFFERENT turn's deferral is unaffected by the flag", async () => {
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
    const outcome = await run(promptInput(), makeCtx(lines), storeDir);
    expect(outcome?.additionalContext).toBeDefined();
  });
});

describe("run() (dispatcher-compatible)", () => {
  test("deferral match -> calibration record AND additionalContext (live injection, mt#2694)", async () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(
        "The rail-axis question needs your call before any lens model gets encoded."
      ),
      makeRunUserLine(),
    ];
    const outcome = await run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
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

  test("no match -> null (silent allow)", async () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(NO_DEFERRAL_TURN),
      makeRunUserLine(),
    ];
    expect(await run(RUN_HOOK_INPUT, makeCtx(transcriptLines))).toBeNull();
  });

  // mt#3207: this used to assert `null`. The gate returned BEFORE detection
  // ran, so a suppressed deferral was indistinguishable from a clean turn and
  // the gate looked costless to the sweep. It now records and stays silent.
  test("suppressed when the turn already routed via asks_create -> records, no injection", async () => {
    const transcriptLines: TranscriptLine[] = [
      makeRunUserLine(),
      makeRunAssistantLine(PRINCIPAL_RESERVED_TURN),
      { type: "tool_use", name: ASKS_CREATE_TOOL } as unknown as TranscriptLine,
      makeRunUserLine(),
    ];
    const outcome = await run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
    expect(outcome?.additionalContext).toBeUndefined();
    const cal = outcome?.calibration as { suppressionReasons: string[] };
    expect(cal.suppressionReasons).toEqual([SUPPRESSION_ASKS_CREATE_THIS_TURN]);
  });

  test("mt#3207: an INJECTED fire records an empty suppressionReasons, not an absent one", async () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(PRINCIPAL_RESERVED_TURN),
      makeRunUserLine(),
    ];
    const outcome = await run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
    expect(outcome?.additionalContext).toBeDefined();
    const cal = outcome?.calibration as { suppressionReasons: string[] };
    expect(cal.suppressionReasons).toEqual([]);
  });

  test("mt#3207: a turn that routed an ask and deferred NOTHING still records nothing", async () => {
    const transcriptLines: TranscriptLine[] = [
      makeRunUserLine(),
      makeRunAssistantLine(NO_DEFERRAL_TURN),
      { type: "tool_use", name: ASKS_CREATE_TOOL } as unknown as TranscriptLine,
      makeRunUserLine(),
    ];
    expect(await run(RUN_HOOK_INPUT, makeCtx(transcriptLines))).toBeNull();
  });

  test("no transcript_path -> null", async () => {
    const input: ClaudeHookInput = {
      session_id: "test",
      cwd: "/test",
      hook_event_name: RUN_HOOK_EVENT_NAME,
    };
    const ctx = makeCtx([makeRunUserLine(), makeRunAssistantLine("x"), makeRunUserLine()]);
    expect(await run(input, ctx)).toBeNull();
  });

  test("legacy override env var suppresses detection and returns an audit line", async () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine("What's your call?"),
      makeRunUserLine(),
    ];
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const outcome = await run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
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

// ---------------------------------------------------------------------------
// mt#4311 — a grammatical disjunction is not an offer
// ---------------------------------------------------------------------------

describe("mt#4311 — a bare first-person clause needs a leg that offers on its own", () => {
  /**
   * VERBATIM from the live calibration log, not from the task spec's excerpts.
   *
   * That distinction is the point. The spec quoted these contexts truncated at
   * the sentence, and seven of its ten quotes do not fire when replayed as
   * lines — so a fixture built from the quote would assert "produces no fire"
   * against text that never fired, passing before any change and proving
   * nothing (mem#704). Each line below is asserted to have fired under the
   * PRE-mt#4311 relation first, which is what makes the silence meaningful.
   */
  const REAL_FALSE_POSITIVES: ReadonlyArray<readonly [string, string]> = [
    [
      "caveat naming what was NOT done",
      "Caveat I'll state plainly, given what I just got wrong: this is one web search of secondary sources. I haven't read their docs or run the license checks.",
    ],
    [
      "a capability report with an unrelated disjunction",
      "The judge takes its completion service by constructor injection, so I can test the real prompt path with a stub rather than a test-only export or a spy.",
    ],
    [
      "an intent statement whose disjunction is the thing being diagnosed",
      "two strikes on the same tool, so I'll stop rather than retry a third time and check whether it's the tool or the server.",
    ],
  ];

  test.each(REAL_FALSE_POSITIVES)("fired before, silent after: %s", (_label, line) => {
    // The pre-mt#4311 relation, expressed in the two exported halves it was
    // built from. Asserting it FIRST is the negative control for this fixture.
    //
    // ITS LIMIT, since a recomposition is not a time machine (PR #3211 R1): this
    // is equivalent to the old predicate only while BOTH halves keep their
    // current semantics. They are unchanged by mt#4311 and pinned by their own
    // tests above, so the equivalence holds today; a future edit to either could
    // silently weaken this assertion into a tautology. The stronger check is the
    // corpus replay (`scripts/replay-offer-shape.ts`), which reads real records
    // rather than recomposing a predicate — these fixtures are the fast,
    // in-repo half of that measurement, not a substitute for it.
    expect(namesAgentAction(line) && hasMenuShape(line)).toBe(true);
    expect(findOfferShape(line)).toBeNull();
  });

  test("a GOVERNED clause still fires on a grammatical leg — the floor", () => {
    // `want me to` / `rather I` carry the reader's preference inside the
    // clause, so the disjunction or question mark is free to be the reporter.
    for (const line of [
      "Want me to take it?",
      "Want me to file those, or a subset?",
      "Recommended next: mt#4190, unless you'd rather I clear the ceiling first",
      "If you'd rather I just execute the answer here, say so",
    ]) {
      expect(findOfferShape(line)).not.toBeNull();
    }
  });

  test("mt#3801's own cases are untouched", () => {
    // A bare clause plus an EXPLICIT-OFFER leg is still an offer — this is the
    // shape mt#3801 shipped the trigger for, and narrowing must not reach it.
    expect(findOfferShape("I'll stop here unless you want more")).not.toBeNull();
    expect(findOfferShape("Next step is X unless you'd rather I do Y")).not.toBeNull();
  });

  test("subject-auxiliary inversion UPGRADES a bare clause, and admits nothing new", () => {
    // English inverts only to ask, and asking about one's own action offers it.
    const inverted =
      "So, in plain terms: should I stop letting my own writing count as evidence, or not? I can hold either way.";
    expect(findOfferShape(inverted)).not.toBeNull();

    // The upgrade runs only after a base pattern matched, so a line with an
    // inversion and NO agent-action clause stays invisible — `namesAgentAction`
    // is unchanged by this task.
    const noClause = "Should I be worried?";
    expect(namesAgentAction(noClause)).toBe(false);
    expect(findOfferShape(noClause)).toBeNull();
  });

  test("the leg LABELS are unchanged, so quoting specs and the sweep still resolve", () => {
    // mt#3959's stale-signal sweep fires when an operator-facing label stops
    // being emitted, and `offer-shape:or` is quoted in active specs. The `or`
    // leg still REPORTS; it just needs a governed clause to reach it.
    expect(findOfferShape("Want me to file those, or a subset?")?.label).toBe(
      "offer-shape:question"
    );
    expect(findOfferShape("unless you'd rather I clear it")?.label).toBe("offer-shape:unless");
    // The absence of a terminal `?` here is DELIBERATE, not an oversight
    // (PR #3211 R1 read it as brittle). `MENU_SHAPE_LEGS` checks `question`
    // before `or`, so a question mark anywhere on the line reports the question
    // leg and this assertion would pin nothing about `or`. A DECLARATIVE
    // disjunction is the only shape that reaches the `or` leg — and `or` is the
    // label the active specs quote and mt#3959's sweep would notice going quiet,
    // so it is the one that needs pinning.
    expect(findOfferShape("Do you want me to take mt#1 or mt#2 first")?.label).toBe(
      "offer-shape:or"
    );
  });

  test("hasMenuShape is deliberately NOT narrowed — it gates a different surface", () => {
    // It is also the pause/stop suppression gate, where a narrower menu shape
    // suppresses LESS and therefore fires MORE. Changing it here would move a
    // surface this task did not measure.
    expect(hasMenuShape("I can test this or that")).toBe(true);
    expect(hasMenuShape("Anything else?")).toBe(true);
  });
});

describe("rendered evidence is bounded by the phrase cap (mt#4234)", () => {
  // The defect: `buildReminder` interpolated `m.matchedPhrase`, which is `m[0]`
  // — the regex's whole matched span. Two patterns in this file bound their span
  // only by the next sentence terminator (`[^.?]*`), so the rendered advisory
  // grew 1:1 with whatever the agent happened to write. The declared 600-char
  // ceiling could not be a ceiling, because the axis had no finite worst case.

  /** One clause, no `.` or `?`, so the unbounded legs keep swallowing it. */
  const FILLER =
    "we could rebase onto main and re-run the sweep and then re-measure the fires " +
    "and then re-check the ceiling and then re-run the shape test";

  /** A run-on turn carrying BOTH classes, `reps` clauses long. */
  function runOnTurn(reps: number): string {
    const body = Array(reps).fill(FILLER).join(" and ");
    return `That decision is yours to make, so want me to ${body} or should we leave it?`;
  }

  // Named rather than inlined: `custom/no-magic-string-duplication` counts
  // repeated literals across the whole file, and this block would otherwise push
  // the class names past its threshold.
  const PRINCIPAL_RESERVED: DeferralMatch["cls"] = "principal-reserved";
  const DEFERRAL_MENU: DeferralMatch["cls"] = "deferral-menu";

  const match = (cls: DeferralMatch["cls"], phrase: string): DeferralMatch => ({
    cls,
    matchedPhrase: phrase,
    context: "",
    sentence: "",
  });

  test("the render does not grow with the length of the agent's prose", () => {
    const renders = [1, 3, 10, 30].map(
      (reps) => buildReminder(detectDeferralPhrases(runOnTurn(reps))).length
    );

    // The inputs really do differ by an order of magnitude — without this the
    // assertion below would hold trivially for a probe that varied nothing
    // (mem#704: a check that cannot fail is not verification).
    expect(runOnTurn(30).length).toBeGreaterThan(runOnTurn(1).length * 5);

    // Pre-fix these were 1072 / 1356 / 2350 / 5186.
    expect(new Set(renders).size).toBe(1);
  });

  test("a phrase past the cap is truncated, and says so", () => {
    const long = "z".repeat(MAX_RENDERED_PHRASE_CHARS * 3);
    const rendered = buildReminder([match(DEFERRAL_MENU, long)]);

    expect(rendered).not.toContain(long);
    expect(rendered).toContain(`"${"z".repeat(MAX_RENDERED_PHRASE_CHARS)}…"`);
  });

  test("a phrase within the cap is rendered verbatim, un-truncated", () => {
    // The longest phrase the live corpus produces (82 chars, the ask#6136
    // sample) — the common case must be untouched by the cap.
    const ordinary =
      "Want me to run it, or would you rather I park mt#3151 and pick up mt#3171 instead?";
    expect(ordinary.length).toBeLessThan(MAX_RENDERED_PHRASE_CHARS);

    const rendered = buildReminder([match(DEFERRAL_MENU, ordinary)]);

    expect(rendered).toContain(`"${ordinary}"`);
    expect(rendered).not.toContain("…");
  });

  test("an emoji-bearing phrase is bounded in the unit the ceiling counts (PR #3187 R1)", () => {
    // The cap must bound `.length`, not code points. An emoji is ONE code point
    // and TWO UTF-16 units, so a code-point cap admitted a phrase twice as long
    // as the ceiling counts — and both the shape test and the dispatcher's own
    // budget measure `.length`. Agent prose routinely carries emoji, so this was
    // reachable, not theoretical.
    const emoji = "\u{1F600}".repeat(MAX_RENDERED_PHRASE_CHARS);
    expect(Array.from(emoji).length).toBe(MAX_RENDERED_PHRASE_CHARS);
    expect(emoji.length).toBe(MAX_RENDERED_PHRASE_CHARS * 2); // the whole problem

    const rendered = buildReminder([match(PRINCIPAL_RESERVED, emoji), match(DEFERRAL_MENU, emoji)]);
    const ascii = buildReminder([
      match(PRINCIPAL_RESERVED, "x".repeat(MAX_RENDERED_PHRASE_CHARS * 2)),
      match(DEFERRAL_MENU, "x".repeat(MAX_RENDERED_PHRASE_CHARS * 2)),
    ]);

    // Bounded by the SAME number as the all-ASCII worst case, which is what
    // makes the declared ceiling a ceiling for every input.
    expect(rendered.length).toBeLessThanOrEqual(ascii.length);

    // And no lone surrogate survived the cut.
    expect(rendered).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(rendered).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  test("both classes at once, each past the cap, is the saturated worst case", () => {
    // What `worstCaseCanary` poses in the registry, and what
    // `attentionCost.denialMessageSizeChars` is set to exactly. Asserted as a
    // ceiling over the two single-class renders so this stays true if the
    // directive prose is ever edited.
    const over = "q".repeat(MAX_RENDERED_PHRASE_CHARS * 2);
    const saturated = buildReminder([match(PRINCIPAL_RESERVED, over), match(DEFERRAL_MENU, over)]);
    const principalOnly = buildReminder([match(PRINCIPAL_RESERVED, over)]);
    const menuOnly = buildReminder([match(DEFERRAL_MENU, over)]);

    expect(saturated.length).toBeGreaterThan(principalOnly.length);
    expect(saturated.length).toBeGreaterThan(menuOnly.length);
  });
});

describe("a sentence citing a filed ask is reporting, not deferring (mt#4201)", () => {
  // The inversion mem#719 names: the fire lands on the COMPLIANT behaviour. The
  // message routed the decision through the Ask substrate and is now reporting
  // its state at turn end — which `communication-contract.mdc` requires — and the
  // remedy the guard emits ("file an ask") is already done.
  //
  // Measured across three windows: 2 of 2 principal-reserved matches
  // (2026-08-10, via the subsumed mt#3932), 2 of 3 false (2026-08-17), 1 of 10
  // injected (2026-08-20).

  /** AT1's verbatim sentence, from the 2026-08-17 pass. */
  const REPORTS_ASK =
    "Still open and unchanged: [ask#8752](minsky://ask/7f206ca7-fe58-481f-bae9-46346acc1992) " +
    "needs your call on the policy-coverage detector.";

  /** AT2: the same sentence with the citation removed. */
  const REPORTS_ASK_WITHOUT_CITATION =
    "Still open and unchanged: the policy-coverage detector needs your call.";

  test("AT1 — the verbatim reported-ask sentence does not survive the filter", () => {
    const matches = detectDeferralPhrases(REPORTS_ASK);

    // Guards the discrimination: if the phrase never matched, the suppression
    // below would pass for the wrong reason (mem#704).
    expect(matches.length).toBeGreaterThan(0);

    const { remaining, suppressedAll } = resolveAskCitation(matches);
    expect(remaining).toEqual([]);
    expect(suppressedAll).toBe(true);
  });

  test("AT2 — the same sentence WITHOUT the ask citation still fires", () => {
    const matches = detectDeferralPhrases(REPORTS_ASK_WITHOUT_CITATION);
    expect(matches.length).toBeGreaterThan(0);

    const { remaining, suppressedAll } = resolveAskCitation(matches);
    expect(remaining.length).toBe(matches.length);
    expect(suppressedAll).toBe(false);
  });

  test("AT3 — a real positive, offering routine work instead of doing it, still fires", () => {
    // The 2026-08-17 pass's 5 true positives were all this shape: the agent
    // handing back work that was its own to do. None cites an ask, because there
    // is no ask — that is exactly why they are true.
    const realPositives = [
      "Want me to file those two tasks now, or would you rather I batch them?",
      "Say the word and I'll run the queued sweep.",
      "I'll pause here unless you want me to continue the chain-walk.",
    ];

    for (const text of realPositives) {
      const matches = detectDeferralPhrases(text);
      expect(matches.length).toBeGreaterThan(0);
      expect(resolveAskCitation(matches).remaining.length).toBe(matches.length);
    }
  });

  test("a bare ask#N with no deeplink counts — the unlinked form is documented", () => {
    // `cockpit-deeplinks.mdc` concedes the bare short id when the uuid is not at
    // hand, and the cockpit linkifies it. Requiring the markdown link would fire
    // on the exact case the rule already permits.
    expect(citesFiledAsk("ask#9275 is still yours to decide.")).toBe(true);
    expect(citesFiledAsk("Waiting on your call for minsky://ask/23a57be2-36c1-41d7")).toBe(true);
  });

  test("an unrelated hash reference does NOT count as an ask citation", () => {
    // The discrimination that keeps this from suppressing everything: a task or
    // PR reference in the same sentence is not a routed decision.
    expect(citesFiledAsk("mt#4201 needs your call.")).toBe(false);
    expect(citesFiledAsk("PR #3192 — you decide whether to merge.")).toBe(false);
    expect(citesFiledAsk("Ask me later.")).toBe(false);
  });

  test("suppression is PER-MATCH — a reported ask does not silence a real deferral beside it", () => {
    // The scope decision that makes this safe: one paragraph may report a filed
    // ask while another defers something genuinely undone. Only the reporting
    // sentence goes quiet.
    const mixed =
      "Still yours: [ask#9275](minsky://ask/23a57be2-36c1-41d7-9ffa-e74c452e8adb), whether the " +
      "detector starts speaking. Want me to file the follow-up task, or should I leave it?";

    const matches = detectDeferralPhrases(mixed);
    const { remaining, suppressedAll } = resolveAskCitation(matches);

    // At least one match survives — the genuine offer — and the turn is NOT
    // wholly suppressed.
    expect(remaining.length).toBeGreaterThan(0);
    expect(suppressedAll).toBe(false);
    expect(remaining.every((m) => !citesFiledAsk(m.sentence))).toBe(true);
  });
});

describe("AT4 — mt#4175's revisability class is untouched by the ask-citation filter", () => {
  // The two false classes measured in the same 2026-08-17 window are independent:
  // this task suppresses a sentence that CITES a filed ask; mt#4175 owns a
  // revisability offer that FOLLOWS a decision the agent already took. A
  // revisability offer carries no ask id, so the filter cannot reach it — which
  // is what keeps mt#4175's remedy free to be designed on its own terms.

  test("a revisability offer with no ask citation survives the filter unchanged", () => {
    const revisability = "I went with the second option unless you'd rather I switch.";

    const matches = detectDeferralPhrases(revisability);
    expect(matches.length).toBeGreaterThan(0);

    const { remaining, suppressedAll } = resolveAskCitation(matches);
    expect(remaining.length).toBe(matches.length);
    expect(suppressedAll).toBe(false);
  });
});

describe("PR #3205 R1 — the filter reads the captured sentence, never the wider context", () => {
  test("an ask cited in the context's LEAD sentence does not suppress a match in the next one", () => {
    // The blocking finding: re-deriving the sentence by searching `context` for
    // `matchedPhrase` picks the first occurrence, and `context` deliberately
    // carries a lead sentence. Here the ask lives in that lead; the match does
    // not. Reading the context suppresses (wrong); reading `sentence` fires.
    const match: DeferralMatch = {
      cls: "deferral-menu",
      matchedPhrase: "your call?",
      context: "[ask#9275](minsky://ask/23a57be2) is filed. So what's your call?",
      sentence: "So what's your call?",
    };

    // The citation IS present in the wider window — without this the test would
    // pass on a fixture that never posed the hazard (mem#704).
    expect(match.context).toContain("ask#9275");
    expect(citesFiledAsk(match.context)).toBe(true);

    // …and absent from the sentence the match actually sits in.
    expect(citesFiledAsk(match.sentence)).toBe(false);

    const { remaining, suppressedAll } = resolveAskCitation([match]);
    expect(remaining).toEqual([match]);
    expect(suppressedAll).toBe(false);
  });

  test("detectDeferralPhrases captures a sentence narrower than its context", () => {
    // Pins the capture itself rather than a hand-built fixture: the two windows
    // must actually differ on real input, or the distinction above is theatre.
    const text =
      "The migration is queued and reviewed. Want me to run it now, or would you rather wait?";

    const matches = detectDeferralPhrases(text);
    expect(matches.length).toBeGreaterThan(0);

    const [match] = matches as [DeferralMatch];
    expect(match.sentence.length).toBeLessThan(match.context.length);
    expect(match.context).toContain("migration is queued");
    expect(match.sentence).not.toContain("migration is queued");
  });
});

describe("PR #3205 R1 — run() wires the suppression, not just the helper", () => {
  // Non-blocking finding: unit-testing `resolveAskCitation` proves the HELPER,
  // not that anything calls it. This is the caller direction of the mt#2508
  // production-wiring check, applied to a detector's own entrypoint.

  const REPORTED_ASK_TURN =
    "Still open and unchanged: [ask#8752](minsky://ask/7f206ca7) needs your call on the detector.";
  const UNCITED_DEFERRAL_TURN = "The rail-axis question needs your call.";

  test("a reported-ask turn records the detection and injects NOTHING", async () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(REPORTED_ASK_TURN),
      makeRunUserLine(),
    ];
    const outcome = await run(RUN_HOOK_INPUT, makeCtx(transcriptLines));

    expect(outcome?.calibration).toBeDefined();
    // Detected — the record still carries it (mt#3207 detect-first).
    const cal = outcome?.calibration as {
      matches: unknown[];
      suppressionReasons: string[];
    };
    expect(cal.matches.length).toBeGreaterThan(0);
    expect(cal.suppressionReasons).toContain(SUPPRESSION_CITES_FILED_ASK);
    expect(outcome?.additionalContext).toBeUndefined();
  });

  test("the same phrase WITHOUT a citation still injects — the wiring discriminates", async () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(UNCITED_DEFERRAL_TURN),
      makeRunUserLine(),
    ];
    const outcome = await run(RUN_HOOK_INPUT, makeCtx(transcriptLines));

    const cal = outcome?.calibration as { suppressionReasons: string[] };
    expect(cal.suppressionReasons).not.toContain(SUPPRESSION_CITES_FILED_ASK);
    expect(outcome?.additionalContext).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// mt#4175 — the revisability offer: a decision already taken, then an offer to
// reverse it. The matched phrase is produced by `humility.mdc §Stakes filter`
// being FOLLOWED, so the fire lands on the compliant behaviour.
// ---------------------------------------------------------------------------

/** The AT1 contexts a first-person discriminator can reach, verbatim. */
const AT1_REACHABLE: Array<[string, string]> = [
  [
    "AT1.2 — picked and proceeded in one sentence",
    "All four follow-ons are TODO and unclaimed. My last report put mt#4125 first, so I'm taking that — say the word if you'd rather I start with one of the detector tunes.",
  ],
  [
    "AT1.3 — answering the principal's own question",
    "That's the spot where a second opinion would actually bite. Say the word and I'll dispatch one against the draft; I haven't, since you asked whether it was worthwhile rather than for it.",
  ],
  [
    "AT1.4 — the skill-chain rule's own exemption, quoted back",
    "I filed mt#4243 as tracking rather than walking it to implementation — nothing is currently failing, so it's a latent risk, not an incident. Say the word if you want it built now.",
  ],
];

/** The AT2 regression floor — genuine deferrals that MUST keep firing. */
const AT2_FLOOR: Array<[string, string]> = [
  ["AT2.1", "**Next.** Say the word and I'll plan any of the three."],
  ["AT2.2", "**Next.** mt#4131 is the substantive one ... Say the word and I'll plan it."],
  ["AT2.3", "Want me to take mt#4123, or would you rather I close out mt#4124 first?"],
  ["AT2.4", "**Rotating that token is your call** ... Say the word and I'll do it."],
];

/** True when a `deferral-menu` match survives the settled-decision filter. */
function menuSurvives(text: string): boolean {
  const { remaining } = resolveSettledDecision(detectDeferralPhrases(text));
  return remaining.some((m) => m.cls === DEFERRAL_MENU);
}

describe("mt#4175 AT1 — a revisability offer is suppressed", () => {
  for (const [label, text] of AT1_REACHABLE) {
    test(`silenced: ${label}`, () => {
      // Detection still runs — mt#3207's detect-first discipline means the
      // calibration record keeps the fire even when injection is withheld.
      expect(detectDeferralPhrases(text).some((m) => m.cls === DEFERRAL_MENU)).toBe(true);
      expect(menuSurvives(text)).toBe(false);
    });
  }

  test("mt#3801's structural-trigger example is covered too", () => {
    // The spec's own worked example for the widened surface: this carries no
    // literal deferral phrase, so it reaches the family through mt#3801's
    // trigger. Covering it is why the discriminator is applied to the FAMILY
    // rather than to the literal patterns.
    const text = "I went with the second option unless you'd rather I switch.";
    expect(detectDeferralPhrases(text).length).toBeGreaterThan(0);
    expect(menuSurvives(text)).toBe(false);
  });
});

describe("mt#4175 AT1 residual — the three contexts a first-person list cannot reach", () => {
  // MEASURED, not aspirational. SC1' requires the residual be recorded rather
  // than left implicit, and pinning it here is what makes a later change that
  // reaches these VISIBLE instead of silent. If one of these starts passing,
  // that is a result to record on mt#4175 — not a test to delete.

  test("AT1.1 — a PASSIVE decision marker does not suppress (PR #3224 R1)", () => {
    // Was reachable in the first cut, via `/\b(both\s+)?recorded\s+in\b/i`.
    // That pattern was dropped: it has no first-person subject, so it also
    // matched neutral third-party narration — see the negative test below for
    // the failure it bought. AT1.1 is residual now, and that is the correct
    // trade rather than a regression.
    const text =
      "The opposite posture would refuse every conversation ingested before 2026-07-18 in the cockpit. Say the word if you want it the other way; the reasoning and the alternative are both recorded in mt#3268.";
    expect(menuSurvives(text)).toBe(true);
  });

  test("AT1.5 — an additive offer with no decision verb still fires", () => {
    expect(menuSurvives("Say the word if you want a handoff doc for picking this up later.")).toBe(
      true
    );
  });

  test("AT1.6 — an alternative named without a course change still fires", () => {
    const text =
      "The alternative worth naming — the detector is past threshold (909 fires, 33 distinct). That's real but it's a different kind of work; say the word if you'd rather do that instead.";
    expect(menuSurvives(text)).toBe(true);
  });
});

describe("mt#4175 AT2 — the regression floor holds", () => {
  for (const [label, text] of AT2_FLOOR) {
    test(`still fires: ${label}`, () => {
      expect(menuSurvives(text)).toBe(true);
    });
  }
});

describe("mt#4175 — every pattern needs a first-person subject (PR #3224 R1)", () => {
  // The reviewer's concrete failure mode, pinned: a neutral status line in the
  // LEAD sentence must not silence a genuine deferral in the next one. This is
  // the behavioural form of the contract — a future pattern that forgets the
  // `I` fails here rather than merely disagreeing with a comment.

  test("a passive 'recorded in' lead sentence does NOT suppress a real deferral", () => {
    const text = "Meeting notes recorded in mt#3268. Next. Say the word and I'll plan it.";
    expect(menuSurvives(text)).toBe(true);
  });

  test("third-person narration of someone else's decision does NOT suppress", () => {
    const text =
      "The other session filed mt#4243 already. Say the word and I'll plan any of the three.";
    expect(menuSurvives(text)).toBe(true);
  });

  test("the SAME sentence in the first person DOES suppress — the contract discriminates", () => {
    // Same claim, same window, only the subject differs. Without this pair the
    // two tests above would also pass on a filter that suppresses nothing.
    const text = "I filed mt#4243 already. Say the word and I'll plan any of the three.";
    expect(menuSurvives(text)).toBe(false);
  });
});

describe("mt#4175 — the filter is scoped to deferral-menu, not principal-reserved", () => {
  test("a settled decision does NOT silence a principal-reserved match", () => {
    // The detector's subject is CHANNEL, not judgment: a correctly-identified
    // principal decision belongs in an ask even when the agent has settled
    // everything else in the turn. mt#4201 owns that class's suppression.
    const text = "I filed mt#4243 already. Rotating that token needs your call.";
    const matches = detectDeferralPhrases(text);
    const reserved = matches.filter((m) => m.cls === PRINCIPAL_RESERVED);
    expect(reserved.length).toBeGreaterThan(0);

    const { remaining } = resolveSettledDecision(matches);
    expect(remaining.filter((m) => m.cls === PRINCIPAL_RESERVED).length).toBe(reserved.length);
  });
});

describe("mt#4175 — scope: the window is the sentence PLUS one lead", () => {
  test("a decision in the LEAD sentence suppresses the offer in the next one", () => {
    // AT1.4's shape, isolated. Testing `.sentence` alone would miss it.
    expect(
      settlesDecision("I filed mt#4243 as tracking. Say the word if you want it built now.")
    ).toBe(true);
  });

  test("a bare offer with no decision anywhere in the window does not suppress", () => {
    expect(settlesDecision("Say the word and I'll plan any of the three.")).toBe(false);
  });
});

describe("mt#4175 — run() wires the suppression, not just the helper", () => {
  // The caller direction of the mt#2508 production-wiring check, mirroring
  // PR #3205 R1's test for the sibling filter: unit-testing the helper proves
  // the helper, not that the entrypoint calls it.

  const SETTLED_TURN =
    "I filed mt#4243 as tracking rather than walking it to implementation. Say the word if you want it built now.";
  test("a settled-decision turn records the detection and injects NOTHING", async () => {
    const outcome = await run(
      RUN_HOOK_INPUT,
      makeCtx([makeRunUserLine(), makeRunAssistantLine(SETTLED_TURN), makeRunUserLine()])
    );

    const cal = outcome?.calibration as { matches: unknown[]; suppressionReasons: string[] };
    expect(cal.matches.length).toBeGreaterThan(0);
    expect(cal.suppressionReasons).toContain(SUPPRESSION_SETTLED_DECISION);
    expect(outcome?.additionalContext).toBeUndefined();
  });

  test("the same phrase WITHOUT a settled decision still injects — the wiring discriminates", async () => {
    const outcome = await run(
      RUN_HOOK_INPUT,
      makeCtx([makeRunUserLine(), makeRunAssistantLine(UNSETTLED_TURN), makeRunUserLine()])
    );

    const cal = outcome?.calibration as { suppressionReasons: string[] };
    expect(cal.suppressionReasons).not.toContain(SUPPRESSION_SETTLED_DECISION);
    expect(outcome?.additionalContext).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// mt#4404 — Rung 2 (embedding nomination) for the settled-decision suppressor
// ---------------------------------------------------------------------------

/**
 * The nominator is INJECTED throughout, never patched.
 *
 * That is the testable-design shape rather than a convenience: the decision
 * under test is "given a verdict about this window, which matches survive," and
 * the embedding call is a collaborator the function is HANDED. Reaching for a
 * `spyOn` here would be testing the wiring of a module import instead. The real
 * provider is exercised separately by
 * `bun scripts/replay-settled-decision.ts --rung2`, which is where the threshold
 * itself was measured — a network call has no place in a unit test.
 */
const settledAlways: SettledDecisionNominator = async () => ({ kind: "settled", score: 0.9 });
const settledNever: SettledDecisionNominator = async () => ({ kind: "none" });
const settledDegraded: SettledDecisionNominator = async () => ({
  kind: "degraded",
  reason: PROVIDER_UNCONFIGURED,
});

describe("mt#4404 — Rung 2 reaches the renderings the patterns cannot", () => {
  // Verbatim from `.minsky/ask-routing-deferral-calibration.jsonl`, the record
  // this task was filed on (ts 2026-08-21T20:22:05.670Z).
  const RECORD_7 =
    "Picking mt#4391 over mt#4385 because bare-prohibition is quieted, so its inert basis recognizer affects no agent today, whereas the ack path is live and self-compounding. That ordering is mine and cheap to reverse if you'd rather I start elsewhere.";

  test("AT6 — record 7 is suppressed once Rung 2 is consulted", async () => {
    const matches = detectDeferralPhrases(RECORD_7);
    expect(matches.some((m) => m.cls === DEFERRAL_MENU)).toBe(true);

    // Rung 1 alone leaves it firing — the premise this whole task rests on,
    // asserted here rather than assumed.
    expect(resolveSettledDecision(matches).remaining.length).toBeGreaterThan(0);

    const { remaining, suppressedAll } = await resolveSettledDecisionRung2(matches, settledAlways);
    expect(remaining).toEqual([]);
    expect(suppressedAll).toBe(true);
  });

  test("AT2 floor — a genuine deferral the nominator does not claim is left alone", async () => {
    const matches = detectDeferralPhrases(UNSETTLED_TURN);
    const { remaining, suppressedAll } = await resolveSettledDecisionRung2(matches, settledNever);
    expect(remaining).toEqual(matches);
    expect(suppressedAll).toBe(false);
  });

  test("the cls guard is inherited — principal-reserved survives a `settled` verdict", async () => {
    // Same contract as Rung 1's: a settled decision does not make "rotating
    // that token is your call" any less the principal's. A nominator that says
    // `settled` for EVERY window is the strongest form of this test.
    const matches = detectDeferralPhrases(
      "Picking the cheaper option here. Rotating that token needs your call."
    );
    const reserved = matches.filter((m) => m.cls === PRINCIPAL_RESERVED);
    expect(reserved.length).toBeGreaterThan(0);

    const { remaining } = await resolveSettledDecisionRung2(matches, settledAlways);
    expect(remaining.filter((m) => m.cls === PRINCIPAL_RESERVED).length).toBe(reserved.length);
  });

  test("AT5 — a degraded nomination suppresses NOTHING and records the reason", async () => {
    // ADR-024's fail-to-Rung-1 invariant. On a suppressor this is the safe
    // direction: the false positive returns, rather than a real deferral being
    // silenced by a provider outage.
    const matches = detectDeferralPhrases(RECORD_7);
    const result = await resolveSettledDecisionRung2(matches, settledDegraded);
    expect(result.remaining).toEqual(matches);
    expect(result.suppressedAll).toBe(false);
    expect(result.degradedReason).toBe(PROVIDER_UNCONFIGURED);
  });

  test("a nominator that throws degrades rather than escaping", async () => {
    const thrower: SettledDecisionNominator = async () => {
      throw new Error("socket hang up");
    };
    const matches = detectDeferralPhrases(RECORD_7);
    const result = await resolveSettledDecisionRung2(matches, thrower);
    expect(result.remaining).toEqual(matches);
    expect(result.degradedReason).toContain("socket hang up");
  });

  test("a mid-loop degradation discards the partial verdict, not just the failed context", async () => {
    // Otherwise the outcome would depend on match ORDER: whichever contexts
    // happened to be scored before the provider wedged would be suppressed and
    // the rest would not, which is a verdict nobody chose.
    let call = 0;
    const flaky: SettledDecisionNominator = async () => {
      call++;
      return call === 1 ? { kind: "settled", score: 0.9 } : { kind: "degraded", reason: "timeout" };
    };
    // Constructed rather than detected: `detectDeferralPhrases` reports one
    // match per class per turn, so two DISTINCT contexts in one `deferral-menu`
    // array cannot be produced from prose. The resolver's input type is
    // `DeferralMatch[]`, and two contexts is exactly the state this ordering
    // property is about — building it directly tests the property instead of
    // testing the detector's dedup.
    const matches: DeferralMatch[] = [
      {
        cls: DEFERRAL_MENU,
        matchedPhrase: "Say the word",
        context:
          "Picking the first one because it is cheap to reverse. Say the word if you would rather I switch.",
        sentence: "Say the word if you would rather I switch.",
      },
      {
        cls: DEFERRAL_MENU,
        matchedPhrase: "want me to",
        context: "Separately: want me to take the second, or would you rather I stop here?",
        sentence: "Separately: want me to take the second, or would you rather I stop here?",
      },
    ];
    expect(new Set(matches.map((m) => m.context)).size).toBe(2);

    const result = await resolveSettledDecisionRung2(matches, flaky);
    expect(result.remaining).toEqual(matches);
    expect(result.degradedReason).toBe("timeout");
  });

  test("no nominator (the shipped default) leaves everything unchanged and degrades nothing", async () => {
    const matches = detectDeferralPhrases(RECORD_7);
    const result = await resolveSettledDecisionRung2(matches, undefined);
    expect(result.remaining).toEqual(matches);
    expect(result.degradedReason).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // PR #3395 R1 — the non-semantic-provider property, asserted rather than argued
  // -------------------------------------------------------------------------

  test("a non-semantic provider never produces a score, so nothing can cross the threshold", async () => {
    // The reviewer's stated failure was hash-stub cosines crossing
    // `SETTLED_DECISION_RUNG2_THRESHOLD` and silencing a genuine deferral. It
    // cannot happen, and this is the proof rather than the assertion: the
    // embedding service THROWS if called at all. `nominate` refuses on
    // `!deps.semantic` before it reaches the service, so the throw is never
    // triggered and the result is a clean degraded verdict.
    const exploding = {
      generateEmbeddings: async () => {
        throw new Error("the provider must not be reached for a non-semantic dep");
      },
    } as unknown as NominationDeps["embeddingService"];

    const result = await nominate(RECORD_7, [SETTLED_DECISION_EXEMPLAR_SET], {
      embeddingService: exploding,
      semantic: false,
    });

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe(NON_SEMANTIC_PROVIDER);
    expect(result.nominations).toEqual([]);
  });

  test("that degraded verdict suppresses nothing end-to-end", async () => {
    const nonSemantic: SettledDecisionNominator = async () => ({
      kind: "degraded",
      reason: NON_SEMANTIC_PROVIDER,
    });
    const matches = detectDeferralPhrases(RECORD_7);
    const result = await resolveSettledDecisionRung2(matches, nonSemantic);
    expect(result.remaining).toEqual(matches);
    expect(result.suppressedAll).toBe(false);
    expect(result.degradedReason).toBe(NON_SEMANTIC_PROVIDER);
  });

  test("run() returns a Promise — the async contract the dispatcher awaits", () => {
    // PR #3395 R1 asked for an audit of `run`'s consumers; the result is in
    // `run`'s docblock (nothing imports it but the dispatcher, which awaits).
    // This pins the half an audit cannot: a future change that makes `run`
    // synchronous again, or a new caller that forgets to await, fails HERE
    // rather than becoming a silent no-op at prompt time.
    const returned = run(
      RUN_HOOK_INPUT,
      makeCtx([makeRunUserLine(), makeRunAssistantLine(UNSETTLED_TURN), makeRunUserLine()])
    );
    expect(returned).toBeInstanceOf(Promise);
    return returned.then(() => undefined);
  });
});

describe("mt#4404 — Rung 1 is retained, not replaced", () => {
  test("SC4 — the first-person-subject contract is untouched", () => {
    // PR #3224 R1 removed every subject-less pattern from this array. Rung 2
    // adds a SECOND rung rather than widening this one, so the contract holds
    // by construction — this asserts the array still says so.
    for (const pattern of SETTLED_DECISION_PATTERNS) {
      expect(pattern.source).toContain("I");
    }
  });

  test("Rung 2 is never consulted for a match Rung 1 already suppressed", async () => {
    // The ordering is the cost argument: patterns are free, a nomination is a
    // provider round-trip. A turn Rung 1 handles must not reach the network.
    let calls = 0;
    const counting: SettledDecisionNominator = async () => {
      calls++;
      return { kind: "none" };
    };
    const matches = detectDeferralPhrases(
      "I filed mt#4243 as tracking. Say the word if you want it built now."
    );
    const settled = resolveSettledDecision(matches);
    expect(settled.suppressedAll).toBe(true);

    await resolveSettledDecisionRung2(settled.remaining, counting);
    expect(calls).toBe(0);
  });

  test("the threshold is NOT the inherited shared default", () => {
    // mt#4280 records `DEFAULT_SIMILARITY_THRESHOLD` (0.455) under-scoring
    // ground-truth fixtures on a corpus it was not measured on. This value was
    // measured on THIS corpus (band 0.4387..0.5901, midpoint). A future
    // "simplification" back to the shared constant should fail here.
    expect(SETTLED_DECISION_RUNG2_THRESHOLD).not.toBe(0.455);
    expect(SETTLED_DECISION_RUNG2_THRESHOLD).toBeGreaterThan(0.4387);
    expect(SETTLED_DECISION_RUNG2_THRESHOLD).toBeLessThan(0.5901);
  });

  test("the exemplar set covers every rendering the three windows measured", () => {
    // One exemplar per observed grammatical form, not one per recorded fire.
    // If a future edit prunes the set, this says which shape went missing.
    const joined = SETTLED_DECISION_EXEMPLARS.join(" | ");
    expect(joined).toContain("Picking"); // participial lead
    expect(joined).toContain("Proceeding"); // participial, present
    expect(joined).toContain("I'm proceeding"); // present progressive
    expect(joined).toContain("I'd go with"); // conditional mood
    expect(joined).toContain("I'll keep going"); // default-plus-escape continuation
    expect(joined).toContain("I chose"); // finite past (Rung 1's own shape)
  });

  test("the Rung-2 path ships opt-in, off by default", () => {
    // mt#3408's precedent: the mechanism lands, the threshold is measured, and
    // a human flips it on after reading the calibration record.
    const prior = process.env[RUNG2_NOMINATION_ENV_VAR];
    delete process.env[RUNG2_NOMINATION_ENV_VAR];
    try {
      expect(isRung2NominationEnabled()).toBe(false);
      process.env[RUNG2_NOMINATION_ENV_VAR] = "1";
      expect(isRung2NominationEnabled()).toBe(true);
    } finally {
      if (prior === undefined) delete process.env[RUNG2_NOMINATION_ENV_VAR];
      else process.env[RUNG2_NOMINATION_ENV_VAR] = prior;
    }
  });
});

describe("mt#4404 — run() wires Rung 2, not just the helper", () => {
  // The caller direction of the mt#2508 production-wiring check, mirroring the
  // mt#4175 block above: unit-testing the resolver proves the resolver.
  const RECORD_7_TURN =
    "Picking mt#4391 over mt#4385 because the ack path is live and self-compounding. That ordering is mine and cheap to reverse if you'd rather I start elsewhere.";

  test("a Rung-2 suppression reaches the calibration record and withholds the injection", async () => {
    const outcome = await run(
      RUN_HOOK_INPUT,
      makeCtx([makeRunUserLine(), makeRunAssistantLine(RECORD_7_TURN), makeRunUserLine()]),
      undefined,
      settledAlways
    );

    const cal = outcome?.calibration as { matches: unknown[]; suppressionReasons: string[] };
    expect(cal.matches.length).toBeGreaterThan(0);
    expect(cal.suppressionReasons).toContain(SUPPRESSION_SETTLED_DECISION_RUNG2);
    // The two rungs stay distinguishable in the log — Rung 1 did NOT catch this.
    expect(cal.suppressionReasons).not.toContain(SUPPRESSION_SETTLED_DECISION);
    expect(outcome?.additionalContext).toBeUndefined();
  });

  test("the same turn with Rung 2 off still injects — the wiring discriminates", async () => {
    const outcome = await run(
      RUN_HOOK_INPUT,
      makeCtx([makeRunUserLine(), makeRunAssistantLine(RECORD_7_TURN), makeRunUserLine()]),
      undefined,
      undefined
    );

    const cal = outcome?.calibration as { suppressionReasons: string[] };
    expect(cal.suppressionReasons).not.toContain(SUPPRESSION_SETTLED_DECISION_RUNG2);
    expect(outcome?.additionalContext).toBeDefined();
  });

  test("a degraded nomination records the ADR-024 marker and still injects", async () => {
    const outcome = await run(
      RUN_HOOK_INPUT,
      makeCtx([makeRunUserLine(), makeRunAssistantLine(RECORD_7_TURN), makeRunUserLine()]),
      undefined,
      settledDegraded
    );

    const cal = outcome?.calibration as {
      suppressionReasons: string[];
      rung2DegradedReason?: string;
    };
    // The marker is what separates "Rung 2 found nothing" from "Rung 2 never
    // ran" — the same empty verdict without it.
    expect(cal.rung2DegradedReason).toBe(PROVIDER_UNCONFIGURED);
    expect(cal.suppressionReasons).not.toContain(SUPPRESSION_SETTLED_DECISION_RUNG2);
    expect(outcome?.additionalContext).toBeDefined();
  });
});
