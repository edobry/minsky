import { describe, expect, test } from "bun:test";
import {
  detectTriggerPhrases,
  detectUserCorrection,
  hasRetrospectiveSkillInvocation,
  isDetectorMetaDiscussion,
  OVERRIDE_ENV_VAR,
  run,
} from "./retrospective-trigger-scanner";
import {
  extractAssistantText,
  extractLastAssistantTurn,
  extractLastUserMessage,
} from "./transcript";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";

const WHY_DID_YOU_DO_THAT = "why did you do that?";

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
  ];

  for (const phrase of cases) {
    test(`matches: "${phrase}"`, () => {
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
    test(`matches: "${phrase}"`, () => {
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
  ];

  for (const phrase of cases) {
    test(`matches: "${phrase}"`, () => {
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
    test(`matches: "${phrase}"`, () => {
      const matches = detectTriggerPhrases(phrase);
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches.some((m) => m.family === "R4")).toBe(true);
    });
  }
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
    // NOTE: quoted trigger phrases in documentation text ("The hook detects
    // phrases like 'I owe you an apology'") ARE a known false-positive class.
    // SC#4 accepts this — advisory-only, tracked via calibration log.
  ];

  for (const phrase of cases) {
    test(`does NOT match: "${phrase.slice(0, 60)}..."`, () => {
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
    test(`matches correction: "${phrase}"`, () => {
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
    test(`does NOT match correction: "${phrase}"`, () => {
      const matches = detectUserCorrection(phrase);
      expect(matches.length).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Multi-family detection (single text triggers multiple families)
// ---------------------------------------------------------------------------

describe("multi-family detection", () => {
  test("text with R1 + R3 triggers both families", () => {
    const text =
      "I should have caught this earlier. Going forward I will always check the spec first.";
    const matches = detectTriggerPhrases(text);
    const families = new Set(matches.map((m) => m.family));
    expect(families.has("R1")).toBe(true);
    expect(families.has("R3")).toBe(true);
  });

  test("text with R2 + R4 triggers both families", () => {
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
  test("suppresses when Skill tool with retrospective is in the turn", () => {
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

  test("does NOT suppress when no Skill tool in turn", () => {
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

  test("does NOT suppress when Skill tool is for a different skill", () => {
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
  test("suppression predicate fires for top-level tool_use format", () => {
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
  test("extracts assistant lines between second-to-last and last user messages", () => {
    const lines = [
      { type: "user", message: { role: "user", content: "first prompt" } },
      { type: "assistant", message: { role: "assistant", content: "first response" } },
      { type: "user", message: { role: "user", content: "second prompt" } },
    ];
    const turn = extractLastAssistantTurn(lines);
    expect(turn.length).toBe(1);
    expect(turn[0]?.message?.content).toBe("first response");
  });

  test("returns empty when fewer than 2 user messages", () => {
    const lines = [{ type: "user", message: { role: "user", content: "only prompt" } }];
    expect(extractLastAssistantTurn(lines)).toEqual([]);
  });

  // mt#2255: a trigger phrase in a NON-FINAL assistant segment of a multi-tool-round
  // turn must still be surfaced. The old user-role split bounded the turn at the last
  // tool_result, dropping the first segment (Surface 1 never fired — the reason the
  // hook existed). With real-prompt bounds, the whole turn is scanned.
  test("trigger phrase in the FIRST segment of a multi-round turn is still detected", () => {
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
  test("extracts string content", () => {
    const lines = [{ type: "assistant", message: { role: "assistant", content: "hello world" } }];
    expect(extractAssistantText(lines)).toBe("hello world");
  });

  test("extracts from content array", () => {
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
  test("extracts last user message text", () => {
    const lines = [
      { type: "user", message: { role: "user", content: "first" } },
      { type: "assistant", message: { role: "assistant", content: "response" } },
      { type: "user", message: { role: "user", content: WHY_DID_YOU_DO_THAT } },
    ];
    expect(extractLastUserMessage(lines)).toBe(WHY_DID_YOU_DO_THAT);
  });

  test("returns empty string when no user messages", () => {
    expect(extractLastUserMessage([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Smart quote handling
// ---------------------------------------------------------------------------

describe("smart quote handling", () => {
  test("R2 matches with smart apostrophe", () => {
    const matches = detectTriggerPhrases("I didn’t think it through");
    expect(matches.some((m) => m.family === "R2")).toBe(true);
  });

  test("R3 matches with smart apostrophe", () => {
    const matches = detectTriggerPhrases("going forward I’ll check first");
    expect(matches.some((m) => m.family === "R3")).toBe(true);
  });

  test("user correction matches with smart apostrophe", () => {
    const matches = detectUserCorrection("that’s wrong");
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// R5: Finding-reframing (mt#2112)
// ---------------------------------------------------------------------------

describe("R5 finding-reframing", () => {
  test("matches first-person approach + anti-pattern", () => {
    const matches = detectTriggerPhrases(
      "the approach I was implementing is considered an anti-pattern"
    );
    expect(matches.some((m) => m.family === "R5")).toBe(true);
  });

  test("matches 'I was using' + anti-pattern", () => {
    const matches = detectTriggerPhrases(
      "the pattern I was using is a known anti-pattern in monorepos"
    );
    expect(matches.some((m) => m.family === "R5")).toBe(true);
  });

  test("matches honesty framing + anti-pattern", () => {
    const matches = detectTriggerPhrases("I should be honest: this is an anti-pattern");
    expect(matches.some((m) => m.family === "R5")).toBe(true);
  });

  test("matches first-person + research reveals", () => {
    const matches = detectTriggerPhrases(
      "I chose this but research reveals the pattern is wrong for this use case"
    );
    expect(matches.some((m) => m.family === "R5")).toBe(true);
  });

  test("matches first-person + community consensus", () => {
    const matches = detectTriggerPhrases(
      "I went with this but community consensus is against this approach"
    );
    expect(matches.some((m) => m.family === "R5")).toBe(true);
  });

  test("matches 'I was implementing' + anti-pattern", () => {
    const matches = detectTriggerPhrases("I was implementing what turns out to be an anti-pattern");
    expect(matches.some((m) => m.family === "R5")).toBe(true);
  });

  test("does NOT match general anti-pattern discussion without self-reference", () => {
    const matches = detectTriggerPhrases("barrel exports are considered an anti-pattern");
    expect(matches.some((m) => m.family === "R5")).toBe(false);
  });

  test("does NOT match 'known anti-pattern' without self-reference", () => {
    const matches = detectTriggerPhrases("the system uses a known anti-pattern internally");
    expect(matches.some((m) => m.family === "R5")).toBe(false);
  });

  test("does NOT match general React discussion", () => {
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
  test("R1 trigger match -> additionalContext + calibration record", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine("I owe you an apology for that mistake."),
      makeRunUserLine(),
    ];
    const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
    expect(outcome?.additionalContext).toContain("Retrospective trigger detected");
    expect(outcome?.calibration).toBeDefined();
    const cal = outcome?.calibration as { matches: Array<{ family: string; phrase: string }> };
    expect(cal.matches.some((m) => m.family === "R1")).toBe(true);
  });

  test("no match -> null (silent allow)", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine("Nothing noteworthy here."),
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
      makeRunAssistantLine("I owe you an apology for that mistake."),
      makeRunUserLine(),
    ];
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
      expect(outcome?.additionalContext).toBeUndefined();
      expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
    } finally {
      delete process.env[OVERRIDE_ENV_VAR];
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
    test(`FP ${label} → no fire`, () => {
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
    test(`real positive ${label} → fires R1`, () => {
      const matches = detectTriggerPhrases(excerpt);
      expect(matches.some((m) => m.family === "R1")).toBe(true);
    });
  }
});

describe("mt#2672 — suppression mechanics", () => {
  test("double-quoted trigger phrase in ordinary prose does not fire", () => {
    const matches = detectTriggerPhrases(
      'The log shows the phrase "I made a mistake" appearing twice this week.'
    );
    expect(matches.length).toBe(0);
  });

  test("meta-discussion marker alone suppresses an unquoted phrase echo", () => {
    expect(isDetectorMetaDiscussion("reviewing the calibration data now")).toBe(true);
    const matches = detectTriggerPhrases(
      "While reviewing the calibration data, the phrase I should have caught appears in record 3."
    );
    expect(matches.length).toBe(0);
  });

  test("ordinary work turn is NOT meta-discussion", () => {
    expect(isDetectorMetaDiscussion("I conflated the two surfaces during the refactor.")).toBe(
      false
    );
  });

  test("user-correction: quoted phrase does not fire, live phrase does", () => {
    expect(detectUserCorrection('the doc says users type "that\'s wrong" here').length).toBe(0);
    expect(detectUserCorrection("that's wrong, the port is 4317").length).toBe(1);
  });
});
