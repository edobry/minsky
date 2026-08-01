/* eslint-disable custom/no-real-fs-in-tests -- the mt#2357 filterStopFlagged tests exercise the real turn-end-scan-store roundtrip (writeFlagged -> dedup-read) in an isolated mkdtemp dir, mirroring substrate-bypass-detector.test.ts's precedent */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  detectTriggerPhrases,
  detectTriggerPhrasesWithNomination,
  detectUserCorrection,
  detectMethodRedirect,
  hasDesignContext,
  hasRecentRetrospectiveInvocation,
  hasRetrospectiveSkillInvocation,
  isDetectorMetaDiscussion,
  NOMINATION_EXEMPLARS,
  OVERRIDE_ENV_VAR,
  run,
} from "./retrospective-trigger-scanner";
import type { NominationDeps } from "../../packages/domain/src/detectors/embedding-nomination";
import {
  extractAssistantText,
  extractLastAssistantTurn,
  extractLastUserMessage,
} from "./transcript";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";
import { filterStopFlagged } from "./retrospective-trigger-scanner";
import { flagKey, turnKeyFor, writeFlagged } from "./turn-end-scan-store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// mt#3408: these suites exercise the DETERMINISTIC Rung-1 behaviour of `run()`.
// Rung 2 is switched off here so no test reaches for a live embedding provider;
// nomination has its own coverage with injected deps (see the Rung-2 describe
// block below and packages/domain/src/detectors/embedding-nomination.test.ts).
process.env.MINSKY_DISABLE_RUNG2_NOMINATION = "1";

const WHY_DID_YOU_DO_THAT = "why did you do that?";
const APOLOGY_FIXTURE = "I owe you an apology for that mistake.";

// ---------------------------------------------------------------------------
// R1: Apology / contrition — positive matches
// ---------------------------------------------------------------------------

