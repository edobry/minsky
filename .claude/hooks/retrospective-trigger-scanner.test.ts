import { describe, expect, test } from "bun:test";
import {
  detectTriggerPhrases,
  detectUserCorrection,
  extractAssistantText,
  extractLastAssistantTurn,
  extractLastUserMessage,
  hasRetrospectiveSkillInvocation,
} from "./retrospective-trigger-scanner";

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