describe("R1 apology/contrition patterns", () => {
  const cases = [
    "I owe you an apology",
    "I apologize for the confusion",
    "I was wrong about the architecture",
    "my recommendation was incorrect",
    "I should have caught this earlier",
    "I should have known better",
    "I should have thought of that",
    "that was my fault",
    "I made a mistake on the config",
    "I missed the obvious issue",
    "I anchored on the first result and missed the better option",
    "I conflated the two concepts",
    // mt#3098: the improvised-instead-of-the-canonical-path admission shape.
    "I improvised a reasonable-looking handoff instead of running the canonical skill",
    "I improvised that handoff rather than following a defined method",
  ];

  for (const phrase of cases) {
    test(`matches: "${phrase}"`, async () => {
      const matches = detectTriggerPhrases(phrase);
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches.some((m) => m.family === "R1")).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// R2: Operational / explanatory prose — positive matches
// ---------------------------------------------------------------------------

describe("R2 operational/explanatory prose patterns", () => {
  const cases = [
    "I didn't think it through",
    "I didn't think through the implications",
    "I went straight to implementation without checking the spec",
    "I defaulted to the easy path and didn't pause to consider alternatives",
    "I didn't pause to consider the impact",
  ];

  for (const phrase of cases) {
    test(`matches: "${phrase}"`, async () => {
      const matches = detectTriggerPhrases(phrase);
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches.some((m) => m.family === "R2")).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// R3: Future-behavior commitments — positive matches
// ---------------------------------------------------------------------------

describe("R3 future-behavior commitment patterns", () => {
  const cases = [
    "going forward I will check the spec first",
    "going forward I'll verify before acting",
    "from now on I will run the gate check",
    "from now on I'll be more thorough",
    "next time I will pause and think",
    "next time I'll check the sibling hooks",
    "future me will handle this better",
    "I'll be more careful about edge cases",
    "I will be more careful about this pattern",
    // mt#3098: the same commitments with the clauses reversed — the shape that
    // missed on 2026-07-23 while "Going forward I'll" fired the same day.
    "I'll invoke it rather than improvise going forward",
    "I will check the sibling hooks next time",
    "I'll run the gate check from now on",
  ];

  for (const phrase of cases) {
    test(`matches: "${phrase}"`, async () => {
      const matches = detectTriggerPhrases(phrase);
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches.some((m) => m.family === "R3")).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// R4: Decline-to-retrospective — positive matches
// ---------------------------------------------------------------------------

describe("R4 decline-to-retrospective patterns", () => {
  const cases = [
    "fixing the symptom by waiting now rather than running another retrospective",
    "fixing the symptom rather than doing a retrospective",
    "this is a one-off issue",
    "a one-off mistake that won't recur",
    "no need for a full retrospective",
    "no need for a retrospective here",
    "I'll just skip the retrospective this time",
    "this doesn't warrant a full retrospective",
    "doesn't warrant a retrospective",
    "minor enough to skip the process",
  ];

  for (const phrase of cases) {
    test(`matches: "${phrase}"`, async () => {
      const matches = detectTriggerPhrases(phrase);
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches.some((m) => m.family === "R4")).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// mt#3291 — disposition-precision narrowing, keyed to the 2026-07-28 review
// window. All eight fires in that window were genuine self-correction language
// (phrase-match precision ~100%), but only two described a PROCESS failure
// (disposition precision ~25%). These fixtures are the actual excerpts from
// `.minsky/retrospective-trigger-calibration.jsonl`, so the split is pinned
// against real recorded text rather than invented phrasing.
// ---------------------------------------------------------------------------

describe("mt#3291 — factual self-correction does NOT fire", () => {
  // The four "I was wrong about" FPs. Each corrects a fact about the WORLD —
  // a shell's launch mode, whether work was lost, what a set of commits held,
  // why pushes failed — not the agent's own reasoning.
  const cases = [
    "So you are in iTerm CLI (not a GUI/Dock launch — I was wrong about that).",
    "Definitive: your work was never gone — I was wrong about that.",
    "Interim, with one correction I shouldn't sit on: I was wrong about one thing.",
    "The more important find: I was wrong about the push failures. They weren't timeouts.",
  ];

  for (const phrase of cases) {
    test(`does not fire: "${phrase.slice(0, 56)}…"`, async () => {
      expect(detectTriggerPhrases(phrase)).toHaveLength(0);
    });
  }
});

describe("mt#3291 — process-failure self-correction still fires", () => {
  // The two real positives from the same window, plus the process-shaped
  // "wrong about" the narrowed pattern deliberately retains.
  const cases: Array<[string, string]> = [
    [
      "conflated proxy evidence (07-21T20:54)",
      "role-permission probes were thorough and effortful, so I conflated expensive proxy evidence with verified the acceptance surface",
    ],
    [
      "conflated without reading (07-22T19:04)",
      "The two share the word routing and I conflated them without reading the service",
    ],
    ["wrong about the approach", "I was wrong about the approach here"],
    ["wrong about the architecture", "I was wrong about the architecture"],
  ];

  for (const [label, phrase] of cases) {
    test(`fires: ${label}`, async () => {
      const matches = detectTriggerPhrases(phrase);
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches.some((m) => m.family === "R1")).toBe(true);
    });
  }
});

describe("mt#3291 — R4 fires on a declared skip, not a reasoned recommendation", () => {
  test("does not fire on a justified recommendation to skip", async () => {
    // The 07-22T18:26 fire: an agent correctly concluding a retro was not
    // warranted and saying why. A live "invoke /retrospective" reminder here
    // penalizes the reasoning R4 exists to elicit.
    const text =
      "My recommendation: skip the full retrospective — the structural fix exists and both occurrences were benign";
    expect(detectTriggerPhrases(text)).toHaveLength(0);
  });

  test("does not fire on a reasoned first-person recommendation either", async () => {
    const text = "I recommend we skip the full retrospective because the guard already covers it";
    expect(detectTriggerPhrases(text)).toHaveLength(0);
  });

  // PR #2461 R1: the first draft covered too few declaring shapes. Every
  // phrasing below is the same bare decline; each is pinned so a future
  // narrowing cannot silently drop one.
  const declaredSkips = [
    "I'll just skip the retrospective this time",
    "I'll skip a retrospective",
    "I will skip the full retrospective",
    "I'm going to skip the retrospective",
    "I am going to skip a retrospective",
    "I'm skipping the retrospective",
    "I am skipping a proper retrospective",
    "I skip the retrospective",
  ];

  for (const text of declaredSkips) {
    test(`still fires on a bare declared skip: "${text}"`, async () => {
      const matches = detectTriggerPhrases(text);
      expect(matches.some((m) => m.family === "R4")).toBe(true);
    });
  }

  test("still fires on conclusory declines with no first-person subject", async () => {
    for (const text of [
      "There is no need for a full retrospective here",
      "This doesn't warrant a full retrospective",
    ]) {
      expect(detectTriggerPhrases(text).some((m) => m.family === "R4")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Negative matches — should NOT trigger
// ---------------------------------------------------------------------------

describe("negative matches (should not trigger)", () => {
  const cases = [
    // Normal operational text
    "The implementation is complete and all tests pass.",
    "I've committed the changes and pushed to the branch.",
    "Let me check the spec for the next step.",
    // Discussing past incidents without self-recognition
    "In the mt#2053 incident, the agent wrote a decline-to-retrospective phrase.",
    // Future tense without commitment shape
    "The next version will include better error handling.",
    "Going forward, the system will automatically detect this.",
    // Simple acknowledgment without apology shape
    "I see the issue now. Let me fix it.",
    "You're right, the test is missing coverage.",
    // mt#3098 near-misses for the widened R1/R3 patterns: improvisation with no
    // skipped-canonical-path contrast, a temporal phrase with no first-person
    // commitment, and a first-person future with no commitment phrase.
    "I improvised a fixture for the integration test.",
    "The sweeper will keep reconciling going forward.",
    "I'll rerun the test suite now.",
    // NOTE: quoted trigger phrases in documentation text ("The hook detects
    // phrases like 'I owe you an apology'") ARE a known false-positive class.
    // SC#4 accepts this — advisory-only, tracked via calibration log.
  ];

  for (const phrase of cases) {
    test(`does NOT match: "${phrase.slice(0, 60)}..."`, async () => {
      const matches = detectTriggerPhrases(phrase);
      expect(matches.length).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// User correction signals — positive matches
// ---------------------------------------------------------------------------

describe("user correction signal patterns", () => {
  const cases = [
    "that's wrong",
    "that's incorrect",
    "that's not right",
    "that's not what I said",
    "you keep doing this",
    "I've told you this before",
    "how many times do I need to say this",
    WHY_DID_YOU_DO_THAT,
    "what were you thinking?",
    "why would you skip the check?",
    "why didn't you run the test?",
  ];

  for (const phrase of cases) {
    test(`matches correction: "${phrase}"`, async () => {
      const matches = detectUserCorrection(phrase);
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches[0]?.family).toBe("user-correction");
    });
  }
});

// ---------------------------------------------------------------------------
// User correction — negative matches
// ---------------------------------------------------------------------------

describe("user correction negative matches", () => {
  const cases = [
    "proceed with the implementation",
    "looks good, merge it",
    "what's the status of the PR?",
    "can you check the test output?",
    "investigate mt#2057",
  ];

  for (const phrase of cases) {
    test(`does NOT match correction: "${phrase}"`, async () => {
      const matches = detectUserCorrection(phrase);
      expect(matches.length).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Multi-family detection (single text triggers multiple families)
// ---------------------------------------------------------------------------

describe("multi-family detection", () => {
  test("text with R1 + R3 triggers both families", async () => {
    const text =
      "I should have caught this earlier. Going forward I will always check the spec first.";
    const matches = detectTriggerPhrases(text);
    const families = new Set(matches.map((m) => m.family));
    expect(families.has("R1")).toBe(true);
    expect(families.has("R3")).toBe(true);
  });

  test("text with R2 + R4 triggers both families", async () => {
    const text =
      "I didn't think it through. This is a one-off issue that doesn't warrant a retrospective.";
    const matches = detectTriggerPhrases(text);
    const families = new Set(matches.map((m) => m.family));
    expect(families.has("R2")).toBe(true);
    expect(families.has("R4")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Retrospective skill suppression
// ---------------------------------------------------------------------------

describe("retrospective skill suppression", () => {
  test("suppresses when Skill tool with retrospective is in the turn", async () => {
    const turnLines = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I should have caught this. Let me run a retrospective." },
            { type: "tool_use", name: "Skill", input: { skill: "retrospective" } },
          ],
        },
      },
    ];
    expect(hasRetrospectiveSkillInvocation(turnLines)).toBe(true);
  });

  test("does NOT suppress when no Skill tool in turn", async () => {
    const turnLines = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I should have caught this." }],
        },
      },
    ];
    expect(hasRetrospectiveSkillInvocation(turnLines)).toBe(false);
  });

  test("does NOT suppress when Skill tool is for a different skill", async () => {
    const turnLines = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I should have caught this." },
            { type: "tool_use", name: "Skill", input: { skill: "implement-task" } },
          ],
        },
      },
    ];
    expect(hasRetrospectiveSkillInvocation(turnLines)).toBe(false);
  });

  // main() gates BOTH surfaces (assistant-turn + user-correction) on
  // hasRetrospectiveSkillInvocation — when it returns true, main() exits
  // before either detection runs. This test verifies the predicate is
  // correct; the gating logic is structural in main().
  test("suppression predicate fires for top-level tool_use format", async () => {
    const turnLines = [
      {
        type: "tool_use",
        name: "Skill",
        input: { skill: "retrospective" },
      },
    ];
    expect(hasRetrospectiveSkillInvocation(turnLines)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Transcript parsing helpers
// ---------------------------------------------------------------------------

describe("extractLastAssistantTurn", () => {
  test("extracts assistant lines between second-to-last and last user messages", async () => {
    const lines = [
      { type: "user", message: { role: "user", content: "first prompt" } },
      { type: "assistant", message: { role: "assistant", content: "first response" } },
      { type: "user", message: { role: "user", content: "second prompt" } },
    ];
    const turn = extractLastAssistantTurn(lines);
    expect(turn.length).toBe(1);
    expect(turn[0]?.message?.content).toBe("first response");
  });

  test("returns empty when fewer than 2 user messages", async () => {
    const lines = [{ type: "user", message: { role: "user", content: "only prompt" } }];
    expect(extractLastAssistantTurn(lines)).toEqual([]);
  });

  // mt#2255: a trigger phrase in a NON-FINAL assistant segment of a multi-tool-round
  // turn must still be surfaced. The old user-role split bounded the turn at the last
  // tool_result, dropping the first segment (Surface 1 never fired — the reason the
  // hook existed). With real-prompt bounds, the whole turn is scanned.
  test("trigger phrase in the FIRST segment of a multi-round turn is still detected", async () => {
    const lines = [
      { type: "user", message: { role: "user", content: "do the thing" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I should have caught it myself." }],
        },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: {} }] },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
        },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Fixed it." }] },
      },
      { type: "user", message: { role: "user", content: "next" } },
    ];
    const turn = extractLastAssistantTurn(lines);
    const text = extractAssistantText(turn);
    expect(text).toContain("I should have caught it myself.");
    const matches = detectTriggerPhrases(text);
    expect(matches.some((m) => m.family === "R1")).toBe(true);
  });
});

describe("extractAssistantText", () => {
  test("extracts string content", async () => {
    const lines = [{ type: "assistant", message: { role: "assistant", content: "hello world" } }];
    expect(extractAssistantText(lines)).toBe("hello world");
  });

  test("extracts from content array", async () => {
    const lines = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "block one" },
            { type: "text", text: "block two" },
          ],
        },
      },
    ];
    expect(extractAssistantText(lines)).toBe("block one\nblock two");
  });
});

describe("extractLastUserMessage", () => {
  test("extracts last user message text", async () => {
    const lines = [
      { type: "user", message: { role: "user", content: "first" } },
      { type: "assistant", message: { role: "assistant", content: "response" } },
      { type: "user", message: { role: "user", content: WHY_DID_YOU_DO_THAT } },
    ];
    expect(extractLastUserMessage(lines)).toBe(WHY_DID_YOU_DO_THAT);
  });

  test("returns empty string when no user messages", async () => {
    expect(extractLastUserMessage([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Smart quote handling
// ---------------------------------------------------------------------------

describe("smart quote handling", () => {
  test("R2 matches with smart apostrophe", async () => {
    const matches = detectTriggerPhrases("I didn’t think it through");
    expect(matches.some((m) => m.family === "R2")).toBe(true);
  });

  test("R3 matches with smart apostrophe", async () => {
    const matches = detectTriggerPhrases("going forward I’ll check first");
    expect(matches.some((m) => m.family === "R3")).toBe(true);
  });

  test("user correction matches with smart apostrophe", async () => {
    const matches = detectUserCorrection("that’s wrong");
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// R5: Finding-reframing (mt#2112)
// ---------------------------------------------------------------------------

describe("R5 finding-reframing", () => {
  test("matches first-person approach + anti-pattern", async () => {
    const matches = detectTriggerPhrases(
      "the approach I was implementing is considered an anti-pattern"
    );
    expect(matches.some((m) => m.family === "R5")).toBe(true);
  });

  test("matches 'I was using' + anti-pattern", async () => {
    const matches = detectTriggerPhrases(
      "the pattern I was using is a known anti-pattern in monorepos"
    );
    expect(matches.some((m) => m.family === "R5")).toBe(true);
  });

  test("matches honesty framing + anti-pattern", async () => {
    const matches = detectTriggerPhrases("I should be honest: this is an anti-pattern");
    expect(matches.some((m) => m.family === "R5")).toBe(true);
  });

  test("matches first-person + research reveals", async () => {
    const matches = detectTriggerPhrases(
      "I chose this but research reveals the pattern is wrong for this use case"
    );
    expect(matches.some((m) => m.family === "R5")).toBe(true);
  });

  test("matches first-person + community consensus", async () => {
    const matches = detectTriggerPhrases(
      "I went with this but community consensus is against this approach"
    );
    expect(matches.some((m) => m.family === "R5")).toBe(true);
  });

  test("matches 'I was implementing' + anti-pattern", async () => {
    const matches = detectTriggerPhrases("I was implementing what turns out to be an anti-pattern");
    expect(matches.some((m) => m.family === "R5")).toBe(true);
  });

  test("does NOT match general anti-pattern discussion without self-reference", async () => {
    const matches = detectTriggerPhrases("barrel exports are considered an anti-pattern");
    expect(matches.some((m) => m.family === "R5")).toBe(false);
  });

  test("does NOT match 'known anti-pattern' without self-reference", async () => {
    const matches = detectTriggerPhrases("the system uses a known anti-pattern internally");
    expect(matches.some((m) => m.family === "R5")).toBe(false);
  });

  test("does NOT match general React discussion", async () => {
    const matches = detectTriggerPhrases("this is a common anti-pattern in React codebases");
    expect(matches.some((m) => m.family === "R5")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// run() — dispatcher-compatible pure function (ADR-028 D1/D2 — mt#2652)
//
// No real fs needed: run() reads ctx.transcriptLines directly (resolved
// once by the dispatcher's D6 shared context, mt#2637-safe) rather than
// re-parsing a transcript_path itself — so transcriptLines is built
// in-memory here instead of via a real file + parseTranscript.
// ---------------------------------------------------------------------------

function makeRunUserLine(text = "test user message"): TranscriptLine {
  return { type: "user", message: { role: "user", content: text } };
}

function makeRunAssistantLine(text: string): TranscriptLine {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
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
  test("R1 trigger match -> additionalContext + calibration record", async () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(APOLOGY_FIXTURE),
      makeRunUserLine(),
    ];
    const outcome = await run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
    expect(outcome?.additionalContext).toContain("Retrospective trigger detected");
    expect(outcome?.calibration).toBeDefined();
    const cal = outcome?.calibration as {
      source?: string;
      matches: Array<{ family: string; phrase: string }>;
    };
    expect(cal.matches.some((m) => m.family === "R1")).toBe(true);
    // SC#5 (mt#2554): runtime fires are stamped source:"live" so the
    // coverage-receipt gate can tell them from synthetic fixture entries.
    expect(cal.source).toBe("live");
  });

  test("no match -> null (silent allow)", async () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine("Nothing noteworthy here."),
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
      makeRunAssistantLine(APOLOGY_FIXTURE),
      makeRunUserLine(),
    ];
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const outcome = await run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
      expect(outcome?.additionalContext).toBeUndefined();
      expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
    } finally {
      delete process.env[OVERRIDE_ENV_VAR];
    }
  });
});

// ---------------------------------------------------------------------------
// filterStopFlagged (mt#2357) — turn-end dedup on the prompt-time side
// ---------------------------------------------------------------------------

describe("filterStopFlagged (mt#2357)", () => {
  const R1_PHRASE = "I made a mistake";
  const opening: TranscriptLine = {
    type: "user",
    message: { role: "user", content: "deploy it" },
    uuid: "u-open",
  };
  const lines: TranscriptLine[] = [
    opening,
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${R1_PHRASE} in the deploy step.` }],
      },
    },
    { type: "user", message: { role: "user", content: "why did that happen?" } },
  ];
  const r1Match = { family: "R1" as const, matchedPhrase: R1_PHRASE };

  test("a phrase flagged by the Stop-time scan of the same turn is dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mt2357-scanner-dedup-"));
    try {
      writeFlagged("s-1", new Set([flagKey(turnKeyFor(opening), "R1", R1_PHRASE)]), dir);
      expect(filterStopFlagged("s-1", lines, [r1Match], dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unflagged match passes through; empty store is a no-op", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mt2357-scanner-dedup-"));
    try {
      expect(filterStopFlagged("s-1", lines, [r1Match], dir)).toEqual([r1Match]);
      // PR #2148 R1: non-Stop-scanned families pass through even when a
      // MATCHING store key exists — the family allowlist is enforced in
      // code, not just at call sites.
      const userCorrection = { family: "user-correction" as const, matchedPhrase: "why did you" };
      writeFlagged(
        "s-1",
        new Set([
          flagKey(turnKeyFor(opening), "R1", R1_PHRASE),
          flagKey(turnKeyFor(opening), "user-correction", "why did you"),
        ]),
        dir
      );
      expect(filterStopFlagged("s-1", lines, [userCorrection], dir)).toEqual([userCorrection]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Quote/meta-discussion suppression (mt#2672) — the 2026-07-08 calibration
// review window's 5 FPs and 3 real positives, reproduced verbatim from
// .minsky/retrospective-trigger-calibration.jsonl transcript excerpts.
// ---------------------------------------------------------------------------

describe("mt#2672 — calibration-window FP fixtures do NOT fire", () => {
  const fpExcerpts: Array<[string, string]> = [
    [
      "2026-06-14 (quoting rule text while discussing the calibration signal)",
      " the agent quoting the rule text `\"that's wrong\"`, or noting `\"I did not write 'I made a mistake' in any recent turn\"`). That's exactly the calibration signal the system exists",
    ],
    [
      "2026-06-15 (quoting the calibration-log fire, nested escaped quotes)",
      ' — and grounded in the calibration log, not assumed:\n\nThe fire is **family R1, "I should have caught"**, excerpt: *"...the retrospective hook never saw "I should have caught it" "*',
    ],
    [
      "2026-06-16 (describing the documented FP)",
      'n false positive** as last turn — the regex matched my *quoting* of the phrase "I should have caught" while discussing the detector itself, not a live failure. That\'s already triag',
    ],
    [
      "2026-06-18 (same documented FP again)",
      'rospective hook fired on the same documented false positive again — me quoting "I should have caught" while discussing the detector; not re-running it, it\'s logged.)\n\nInvoking the ',
    ],
    [
      "2026-06-25 (precision-axis proposal quoting the phrase)",
      'o cost; targets the precision axis that caused both known false positives (the "I should have caught" fired-on-a-quote incidents).\n- **Rung 2** — embedding recall-widening (only if',
    ],
  ];

  for (const [label, excerpt] of fpExcerpts) {
    test(`FP ${label} → no fire`, async () => {
      expect(detectTriggerPhrases(excerpt).length).toBe(0);
    });
  }
});

describe("mt#2672 — calibration-window real positives still fire", () => {
  const realExcerpts: Array<[string, string]> = [
    [
      "2026-06-19 (live 'I conflated the two surfaces')",
      'ce to get full coverage. (The earlier "defer UUIDs" caveat never applied here — I conflated the two surfaces.)\n\n**Cockpit (mt#2518): all types via resolution, not shape-gu',
    ],
    [
      "2026-06-26a (live 'I conflated them earlier')",
      'ing to the confusion\n\nThere are **two different "agent" surfaces** in play, and I conflated them earlier:\n\n1. **Claude Code Agent View / "FleetView"** — the *harness* feat',
    ],
    [
      "2026-06-26b (live compound admission)",
      'rse, not better: I misread the subagent state (stale output-file mtime ≠ done), I conflated FleetView vs. the cockpit, and I used "FleetView" as if I knew it when I was gu',
    ],
  ];

  for (const [label, excerpt] of realExcerpts) {
    test(`real positive ${label} → fires R1`, async () => {
      const matches = detectTriggerPhrases(excerpt);
      expect(matches.some((m) => m.family === "R1")).toBe(true);
    });
  }
});

describe("mt#2672 — suppression mechanics", () => {
  test("double-quoted trigger phrase in ordinary prose does not fire", async () => {
    const matches = detectTriggerPhrases(
      'The log shows the phrase "I made a mistake" appearing twice this week.'
    );
    expect(matches.length).toBe(0);
  });

  test("meta-discussion marker alone suppresses an unquoted phrase echo", async () => {
    expect(isDetectorMetaDiscussion("reviewing the calibration data now")).toBe(true);
    const matches = detectTriggerPhrases(
      "While reviewing the calibration data, the phrase I should have caught appears in record 3."
    );
    expect(matches.length).toBe(0);
  });

  test("ordinary work turn is NOT meta-discussion", async () => {
    expect(isDetectorMetaDiscussion("I conflated the two surfaces during the refactor.")).toBe(
      false
    );
  });

  test("user-correction: quoted phrase does not fire, live phrase does", async () => {
    expect(detectUserCorrection('the doc says users type "that\'s wrong" here').length).toBe(0);
    expect(detectUserCorrection("that's wrong, the port is 4317").length).toBe(1);
  });
});

describe("mt#2672 — codified boundaries (PR #1834 R1)", () => {
  test("boundary: >200-char single-line double-quoted span is NOT elided — documented residual, still fires", async () => {
    const padding = "x".repeat(210);
    const text = `The log contains "${padding} I made a mistake ${padding}" as one entry.`;
    const matches = detectTriggerPhrases(text);
    expect(matches.some((m) => m.family === "R1")).toBe(true);
  });

  test("boundary: multiline double-quoted material is NOT elided by quote elision — still fires (markdown quoting uses blockquotes, which ARE elided)", async () => {
    const text = 'She wrote: "first line of quote\nI made a mistake on the config\nlast line" end.';
    const matches = detectTriggerPhrases(text);
    expect(matches.some((m) => m.family === "R1")).toBe(true);
  });

  test("boundary: the same multiline material as a blockquote IS elided — no fire", async () => {
    const text =
      "She wrote:\n> first line of quote\n> I made a mistake on the config\n> last line\nend.";
    expect(detectTriggerPhrases(text).length).toBe(0);
  });

  test("policy lock: meta-marked turn with a live UNQUOTED admission is suppressed whole-turn (deliberate FN tradeoff)", async () => {
    const text =
      "Reviewing the calibration data now. Separately: I conflated the two surfaces during the refactor — that one was a genuine live admission.";
    expect(isDetectorMetaDiscussion(text)).toBe(true);
    expect(detectTriggerPhrases(text).length).toBe(0);
  });

  test("policy lock: user-correction is NOT meta-suppressed even in a calibration-discussion prompt", async () => {
    const matches = detectUserCorrection("that's wrong — the calibration data shows 5 FPs, not 3");
    expect(matches.length).toBe(1);
    expect(matches[0]?.family).toBe("user-correction");
  });
});

// ---------------------------------------------------------------------------
// Method-redirect family (mt#2446): user redirects the agent's METHOD
// (research-before-design) after the agent produced a design/recommendation.
// ---------------------------------------------------------------------------

const DESIGN_TURN =
  "Recommendation: Option A — snapshot the schema and stamp the ledger baseline. " +
  "I recommend this approach: it avoids replaying old migrations.";

describe("method-redirect patterns (mt#2446)", () => {
  const positives = [
    "I think you should do some research on the appropriate way to handle this using drizzle",
    "you should do more research before we commit to this",
    "you should research the vendor docs first",
    "we should research how other tools do this",
    "did you check how drizzle does this?",
    "did you look at how the community solves this?",
    "is there a standard way to do this?",
    "is there a canonical way to handle baselines?",
    "is there a recommended way to set this up?",
    "is there a proper way to do migrations?",
    "how does drizzle handle this?",
    "how does terraform do this?",
    "look at how the community handles this",
    "look at how others do this",
    "look at how pulumi handles this",
    "how does drizzle-kit handle this?",
    "how does next.js do this?",
    "look at how drizzle-kit handles migrations",
    "what's the appropriate way to handle this?",
    "what's the right way to do this in drizzle?",
    "what's the canonical way to baseline a migration ledger?",
  ];

  for (const phrase of positives) {
    test(`matches with design context: "${phrase.slice(0, 60)}"`, async () => {
      const matches = detectMethodRedirect(phrase, DESIGN_TURN);
      expect(matches.length).toBe(1);
      expect(matches[0]?.family).toBe("method-redirect");
    });
  }

  const negatives = [
    // Open research question shape — "should we" is not "we should"
    "should we research observability platforms?",
    // Ordinary operational prompts
    "proceed with the implementation",
    "what's the status of the PR?",
    "run the tests and merge",
    // "way" phrases without the method-redirect qualifiers
    "is there a way to skip CI?",
    "what's the fastest way to get this merged?",
    // "look at how" phrasings outside the pinned verb set (handles/handle/do/does)
    "look at how much time this took",
    "take a look at how things went",
  ];

  for (const phrase of negatives) {
    test(`does NOT match even with design context: "${phrase.slice(0, 60)}"`, async () => {
      expect(detectMethodRedirect(phrase, DESIGN_TURN).length).toBe(0);
    });
  }
});

describe("method-redirect context condition (mt#2446)", () => {
  const REDIRECT = "I think you should do some research on the appropriate way to handle this";

  test("does NOT fire without a design in the prior assistant turn", async () => {
    expect(
      detectMethodRedirect(REDIRECT, "Let me look into the spec and report back.").length
    ).toBe(0);
  });

  test("does NOT fire with an empty prior assistant turn", async () => {
    expect(detectMethodRedirect(REDIRECT, "").length).toBe(0);
  });

  test("spec acceptance: open research question with NO prior design does not fire", async () => {
    expect(
      detectMethodRedirect(
        "should we research observability platforms?",
        "What would you like to work on next?"
      ).length
    ).toBe(0);
  });

  const designMarkerCases: Array<[string, string]> = [
    ["Option A/B labels", "Two candidates. Option A uses a sweeper; Option B uses a queue."],
    ["recommendation", "My recommendation is the sweeper."],
    ["Plan decision", "Plan decision: bespoke snapshot-and-stamp baseline."],
    ["I recommend", "I recommend the snapshot approach."],
    ["approach:", "Proposed approach: stamp the ledger high-water mark."],
  ];

  for (const [label, designText] of designMarkerCases) {
    test(`design marker recognized: ${label}`, async () => {
      expect(hasDesignContext(designText)).toBe(true);
      expect(detectMethodRedirect(REDIRECT, designText).length).toBe(1);
    });
  }

  test("plain operational prose is not design context", async () => {
    expect(hasDesignContext("Committed the fix and pushed. Tests pass.")).toBe(false);
  });
});

describe("method-redirect elision guard (mt#2446)", () => {
  test("QUOTED redirect phrase (discussing, not redirecting) does not fire", async () => {
    const matches = detectMethodRedirect(
      'The mt#2439 retro quotes the user saying "you should do some research on this" — add that family.',
      DESIGN_TURN
    );
    expect(matches.length).toBe(0);
  });

  test("redirect phrase inside a code span does not fire", async () => {
    const matches = detectMethodRedirect(
      "Add the pattern `you should do some research` to the scanner.",
      DESIGN_TURN
    );
    expect(matches.length).toBe(0);
  });
});

describe("method-redirect through run() (mt#2446 acceptance replay)", () => {
  test("mt#2439-shaped exchange fires with family method-redirect + live calibration record", async () => {
    // Tool-interleaved turn (per memory a3e60471): the design text lands in the
    // FIRST assistant segment, followed by tool_use / tool_result rounds — the
    // context condition must still see it.
    const transcriptLines: TranscriptLine[] = [
      makeRunUserLine("plan the migration baseline"),
      makeRunAssistantLine(
        "Recommendation: Option A — snapshot the current schema and stamp the ledger."
      ),
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: {} }] },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
        },
      },
      makeRunAssistantLine("Spec updated with the plan decision."),
      makeRunUserLine(
        "I think you should do some research on the appropriate way to handle this using drizzle"
      ),
    ];
    const outcome = await run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
    expect(outcome?.additionalContext).toContain("redirected your method");
    expect(outcome?.additionalContext).toContain("research-before-design");
    const cal = outcome?.calibration as {
      source?: string;
      matches: Array<{ family: string; phrase: string }>;
    };
    expect(cal.matches.some((m) => m.family === "method-redirect")).toBe(true);
    expect(cal.source).toBe("live");
  });

  test("same redirect prompt after a NO-design turn returns null", async () => {
    const transcriptLines: TranscriptLine[] = [
      makeRunUserLine("hows it going"),
      makeRunAssistantLine("Still reading the auth module, no blockers."),
      makeRunUserLine("I think you should do some research on the appropriate way to handle this"),
    ];
    expect(await run(RUN_HOOK_INPUT, makeCtx(transcriptLines))).toBeNull();
  });

  test("existing families still fire alongside method-redirect wiring (regression)", async () => {
    const transcriptLines: TranscriptLine[] = [
      makeRunUserLine(),
      makeRunAssistantLine(APOLOGY_FIXTURE),
      makeRunUserLine(),
    ];
    const outcome = await run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
    const cal = outcome?.calibration as { matches: Array<{ family: string }> };
    expect(cal.matches.some((m) => m.family === "R1")).toBe(true);
  });

  test("override env var suppresses method-redirect detection too", async () => {
    const transcriptLines: TranscriptLine[] = [
      makeRunUserLine("plan it"),
      makeRunAssistantLine("Recommendation: Option A."),
      makeRunUserLine("you should do some research on the proper way first"),
    ];
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const outcome = await run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
      expect(outcome?.additionalContext).toBeUndefined();
      expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
    } finally {
      delete process.env[OVERRIDE_ENV_VAR];
    }
  });
});

// ---------------------------------------------------------------------------
// mt#3036 — multi-turn retrospective suppression + retro-output-shape META
//
// The "already invoked /retrospective" gate was scoped to the last assistant
// turn only. A multi-turn retrospective (Skill invoked in turn N, advisor
// subagent output landing in turn N+2) escaped the gate: the output turn
// itself contains R1 vocabulary ("I conflated", "I should have caught")
// because the /retrospective skill's Step 2a taxonomy REQUIRES those phrases
// in the report. Widened to a K=5-turn look-back plus new META markers for
// the retro output shape.
// ---------------------------------------------------------------------------

function makeSkillRetrospectiveLine(): TranscriptLine {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "Skill", input: { skill: "retrospective" } }],
    },
  };
}

function makeToolResultUserLine(): TranscriptLine {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
    },
  };
}

describe("mt#3036 — hasRecentRetrospectiveInvocation (widened look-back)", () => {
  test("finds a /retrospective invocation in the just-completed turn", async () => {
    // 2 real prompts, 1 completed turn between them: the invocation lives in
    // that turn. Trivially covers the same-turn case (existing behavior).
    const lines: TranscriptLine[] = [
      makeRunUserLine("start"),
      makeSkillRetrospectiveLine(),
      makeRunUserLine("next"),
    ];
    expect(hasRecentRetrospectiveInvocation(lines)).toBe(true);
  });

  test("finds a /retrospective invocation 2 turns back (mt#3036 primary case)", async () => {
    // Turn N: invocation. Turn N+1: advisor tool result / interstitial.
    // Turn N+2: the retrospective's structured output (the current just-
    // completed turn). Same-turn-only look-back missed the invocation in N.
    const lines: TranscriptLine[] = [
      makeRunUserLine("plan mt#XXXX"),
      makeSkillRetrospectiveLine(),
      makeToolResultUserLine(),
      makeRunUserLine("continue"),
      makeRunAssistantLine("Advisor working; will report back."),
      makeRunUserLine("show me"),
      makeRunAssistantLine(
        "## Retrospective: X\n\n### Agent error (cognitive)\n\nAssumption Error — I conflated two surfaces."
      ),
      makeRunUserLine("thanks"),
    ];
    expect(hasRecentRetrospectiveInvocation(lines)).toBe(true);
  });

  test("returns false when no /retrospective invocation appears anywhere recent", async () => {
    const lines: TranscriptLine[] = [
      makeRunUserLine("do the thing"),
      makeRunAssistantLine("I conflated the two surfaces."),
      makeRunUserLine("why?"),
    ];
    expect(hasRecentRetrospectiveInvocation(lines)).toBe(false);
  });

  test("returns false when the /retrospective invocation is older than the look-back window", async () => {
    // 7 completed turns, invocation in the OLDEST turn. K=5 window excludes it.
    const lines: TranscriptLine[] = [
      makeRunUserLine("p1"),
      makeSkillRetrospectiveLine(), // turn 1 (7 back from current)
      makeRunUserLine("p2"),
      makeRunAssistantLine("t2"),
      makeRunUserLine("p3"),
      makeRunAssistantLine("t3"),
      makeRunUserLine("p4"),
      makeRunAssistantLine("t4"),
      makeRunUserLine("p5"),
      makeRunAssistantLine("t5"),
      makeRunUserLine("p6"),
      makeRunAssistantLine("t6"),
      makeRunUserLine("p7"),
      makeRunAssistantLine("t7"),
      makeRunUserLine("current"),
    ];
    expect(hasRecentRetrospectiveInvocation(lines)).toBe(false);
  });

  test("scans only the K most-recent completed turns", async () => {
    // Same 7-turn shape, but /retrospective invocation moved into the
    // 3rd-from-last turn: within K=5, so it IS found.
    const lines: TranscriptLine[] = [
      makeRunUserLine("p1"),
      makeRunAssistantLine("t1"),
      makeRunUserLine("p2"),
      makeRunAssistantLine("t2"),
      makeRunUserLine("p3"),
      makeRunAssistantLine("t3"),
      makeRunUserLine("p4"),
      makeRunAssistantLine("t4"),
      makeRunUserLine("p5"),
      makeSkillRetrospectiveLine(), // 3 turns back from current — inside K=5
      makeRunUserLine("p6"),
      makeRunAssistantLine("t6"),
      makeRunUserLine("p7"),
      makeRunAssistantLine("t7"),
      makeRunUserLine("current"),
    ];
    expect(hasRecentRetrospectiveInvocation(lines)).toBe(true);
  });

  test("returns false for empty transcript / fewer than 1 prompt", async () => {
    expect(hasRecentRetrospectiveInvocation([])).toBe(false);
    expect(hasRecentRetrospectiveInvocation([makeRunAssistantLine("orphan")])).toBe(false);
  });

  test("look-back window is configurable (K=2 excludes an older invocation)", async () => {
    // Invocation 3 turns back; with K=2 window, it should be missed.
    const lines: TranscriptLine[] = [
      makeRunUserLine("p1"),
      makeSkillRetrospectiveLine(),
      makeRunUserLine("p2"),
      makeRunAssistantLine("t2"),
      makeRunUserLine("p3"),
      makeRunAssistantLine("t3"),
      makeRunUserLine("current"),
    ];
    expect(hasRecentRetrospectiveInvocation(lines, 2)).toBe(false);
    expect(hasRecentRetrospectiveInvocation(lines, 5)).toBe(true);
  });
});

describe("mt#3036 — retro output-shape META markers suppress trigger phrases", () => {
  const RETRO_MARKERS: Array<[string, string]> = [
    [
      "## Retrospective: heading",
      "## Retrospective: multi-turn suppression\n\nI conflated X and Y.",
    ],
    [
      "### Agent error (cognitive)",
      "### Agent error (cognitive)\n\nAssumption Error — I should have caught the drift.",
    ],
    [
      "### Recurrence check header",
      "### Recurrence check\n\nR4 of this family. I should have caught the R3 pattern.",
    ],
    [
      "### Recurrence-after-DONE header",
      "### Recurrence-after-DONE\n\nContradiction: shipped mt#XXXX did not contain the class. I conflated scope with mechanism.",
    ],
    [
      "**Correction noted**: compressed format",
      "**Correction noted**: format label drift. I conflated section titles.",
    ],
  ];

  for (const [label, excerpt] of RETRO_MARKERS) {
    test(`retro marker "${label}" suppresses R-family match`, async () => {
      expect(isDetectorMetaDiscussion(excerpt)).toBe(true);
      expect(detectTriggerPhrases(excerpt).length).toBe(0);
    });
  }

  test("policy lock: retro-output-shape suppression does NOT reach user-correction", async () => {
    // A user turn saying "why did you do that?" while discussing a retro
    // still fires — mirrors the mt#2672 policy (user-correction stays live
    // in every meta context).
    const matches = detectUserCorrection(
      "why did you do that when the retrospective ## Retrospective: section already covered it?"
    );
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0]?.family).toBe("user-correction");
  });

  test("ordinary prose mentioning 'retrospective' alone is not meta (specific markers required)", async () => {
    // Sanity check: the word 'retrospective' by itself is NOT a marker — only
    // structured-output shapes are. Otherwise the compressed markers would
    // over-fire in ordinary discussion.
    expect(isDetectorMetaDiscussion("Let me run a retrospective on this after the merge.")).toBe(
      false
    );
  });

  // PR #2169 R1: generic RCA / design-doc headings must NOT trigger the
  // retro META gate — they appear in ordinary specs, ADRs, and incident
  // memos, and suppressing R-family scanning on that content would silence
  // real admissions.
  test("generic '### Root cause' heading (in an ADR or spec) is NOT retro-meta", async () => {
    expect(
      isDetectorMetaDiscussion(
        "## Context\n\n### Root cause\n\nThe migration ledger drifted when the baseline was stamped."
      )
    ).toBe(false);
  });

  test("generic '### Failure mode:' heading (in an incident memo) is NOT retro-meta", async () => {
    expect(
      isDetectorMetaDiscussion(
        "### Failure mode: race condition\n\nTwo writers contended for the same row."
      )
    ).toBe(false);
  });
});

describe("mt#3036 — run() suppression: multi-turn retro invocation blocks R-family only", () => {
  test("R1 phrase in a later turn is suppressed when /retrospective was invoked 2 turns back", async () => {
    // The originating incident: /retrospective invoked in turn N;
    // advisor's structured output lands in turn N+2 with "I conflated" in it.
    // Under mt#3036 the widened look-back finds the invocation and suppresses
    // the assistant-side R-family scan.
    const transcriptLines: TranscriptLine[] = [
      makeRunUserLine("run a retro on the last incident"),
      makeSkillRetrospectiveLine(),
      makeRunUserLine("continue"),
      makeRunAssistantLine("Advisor dispatched; awaiting return."),
      makeRunUserLine("show the report"),
      makeRunAssistantLine(
        "## Retrospective: mt#3036\n\n### Agent error (cognitive)\n\nAssumption Error — I conflated the invocation turn with the output turn."
      ),
      makeRunUserLine("next"),
    ];
    expect(await run(RUN_HOOK_INPUT, makeCtx(transcriptLines))).toBeNull();
  });

  test("R1 phrase without any recent /retrospective still fires (regression guard)", async () => {
    const transcriptLines: TranscriptLine[] = [
      makeRunUserLine("do the thing"),
      makeRunAssistantLine("I conflated the two data paths in the migration."),
      makeRunUserLine("really?"),
    ];
    const outcome = await run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
    expect(outcome?.additionalContext).toContain("Retrospective trigger detected");
    const cal = outcome?.calibration as { matches: Array<{ family: string }> };
    expect(cal.matches.some((m) => m.family === "R1")).toBe(true);
  });

  // PR #2169 R1: the widened look-back must ONLY silence the assistant-side
  // R-family scan. User-side signals (user-correction, method-redirect)
  // remain live for the whole K-turn window — a course-correction 2-4 turns
  // after a completed retrospective is not the same event and must fire.
  test("user-correction in the current prompt STILL fires when /retrospective was invoked recently", async () => {
    const transcriptLines: TranscriptLine[] = [
      makeRunUserLine("run a retro"),
      makeSkillRetrospectiveLine(),
      makeRunUserLine("continue"),
      makeRunAssistantLine("Retrospective completed; fixes filed."),
      makeRunUserLine("why did you do that when I told you not to?"),
    ];
    const outcome = await run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
    expect(outcome?.additionalContext).toContain("User correction signal detected");
    const cal = outcome?.calibration as { matches: Array<{ family: string }> };
    expect(cal.matches.some((m) => m.family === "user-correction")).toBe(true);
  });

  test("method-redirect STILL fires when /retrospective was invoked recently", async () => {
    // Prior assistant turn carries a design marker (Recommendation:) so
    // the method-redirect context condition is satisfied; a recent
    // `/retrospective` must not suppress this course-correction signal.
    const transcriptLines: TranscriptLine[] = [
      makeRunUserLine("run a retro on this"),
      makeSkillRetrospectiveLine(),
      makeRunUserLine("now propose the fix"),
      makeRunAssistantLine("Recommendation: Option A — sweep the queue every 60s."),
      makeRunUserLine(
        "I think you should do some research on the appropriate way to handle this in drizzle"
      ),
    ];
    const outcome = await run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
    expect(outcome?.additionalContext).toContain("redirected your method");
    const cal = outcome?.calibration as { matches: Array<{ family: string }> };
    expect(cal.matches.some((m) => m.family === "method-redirect")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rung 2: embedding nomination (mt#3408, ADR-024)
//
// Deps are injected, so these assert the UNION and DEGRADATION logic without a
// live provider. Whether real embeddings actually place the mt#3341 admission
// near an exemplar is a semantic question no fake vector can answer — that is
// measured live by scripts/verify-rung2-nomination.ts.
// ---------------------------------------------------------------------------

describe("detectTriggerPhrasesWithNomination (Rung 1 + Rung 2)", () => {
  const FLAT_ADMISSION = "I referenced the identifier before the call that mints it had run.";

  function depsReturning(similarTo: string[]): NominationDeps {
    return {
      semantic: true,
      embeddingService: {
        async generateEmbedding(content: string): Promise<number[]> {
          return similarTo.includes(content) ? [1, 0] : [0, 1];
        },
        async generateEmbeddings(contents: string[]): Promise<number[][]> {
          return contents.map((c) => (similarTo.includes(c) ? [1, 0] : [0, 1]));
        },
      },
    };
  }

  const failingDeps: NominationDeps = {
    semantic: true,
    embeddingService: {
      generateEmbedding: () => Promise.reject(new Error("provider down")),
      generateEmbeddings: () => Promise.reject(new Error("provider down")),
    },
  };

  beforeEach(() => {
    delete process.env.MINSKY_DISABLE_RUNG2_NOMINATION;
    delete process.env.MINSKY_RUNG2_NOMINATION_ENFORCE;
  });

  afterEach(() => {
    process.env.MINSKY_DISABLE_RUNG2_NOMINATION = "1";
    delete process.env.MINSKY_RUNG2_NOMINATION_ENFORCE;
  });

  test("nominates a family Rung 1 did not match (enforcing)", async () => {
    process.env.MINSKY_RUNG2_NOMINATION_ENFORCE = "1";
    // Rung 1 alone is blind to this flat, non-apologetic admission.
    expect(detectTriggerPhrases(FLAT_ADMISSION)).toEqual([]);

    const r1Exemplar = NOMINATION_EXEMPLARS[0]?.exemplars[4] as string;
    const result = await detectTriggerPhrasesWithNomination(
      FLAT_ADMISSION,
      depsReturning([FLAT_ADMISSION, r1Exemplar])
    );

    expect(result.degradedReason).toBeUndefined();
    expect(result.enforcing).toBe(true);
    expect(result.nominatedFamilies).toContain("R1");
    expect(result.matches.map((m) => m.family)).toContain("R1");
  });

  test("log-only by default: nomination is REPORTED but never reaches matches", async () => {
    const r1Exemplar = NOMINATION_EXEMPLARS[0]?.exemplars[4] as string;
    const result = await detectTriggerPhrasesWithNomination(
      FLAT_ADMISSION,
      depsReturning([FLAT_ADMISSION, r1Exemplar])
    );

    // The nomination happened and is visible to the calibration log...
    expect(result.nominatedFamilies).toContain("R1");
    expect(result.enforcing).toBe(false);
    // ...but it must NOT reach the injected reminder. Measured precision on a
    // real-transcript sample was 3/3 false positives; ADR-024 sign-off (b)
    // requires 0 known-FP before this contributes to a fire.
    expect(result.matches).toEqual([]);
  });

  test("does not duplicate a family Rung 1 already matched", async () => {
    const text = "I should have caught this earlier.";
    const rung1 = detectTriggerPhrases(text);
    expect(rung1.map((m) => m.family)).toContain("R1");

    const r1Exemplar = NOMINATION_EXEMPLARS[0]?.exemplars[1] as string;
    const result = await detectTriggerPhrasesWithNomination(
      text,
      depsReturning([text, r1Exemplar])
    );

    expect(result.nominatedFamilies).not.toContain("R1");
    expect(result.matches.filter((m) => m.family === "R1")).toHaveLength(1);
  });

  test("a degraded provider preserves the Rung-1 result and reports the reason", async () => {
    const text = "I should have caught this earlier.";
    const result = await detectTriggerPhrasesWithNomination(text, failingDeps);

    expect(result.degradedReason).toBe("provider-error");
    expect(result.matches.map((m) => m.family)).toContain("R1");
    expect(result.nominatedFamilies).toEqual([]);
  });

  test("an unconfigured provider degrades rather than throwing", async () => {
    const result = await detectTriggerPhrasesWithNomination(FLAT_ADMISSION, null);
    expect(result.degradedReason).toBe("provider-unconfigured");
    expect(result.matches).toEqual([]);
  });

  test("meta-discussion suppression applies to Rung 2, not just Rung 1", async () => {
    const meta = `Reviewing the retrospective-trigger calibration log: ${FLAT_ADMISSION}`;
    const before = detectTriggerPhrases(meta);

    const result = await detectTriggerPhrasesWithNomination(
      meta,
      depsReturning([meta, FLAT_ADMISSION])
    );

    // Whatever Rung 1 concluded about a meta turn, Rung 2 must not add to it.
    expect(result.matches).toEqual(before);
    expect(result.nominatedFamilies).toEqual([]);
  });

  test("the kill switch skips Rung 2 without recording a degradation", async () => {
    process.env.MINSKY_DISABLE_RUNG2_NOMINATION = "1";
    const r1Exemplar = NOMINATION_EXEMPLARS[0]?.exemplars[4] as string;

    const result = await detectTriggerPhrasesWithNomination(
      FLAT_ADMISSION,
      depsReturning([FLAT_ADMISSION, r1Exemplar])
    );

    expect(result.nominatedFamilies).toEqual([]);
    // An operator disabling the stage is not a provider failure.
    expect(result.degradedReason).toBeUndefined();
  });
});
