import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  isRealUserPrompt,
  extractLastAssistantTurn,
  extractAssistantText,
  extractToolUseNames,
  extractLastUserMessage,
  findRealPromptIndices,
  extractFinalTurn,
  resolveCompletedTurn,
  resolveParentTranscriptLines,
  resolveParentTranscriptLinesForPath,
  readLogTailText,
  sessionHasLoggedKey,
  collectShortIdBindings,
  DEFAULT_MAX_DEDUPE_READ_BYTES,
  type TranscriptLine,
} from "./transcript";

// ---------------------------------------------------------------------------
// Transcript line builders (mirror the real Claude Code JSONL shapes)
// ---------------------------------------------------------------------------

const userPrompt = (text: string): TranscriptLine => ({
  type: "user",
  message: { role: "user", content: text },
});

const userPromptTextArray = (text: string): TranscriptLine => ({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
});

const toolResult = (id = "t1"): TranscriptLine => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
});

const assistantText = (text: string): TranscriptLine => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const assistantToolUse = (name: string): TranscriptLine => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", name, input: {} }] },
});

/**
 * Claude Code's harness-synthesized "the user cancelled this tool call"
 * marker — recorded with `role: "user"` and a single `{ type: "text" }`
 * block, matching the REAL shape observed in the two mt#2824 originating
 * incident transcripts (a9c1a09b, ac4f5675).
 */
const interruptMarker = (variant: "tool use" | "bare" = "tool use"): TranscriptLine => ({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "text",
        text:
          variant === "tool use"
            ? "[Request interrupted by user for tool use]"
            : "[Request interrupted by user]",
      },
    ],
  },
});

/**
 * The same synthetic interrupt marker, but as a bare STRING `message.content`
 * rather than an array-of-text-blocks — the content shape NOT observed in
 * the two originating transcripts, but which the PR #1963 R2 review flagged
 * as uncovered by the original fix (which only excluded the array shape and
 * asserted, without defensive justification, that the string shape was
 * safe). Uses `userPrompt`'s exact content shape (`message.content` is a
 * plain string) with the marker text as the string value.
 */
const interruptMarkerString = (variant: "tool use" | "bare" = "tool use"): TranscriptLine =>
  userPrompt(
    variant === "tool use"
      ? "[Request interrupted by user for tool use]"
      : "[Request interrupted by user]"
  );

/**
 * A Skill-tool invocation body — the harness-synthesized user-role line that
 * delivers a skill's instructions (mt#2357). Real shape verified against
 * live 2026-07-21 transcripts: `isMeta: true`, single text block opening
 * with "Base directory for this skill:". `withMeta: false` models a harness
 * version that does not stamp the flag — the text-prefix fallback must
 * still exclude it.
 */
const skillBody = (withMeta = true): TranscriptLine => ({
  type: "user",
  ...(withMeta ? { isMeta: true } : {}),
  message: {
    role: "user",
    content: [
      {
        type: "text",
        text: "Base directory for this skill: /Users/x/.claude/skills/implement-task\n\n# Implement Task\n\nStep-by-step...",
      },
    ],
  },
});

// ---------------------------------------------------------------------------
// isRealUserPrompt — the text-content discriminator
// ---------------------------------------------------------------------------

describe("isRealUserPrompt", () => {
  test("string content is a real prompt", () => {
    expect(isRealUserPrompt(userPrompt("do X"))).toBe(true);
  });

  test("text-block content array is a real prompt", () => {
    expect(isRealUserPrompt(userPromptTextArray("do X"))).toBe(true);
  });

  test("tool_result content array is NOT a real prompt", () => {
    expect(isRealUserPrompt(toolResult())).toBe(false);
  });

  test("whitespace-only string content IS a real prompt (string is never a tool_result)", () => {
    // A string-content user line is always human input — tool_result lines are
    // always content arrays — so it still resets the turn boundary (mt#2255 review).
    expect(isRealUserPrompt(userPrompt("   "))).toBe(true);
  });

  test("assistant line is NOT a user prompt", () => {
    expect(isRealUserPrompt(assistantText("hi"))).toBe(false);
  });

  // mt#2824: discovered while replaying the two originating silent-stretch
  // incident transcripts — this exact harness marker landed ~20ms before the
  // operator's real interrupt message in BOTH, and was originally
  // misclassified as a real prompt boundary, collapsing the measured turn
  // down to those 20ms and hiding the actual ~24/28-minute silent stretch.
  test("'[Request interrupted by user for tool use]' marker is NOT a real prompt", () => {
    expect(isRealUserPrompt(interruptMarker("tool use"))).toBe(false);
  });

  test("'[Request interrupted by user]' marker is NOT a real prompt", () => {
    expect(isRealUserPrompt(interruptMarker("bare"))).toBe(false);
  });

  // PR #1963 R2 (2026-07-15): the original fix excluded the marker only in
  // its array-of-text-blocks content shape (the shape actually observed in
  // the two originating transcripts) and asserted the STRING content shape
  // needed no check because the marker "hadn't been observed there." That
  // reasoning doesn't hold — the array shape's exact form was itself a
  // surprise, so "not yet observed" in the string shape is not evidence the
  // string shape is safe. Both shapes must exclude the marker identically.
  test("'[Request interrupted by user for tool use]' marker as STRING content is NOT a real prompt", () => {
    expect(isRealUserPrompt(interruptMarkerString("tool use"))).toBe(false);
  });

  test("'[Request interrupted by user]' marker as STRING content is NOT a real prompt", () => {
    expect(isRealUserPrompt(interruptMarkerString("bare"))).toBe(false);
  });

  test("marker text with surrounding whitespace is still excluded (both shapes trim before comparing)", () => {
    expect(isRealUserPrompt(userPrompt("  [Request interrupted by user]  "))).toBe(false);
    expect(
      isRealUserPrompt(userPromptTextArray("  [Request interrupted by user for tool use]  "))
    ).toBe(false);
  });

  test("marker text is NOT excluded when it's a substring of otherwise-real human text (either shape)", () => {
    // A human quoting or referencing the marker phrase inside a real message
    // must not be misclassified as the synthetic marker itself — only an
    // EXACT (trimmed) match is excluded.
    expect(isRealUserPrompt(userPrompt("why did [Request interrupted by user] show up?"))).toBe(
      true
    );
    expect(
      isRealUserPrompt(
        userPromptTextArray("why did [Request interrupted by user for tool use] show up?")
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractLastAssistantTurn — must NOT split on tool_result lines
// ---------------------------------------------------------------------------

describe("extractLastAssistantTurn — multi-round turn (tool_result split)", () => {
  test("spans the full logical turn across interleaved tool_result lines", () => {
    // A turn that makes a tool call: the trailing assistant segment sits AFTER
    // a tool_result, which a naive user-role split would treat as the boundary.
    const lines: TranscriptLine[] = [
      userPrompt("create the PR"),
      assistantText("calling create"),
      assistantToolUse("session_pr_create"),
      toolResult(),
      assistantText("PR created #5"),
      userPrompt("what's next?"), // current prompt — excluded
    ];

    const turn = extractLastAssistantTurn(lines);

    // The whole span between the two real prompts is returned — both assistant
    // segments AND the tool_result line, not just the trailing segment.
    expect(turn.length).toBe(4);
    const text = extractAssistantText(turn);
    expect(text).toContain("calling create");
    expect(text).toContain("PR created #5");
    expect(extractToolUseNames(turn)).toContain("session_pr_create");
  });

  test("tool_result lines do not start a new turn (real-prompt boundary)", () => {
    // Two real prompts with several tool rounds in the first turn. The naive
    // implementation would bound the turn at the LAST tool_result, dropping the
    // earlier assistant segment + tool call.
    const lines: TranscriptLine[] = [
      userPrompt("first prompt"),
      assistantText("step one"),
      assistantToolUse("Bash"),
      toolResult("a"),
      assistantText("step two"),
      assistantToolUse("Edit"),
      toolResult("b"),
      assistantText("done"),
      userPrompt("second prompt"),
    ];

    const turn = extractLastAssistantTurn(lines);
    const names = extractToolUseNames(turn);
    expect(names).toContain("Bash");
    expect(names).toContain("Edit");
    expect(extractAssistantText(turn)).toContain("step one");
  });

  test("real prompt expressed as a text-block array still bounds the turn", () => {
    const lines: TranscriptLine[] = [
      userPromptTextArray("first"),
      assistantText("work"),
      toolResult(),
      assistantText("more work"),
      userPromptTextArray("second"),
    ];
    const turn = extractLastAssistantTurn(lines);
    expect(extractAssistantText(turn)).toContain("work");
    expect(extractAssistantText(turn)).toContain("more work");
  });

  // mt#2824: a synthetic "[Request interrupted...]" marker must NOT act as a
  // turn boundary — the turn must span across it up to the NEXT real human
  // prompt, so a silent-stretch measurement over the turn sees the full
  // silence window rather than just the few milliseconds after the marker.
  test("synthetic interrupt marker does not split the turn early", () => {
    const lines: TranscriptLine[] = [
      userPrompt("first prompt"),
      assistantText("step one"),
      assistantToolUse("Bash"),
      toolResult("a"),
      interruptMarker("tool use"),
      userPrompt("why so quiet? did the harness break?"), // real interrupt, current prompt
    ];

    const turn = extractLastAssistantTurn(lines);

    // The turn spans from AFTER "first prompt" through the interrupt marker
    // (inclusive of it, since it's not a boundary) up to (exclusive of) the
    // real interrupt prompt — 4 lines: step-one text, tool_use, tool_result,
    // interrupt marker.
    expect(turn.length).toBe(4);
    expect(extractAssistantText(turn)).toContain("step one");
    expect(extractToolUseNames(turn)).toContain("Bash");
  });

  // mt#3280: the prompt that fires a UserPromptSubmit hook is usually NOT in
  // the transcript yet (Claude Code writes it asynchronously), so a single
  // real prompt followed by assistant lines is the COMMON shape, not an
  // incomplete one. This replaces the previous expectation — [] for "fewer
  // than 2 real prompts" — because that guard is what made every prompt-time
  // detector skip the turn that had just completed.
  test("one real prompt with a trailing turn resolves that turn (firing prompt not yet written)", () => {
    const lines: TranscriptLine[] = [
      userPrompt("only prompt"),
      assistantText("work"),
      toolResult(),
      assistantText("more"),
    ];
    const turn = extractLastAssistantTurn(lines);
    expect(turn.length).toBe(3);
    expect(extractAssistantText(turn)).toContain("work");
    expect(extractAssistantText(turn)).toContain("more");
  });

  const NEWEST_SEGMENT = "newest turn, second segment";

  test("resolves the just-completed turn, not the one before it", () => {
    const lines: TranscriptLine[] = [
      userPrompt("first prompt"),
      assistantText("older turn"),
      userPrompt("second prompt"),
      assistantText("newest turn"),
      toolResult(),
      assistantText(NEWEST_SEGMENT),
    ];
    const text = extractAssistantText(extractLastAssistantTurn(lines));
    expect(text).toContain("newest turn");
    expect(text).toContain(NEWEST_SEGMENT);
    expect(text).not.toContain("older turn");
  });

  test("appending the firing prompt yields the same turn — result is stable across both shapes", () => {
    const completed: TranscriptLine[] = [
      userPrompt("first prompt"),
      assistantText("older turn"),
      userPrompt("second prompt"),
      assistantText("newest turn"),
      toolResult(),
      assistantText(NEWEST_SEGMENT),
    ];
    const withFiringPrompt: TranscriptLine[] = [...completed, userPrompt("third prompt")];

    expect(extractLastAssistantTurn(withFiringPrompt)).toEqual(extractLastAssistantTurn(completed));
    expect(resolveCompletedTurn(completed).firingPromptLanded).toBe(false);
    expect(resolveCompletedTurn(withFiringPrompt).firingPromptLanded).toBe(true);
  });

  test("openingPromptIndex names the prompt that opened the resolved turn, in both shapes", () => {
    const completed: TranscriptLine[] = [
      userPrompt("first prompt"),
      assistantText("older turn"),
      userPrompt("second prompt"),
      assistantText("newest turn"),
    ];
    expect(resolveCompletedTurn(completed).openingPromptIndex).toBe(2);

    const withFiringPrompt: TranscriptLine[] = [...completed, userPrompt("third prompt")];
    expect(resolveCompletedTurn(withFiringPrompt).openingPromptIndex).toBe(2);
  });

  test("returns [] when the transcript holds no real prompt at all", () => {
    expect(extractLastAssistantTurn([assistantText("work"), toolResult()])).toEqual([]);
  });

  test("returns [] when the firing prompt landed and no earlier prompt bounds the turn", () => {
    const lines: TranscriptLine[] = [userPrompt("the only prompt")];
    expect(extractLastAssistantTurn(lines)).toEqual([]);
    expect(resolveCompletedTurn(lines).firingPromptLanded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractLastUserMessage — skips trailing tool_result lines
// ---------------------------------------------------------------------------

describe("extractLastUserMessage", () => {
  test("returns the most-recent real prompt, not a trailing tool_result", () => {
    const lines: TranscriptLine[] = [
      userPrompt("earlier"),
      assistantText("work"),
      userPrompt("the real current prompt"),
      assistantToolUse("Bash"),
      toolResult(),
    ];
    expect(extractLastUserMessage(lines)).toBe("the real current prompt");
  });

  test("returns '' when no real prompt exists", () => {
    expect(extractLastUserMessage([toolResult(), assistantText("x")])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// findRealPromptIndices — the raw index list extractLastAssistantTurn slices
// between (mt#2824: factored out so callers can read the boundary LINES'
// own fields, e.g. timestamps, not just the slice between them)
// ---------------------------------------------------------------------------

describe("findRealPromptIndices", () => {
  test("returns indices of real prompts only, skipping tool_result/assistant lines", () => {
    const lines: TranscriptLine[] = [
      userPrompt("first"), // 0
      assistantToolUse("Read"), // 1
      toolResult(), // 2
      assistantText("done"), // 3
      userPrompt("second"), // 4
    ];
    expect(findRealPromptIndices(lines)).toEqual([0, 4]);
  });

  test("returns [] when there are no real prompts", () => {
    expect(findRealPromptIndices([toolResult(), assistantText("x")])).toEqual([]);
  });

  test("extractLastAssistantTurn's boundaries match findRealPromptIndices' last two entries", () => {
    const lines: TranscriptLine[] = [
      userPrompt("first"),
      assistantToolUse("Read"),
      toolResult(),
      userPrompt("second"),
    ];
    const indices = findRealPromptIndices(lines);
    expect(indices).toEqual([0, 3]);
    const turn = extractLastAssistantTurn(lines);
    expect(turn).toEqual(lines.slice((indices[0] as number) + 1, indices[1] as number));
  });
});

// ---------------------------------------------------------------------------
// Skill-body exclusion (mt#2357) — a skill launch must not split the turn
// ---------------------------------------------------------------------------

describe("isRealUserPrompt — skill-body exclusion (mt#2357)", () => {
  test("skill-body line with isMeta: true is not a real prompt", () => {
    expect(isRealUserPrompt(skillBody(true))).toBe(false);
  });

  test("skill-body line WITHOUT isMeta is still excluded via the text prefix", () => {
    expect(isRealUserPrompt(skillBody(false))).toBe(false);
  });

  test("skill-body text as bare STRING content is excluded (both content shapes)", () => {
    expect(
      isRealUserPrompt(userPrompt("Base directory for this skill: /x/.claude/skills/foo\n\n# Foo"))
    ).toBe(false);
  });

  // mt#4289: the auto-compaction summary is harness-written too, but carries
  // `isCompactSummary` and NO `isMeta` — so the exclusion above never reached
  // it, and its `message.content` is a plain STRING, which took the branch that
  // excludes only interrupt-marker and skill-body text. Every detector reading
  // `isRealUserPrompt` therefore saw a compaction boundary as an operator
  // prompt: a turn boundary the operator never created.
  test("a compact-summary line is NOT a real prompt (mt#4289)", () => {
    const compactSummary: TranscriptLine = {
      type: "user",
      isCompactSummary: true,
      message: {
        role: "user",
        content: "This session is being continued from a previous conversation…",
      },
    };
    expect(isRealUserPrompt(compactSummary)).toBe(false);
  });

  test("a compact summary carries no isMeta — the mt#2357 exclusion cannot cover it", () => {
    // Pins the reason the check above has to exist separately. If a future
    // harness version starts stamping isMeta on the boundary record, this test
    // fails and tells the next reader the two checks have merged.
    const compactSummary: TranscriptLine = {
      type: "user",
      isCompactSummary: true,
      message: { role: "user", content: "This session is being continued…" },
    };
    expect(compactSummary.isMeta).toBeUndefined();
  });

  test("any isMeta: true user line (e.g. a skill re-invocation notice) is excluded", () => {
    const reinvocation: TranscriptLine = {
      type: "user",
      isMeta: true,
      message: {
        role: "user",
        content: [{ type: "text", text: "(Re-invocation of /implement-task — ...)" }],
      },
    };
    expect(isRealUserPrompt(reinvocation)).toBe(false);
  });

  test("ordinary prompts remain real; a prompt merely MENTIONING the prefix mid-text stays real", () => {
    expect(isRealUserPrompt(userPrompt("do the thing"))).toBe(true);
    expect(isRealUserPrompt(userPromptTextArray("queued follow-up message"))).toBe(true);
    expect(
      isRealUserPrompt(userPrompt('why does the transcript say "Base directory for this skill:"?'))
    ).toBe(true);
  });

  test("extractLastAssistantTurn does NOT split at a skill launch", () => {
    const lines: TranscriptLine[] = [
      userPrompt("run the skill"),
      assistantText("Launching the skill now."),
      assistantToolUse("Skill"),
      skillBody(true),
      assistantText("Done with the skill's work."),
      userPrompt("thanks"),
    ];
    expect(findRealPromptIndices(lines)).toEqual([0, 5]);
    const turn = extractLastAssistantTurn(lines);
    expect(turn).toHaveLength(4);
    const text = extractAssistantText(turn);
    expect(text).toContain("Launching the skill now.");
    expect(text).toContain("Done with the skill's work.");
  });
});

// ---------------------------------------------------------------------------
// extractFinalTurn (mt#2357) — the Stop-time turn shape
// ---------------------------------------------------------------------------

describe("extractFinalTurn", () => {
  test("returns the tail after the last real prompt, plus the opening prompt line", () => {
    const opening: TranscriptLine = { ...userPrompt("deploy it"), uuid: "u-1" };
    const lines: TranscriptLine[] = [
      userPrompt("earlier"),
      assistantText("earlier turn"),
      opening,
      assistantToolUse("Bash"),
      toolResult(),
      assistantText("I made a mistake in the deploy step."),
    ];
    const { turnLines, openingPrompt } = extractFinalTurn(lines);
    expect(turnLines).toHaveLength(3);
    expect(extractAssistantText(turnLines)).toContain("I made a mistake");
    expect(openingPrompt?.uuid).toBe("u-1");
  });

  test("spans a mid-turn skill launch without splitting", () => {
    const lines: TranscriptLine[] = [
      userPrompt("go"),
      assistantToolUse("Skill"),
      skillBody(true),
      assistantText("post-skill admission text"),
    ];
    const { turnLines } = extractFinalTurn(lines);
    expect(turnLines).toHaveLength(3);
    expect(extractAssistantText(turnLines)).toContain("post-skill admission text");
  });

  test("no real prompt at all -> empty turn, undefined opening prompt", () => {
    const { turnLines, openingPrompt } = extractFinalTurn([toolResult(), assistantText("x")]);
    expect(turnLines).toEqual([]);
    expect(openingPrompt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveParentTranscriptLines (mt#3003) — shared anchoring fix
// ---------------------------------------------------------------------------
//
// Generalizes wall-of-text-detector.ts's mt#3028 `resolveTurnLines` fix
// (originally per-detector) into a shared primitive silent-stretch-detector
// also consumes, closing the cross-transcript-contamination gap that
// produced the "stale turn re-measurement" bug investigated at mt#3003
// planning: a guard's `ctx.transcriptLines` (registry.ts D6) is
// `transcriptCandidates.flatMap(parseTranscript)` — parent transcript
// concatenated with every sibling subagent transcript (mt#2637) — and
// turn-boundary extraction over that flattened array can permanently anchor
// inside a STATIC subagent segment (subagent files are always ordered AFTER
// the growing parent, per `resolveTranscriptCandidates`), freezing the
// measured turn regardless of how much the live parent conversation grows.

describe("resolveParentTranscriptLines", () => {
  const PARENT_PATH = "/tmp/parent.jsonl";
  const SUBAGENT_PATH = "/tmp/subagents/agent-fake.jsonl";

  test("<=1 candidate -> trusts flatLines as-is (no re-parse)", () => {
    const flatLines = [userPrompt("hi"), assistantText("hello")];
    const poisoned = (): TranscriptLine[] => {
      throw new Error("parseTranscriptFn must not be called for a single candidate");
    };
    expect(resolveParentTranscriptLines(PARENT_PATH, [PARENT_PATH], flatLines, poisoned)).toBe(
      flatLines
    );
  });

  test("undefined candidates -> trusts flatLines as-is", () => {
    const flatLines = [userPrompt("hi"), assistantText("hello")];
    const poisoned = (): TranscriptLine[] => {
      throw new Error("parseTranscriptFn must not be called with no candidates array");
    };
    expect(resolveParentTranscriptLines(PARENT_PATH, undefined, flatLines, poisoned)).toBe(
      flatLines
    );
  });

  test(">1 candidates -> re-parses the PARENT candidate alone, ignoring the flattened array", () => {
    // Simulates the confirmed contamination shape: the flattened array is
    // parent lines followed by a STATIC subagent segment whose own real
    // prompts would otherwise anchor extractLastAssistantTurn forever.
    const parentLines = [userPrompt("investigate this"), assistantText("done investigating")];
    const subagentLines = [userPrompt("subagent task"), assistantText("subagent report")];
    const contaminated = [...parentLines, ...subagentLines];
    const parseTranscriptFn = (path: string): TranscriptLine[] => {
      expect(path).toBe(PARENT_PATH); // always candidates[0]
      return parentLines;
    };
    expect(
      resolveParentTranscriptLines(
        PARENT_PATH,
        [PARENT_PATH, SUBAGENT_PATH],
        contaminated,
        parseTranscriptFn
      )
    ).toBe(parentLines);
  });

  test(">1 candidates but candidates[0] missing -> falls back to transcriptPath", () => {
    const parentLines = [userPrompt("go"), assistantText("ok")];
    const parseTranscriptFn = (path: string): TranscriptLine[] => {
      expect(path).toBe(PARENT_PATH);
      return parentLines;
    };
    // A synthetic/test candidates array that (unlike the real
    // resolveTranscriptCandidates) doesn't actually carry the parent path
    // as its first entry — the fallback must still find it via transcriptPath.
    expect(
      resolveParentTranscriptLines(
        PARENT_PATH,
        [undefined as unknown as string, SUBAGENT_PATH],
        [],
        parseTranscriptFn
      )
    ).toBe(parentLines);
  });

  // PR #2175 R1 BLOCKING #1 — the real bug: resolveTranscriptCandidates
  // places the per-agent file FIRST (candidates[0]) when the GIVEN
  // transcriptPath is itself a per-agent file (its own "tree semantics in
  // the other direction" branch, mt#2637), pushing the true parent LATER.
  // A naive `candidates[0]` assumption would scope this function to the
  // SUBAGENT's own transcript instead of the parent.
  test(">1 candidates, transcriptPath IS a per-agent file (candidates[0] is the AGENT, not the parent) -> still resolves the PARENT", () => {
    const parentLines = [userPrompt("the real conversation"), assistantText("parent report")];
    const subagentLines = [userPrompt("subagent task"), assistantText("subagent report")];
    // Mirrors resolveTranscriptCandidates's actual output shape for this
    // input: [givenAgentPath, parentPath, ...other siblings].
    const candidates = [SUBAGENT_PATH, PARENT_PATH];
    const parseTranscriptFn = (path: string): TranscriptLine[] => {
      expect(path).toBe(PARENT_PATH); // must resolve to the PARENT, not candidates[0]
      return parentLines;
    };
    expect(
      resolveParentTranscriptLines(
        SUBAGENT_PATH, // the GIVEN transcriptPath is itself the agent file
        candidates,
        [...subagentLines, ...parentLines], // flattened array shape is irrelevant here — never used
        parseTranscriptFn
      )
    ).toBe(parentLines);
  });

  test("every candidate looks agent-shaped -> defensive fallback to candidates[0] (never actually produced by resolveTranscriptCandidates)", () => {
    const fallbackLines = [userPrompt("fallback")];
    const otherAgentPath = "/tmp/subagents/agent-other.jsonl";
    const parseTranscriptFn = (path: string): TranscriptLine[] => {
      expect(path).toBe(SUBAGENT_PATH);
      return fallbackLines;
    };
    expect(
      resolveParentTranscriptLines(
        undefined,
        [SUBAGENT_PATH, otherAgentPath],
        [],
        parseTranscriptFn
      )
    ).toBe(fallbackLines);
  });
});

// ---------------------------------------------------------------------------
// resolveParentTranscriptLinesForPath (PR #2175 R1 BLOCKING #2) — the CLI
// (standalone, non-dispatcher) convenience wrapper. Verifies a standalone
// hook invocation gets the SAME cross-transcript-contamination guarantee as
// the dispatcher `run()` path, by reconstructing the candidate set itself
// (no DispatchContext is available in CLI mode).
// ---------------------------------------------------------------------------

describe("resolveParentTranscriptLinesForPath", () => {
  const LONE_SESSION_PATH = "/tmp/lone-session.jsonl";

  test("no subagents dir -> parses transcriptPath alone (single-candidate case)", () => {
    const parentLines = [userPrompt("solo"), assistantText("ok")];
    const parseTranscriptFn = (path: string): TranscriptLine[] => {
      expect(path).toBe(LONE_SESSION_PATH);
      return parentLines;
    };
    expect(
      resolveParentTranscriptLinesForPath(LONE_SESSION_PATH, undefined, parseTranscriptFn)
    ).toEqual(parentLines);
  });

  test("CLI contamination: an agentId candidate is reconstructed but the wrapper still scopes to the parent alone, without wastefully parsing the discarded candidate", () => {
    // resolveTranscriptCandidates itself walks a real subagents/ directory
    // via readdirSync, which this pure-function test can't fake without
    // real fs — so this exercises the composition contract instead. Passing
    // an agentId unconditionally adds a second (subagent-shaped) candidate
    // (resolveTranscriptCandidates pushes it regardless of whether that
    // file actually exists on disk), so this is genuinely a >1-candidate
    // case — the parent-only scoping path. A `parseTranscriptFn` that
    // throws if called with anything other than the parent path proves BOTH
    // that no subagent content leaks in AND that the wrapper doesn't
    // wastefully parse the discarded candidate first (the fix for the
    // eager-flatMap bug this test caught).
    const parentLines = [userPrompt("main thread"), assistantText("main report")];
    const parseTranscriptFn = (path: string): TranscriptLine[] => {
      expect(path).toBe(LONE_SESSION_PATH);
      return parentLines;
    };
    expect(
      resolveParentTranscriptLinesForPath(LONE_SESSION_PATH, "some-agent-id", parseTranscriptFn)
    ).toEqual(parentLines);
  });
});

// ---------------------------------------------------------------------------
// readLogTailText / sessionHasLoggedKey (mt#3003) — shared dedup helpers
// ---------------------------------------------------------------------------

describe("sessionHasLoggedKey", () => {
  test("undefined log text -> false", () => {
    expect(sessionHasLoggedKey(undefined, "session-a", "turnAnchor", "x::y")).toBe(false);
  });

  test("undefined session id -> false", () => {
    const log = `${JSON.stringify({ session_id: "session-a", turnAnchor: "x::y" })}\n`;
    expect(sessionHasLoggedKey(log, undefined, "turnAnchor", "x::y")).toBe(false);
  });

  test("matches the key regardless of position in the log, scoped to the session", () => {
    const lines = [
      { session_id: "session-a", turnAnchor: "anchor-1" },
      { session_id: "session-b", turnAnchor: "other-session-anchor" },
      { session_id: "session-a", turnAnchor: "anchor-2" },
    ];
    const log = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
    // Not just the most-recent record for the session (mirrors the
    // wall-of-text A -> B -> A regression this generalizes from).
    expect(sessionHasLoggedKey(log, "session-a", "turnAnchor", "anchor-1")).toBe(true);
    expect(sessionHasLoggedKey(log, "session-a", "turnAnchor", "anchor-2")).toBe(true);
    expect(sessionHasLoggedKey(log, "session-a", "turnAnchor", "anchor-3")).toBe(false);
    expect(sessionHasLoggedKey(log, "session-b", "turnAnchor", "anchor-1")).toBe(false);
  });

  test("tolerates blank lines and malformed JSON lines", () => {
    const log = [
      "",
      "not valid json",
      JSON.stringify({ session_id: "session-a", turnAnchor: "ok" }),
      "",
    ].join("\n");
    expect(sessionHasLoggedKey(log, "session-a", "turnAnchor", "ok")).toBe(true);
  });

  test("a different key field on the same record shape is independent (generic keyField)", () => {
    const log = `${JSON.stringify({ session_id: "session-a", textHash: "h1", turnAnchor: "a1" })}\n`;
    expect(sessionHasLoggedKey(log, "session-a", "textHash", "h1")).toBe(true);
    expect(sessionHasLoggedKey(log, "session-a", "turnAnchor", "a1")).toBe(true);
    expect(sessionHasLoggedKey(log, "session-a", "textHash", "a1")).toBe(false);
  });
});

/* eslint-disable custom/no-real-fs-in-tests -- this block specifically
   verifies readLogTailText's bounded-tail-read behavior against a real
   file (the whole point is proving the byte-offset seek actually bounds
   disk I/O regardless of file size); every OTHER test in this file uses
   in-memory fixtures. A throwaway mkdtempSync directory (removed in
   afterEach) keeps this isolated from any real calibration log. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("readLogTailText", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "transcript-dedupe-test-"));
    logPath = join(tmpDir, "calibration.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("missing file -> undefined", () => {
    expect(readLogTailText(logPath)).toBeUndefined();
  });

  test("file at or under the byte cap is returned in full", () => {
    const content = `${JSON.stringify({ session_id: "s", turnAnchor: "a" })}\n`;
    writeFileSync(logPath, content);
    expect(readLogTailText(logPath)).toBe(content);
  });

  test("file over the byte cap returns only a bounded tail, excluding early content", () => {
    const maxBytes = 4096;
    const startRecord = `${JSON.stringify({ session_id: "session-at-start", turnAnchor: "start" })}\n`;
    const filler = `${JSON.stringify({ session_id: "filler", turnAnchor: "f" })}\n`;
    const fillerCount = Math.ceil((maxBytes * 3) / filler.length);
    const endRecord = `${JSON.stringify({ session_id: "session-at-end", turnAnchor: "end" })}\n`;
    writeFileSync(logPath, startRecord + filler.repeat(fillerCount) + endRecord);

    const result = readLogTailText(logPath, maxBytes);
    expect(result).toBeDefined();
    expect((result as string).length).toBeLessThanOrEqual(maxBytes);
    expect(sessionHasLoggedKey(result, "session-at-end", "turnAnchor", "end")).toBe(true);
    expect(sessionHasLoggedKey(result, "session-at-start", "turnAnchor", "start")).toBe(false);
  });

  test("default maxBytes is DEFAULT_MAX_DEDUPE_READ_BYTES", () => {
    const content = `${JSON.stringify({ session_id: "s", turnAnchor: "a" })}\n`;
    writeFileSync(logPath, content);
    // The explicit-arg call types as `string | undefined` while the default-arg
    // call types as `string`, so the comparison needs the expected value proven
    // present first (mt#2900) — which is also a stronger assertion.
    const explicit = readLogTailText(logPath, DEFAULT_MAX_DEDUPE_READ_BYTES);
    expect(explicit).toBeDefined();
    expect(readLogTailText(logPath)).toBe(explicit as string);
  });
});
/* eslint-enable custom/no-real-fs-in-tests */

describe("collectShortIdBindings (mt#4160)", () => {
  const resultLine = (text: string) => ({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "toolu_x", content: [{ type: "text", text }] }],
    },
  });

  // Named rather than repeated inline: each of these appears in both a fixture
  // and its assertion, and a UUID that drifts between the two would make a test
  // pass for the wrong reason (custom/no-magic-string-duplication).
  const UUID_REFS_STATUS = "227d170f-0579-4603-aca0-433b5a4cb657";
  const UUID_OWN_ID = "44444444-4444-4444-4444-444444444444";
  const UUID_SUPERSEDED_BY = "55555555-5555-5555-5555-555555555555";
  const UUID_RECORD = "66666666-6666-6666-6666-666666666666";
  /** mem#1256's real UUID — the window-3 fire this task's diagnosis names. */
  const UUID_MEM_1256 = "11336b71-4741-4ad8-ba5a-eee482f8dfff";
  /** The scoping UUID whose presence beside `id` is the whole defect. */
  const UUID_PROJECT_SCOPE = "3ac3d147-2b6f-4cf9-a52a-2b6e32d3c5fe";

  test("reads the memory_create shape: id is the UUID, shortId is the ref", () => {
    // Verbatim field order and names from a real mcp__minsky__memory_create
    // result (session 6b2b7665, 2026-08-16).
    const bindings = collectShortIdBindings([
      resultLine(
        JSON.stringify({
          id: "c748bf8f-5ac5-4026-a5a7-91f7b55f2031",
          shortId: "mem#1045",
          type: "project",
          name: "handoff_cockpit-sqlstate-classifier_gate-battery-premise_2026-08-13",
        })
      ),
    ] as never);
    expect(bindings.get("mem#1045")).toBe("c748bf8f-5ac5-4026-a5a7-91f7b55f2031");
  });

  test("reads the refs_status shape, where the two field names are INVERTED", () => {
    // Same pair, opposite names: here `id` holds the short id and `uuid` the
    // UUID. This is why the pairing keys on value shape rather than field name.
    const bindings = collectShortIdBindings([
      resultLine(
        JSON.stringify({
          success: true,
          results: [
            {
              ref: "mem#996",
              kind: "memory",
              id: "mem#996",
              uuid: UUID_REFS_STATUS,
            },
          ],
        })
      ),
    ] as never);
    expect(bindings.get("mem#996")).toBe(UUID_REFS_STATUS);
  });

  test("a short id bound to two different UUIDs is DROPPED, not guessed", () => {
    const bindings = collectShortIdBindings([
      resultLine(JSON.stringify({ id: "11111111-1111-1111-1111-111111111111", shortId: "mem#7" })),
      resultLine(JSON.stringify({ id: "22222222-2222-2222-2222-222222222222", shortId: "mem#7" })),
    ] as never);
    expect(bindings.has("mem#7")).toBe(false);
  });

  test("a result carrying no short id contributes nothing", () => {
    const bindings = collectShortIdBindings([
      resultLine(
        JSON.stringify({ id: "33333333-3333-3333-3333-333333333333", name: "no short id" })
      ),
    ] as never);
    expect(bindings.size).toBe(0);
  });

  test("non-JSON tool-result text is skipped rather than throwing", () => {
    const bindings = collectShortIdBindings([
      resultLine("Task mt#4160 created successfully"),
    ] as never);
    expect(bindings.size).toBe(0);
  });

  // PR #3018 R1's invariant is KEY-ORDER INDEPENDENCE, and it still holds.
  // mt#4463 changed the OUTCOME for this particular shape — `id` + `shortId`
  // now pair by field name, which is the record's own id and is correct — so
  // this test asserts the pairing is the same under either key order, rather
  // than asserting a refusal that was only ever the conservative answer to
  // "which UUID is this record's own" when nothing named it.
  test("an `id` + `shortId` pair binds identically in either key order (mt#4463)", () => {
    const idFirst = collectShortIdBindings([
      resultLine(
        JSON.stringify({
          id: UUID_OWN_ID,
          shortId: "mem#42",
          supersededBy: UUID_SUPERSEDED_BY,
        })
      ),
    ] as never);

    const supersededFirst = collectShortIdBindings([
      resultLine(
        JSON.stringify({
          supersededBy: UUID_SUPERSEDED_BY,
          id: UUID_OWN_ID,
          shortId: "mem#42",
        })
      ),
    ] as never);

    // The record's OWN id, never the `supersededBy` — under a first-wins value
    // rule these two calls would disagree; naming the field means they cannot.
    expect(idFirst.get("mem#42")).toBe(UUID_OWN_ID);
    expect(supersededFirst.get("mem#42")).toBe(UUID_OWN_ID);
    expect([...supersededFirst.keys()]).toEqual([...idFirst.keys()]);
  });

  // PR #3018 R1's refusal, preserved on the shape it is actually about: two
  // UUIDs and NO `id`+`shortId` field pair to disambiguate them. The field-name
  // path cannot apply here (`id` is absent), so the value rule decides, and it
  // must still refuse rather than guess — in either key order.
  test("two uuids with no id+shortId pair still yields NO binding, either order", () => {
    const ownerFirst = collectShortIdBindings([
      resultLine(
        JSON.stringify({
          ownerUuid: UUID_RECORD,
          ref: "mem#77",
          targetUuid: "77777777-7777-7777-7777-777777777777",
        })
      ),
    ] as never);
    expect(ownerFirst.has("mem#77")).toBe(false);

    const targetFirst = collectShortIdBindings([
      resultLine(
        JSON.stringify({
          targetUuid: "77777777-7777-7777-7777-777777777777",
          ref: "mem#77",
          ownerUuid: UUID_RECORD,
        })
      ),
    ] as never);
    expect(targetFirst.has("mem#77")).toBe(false);
    expect([...targetFirst.keys()]).toEqual([...ownerFirst.keys()]);
  });

  // mt#4463: the defect this task exists for. A canonical entity record carries
  // `projectId` beside `id`, so the value-uniqueness rule saw two UUIDs and
  // bound nothing — measured at 0 of 114 such records across 654 transcripts,
  // and universal since 2026-08-25. Field order and names are verbatim from a
  // real mcp__minsky__memory_create result.
  test("a record with a populated projectId still binds its own id (mt#4463)", () => {
    const bindings = collectShortIdBindings([
      resultLine(
        JSON.stringify({
          id: UUID_MEM_1256,
          shortId: "mem#1256",
          type: "project",
          name: "handoff_pool_connection_leak_cluster",
          scope: "project",
          projectId: UUID_PROJECT_SCOPE,
          supersededBy: null,
        })
      ),
    ] as never);
    expect(bindings.get("mem#1256")).toBe(UUID_MEM_1256);
  });

  // The projectId must never be mistaken FOR the entity's id — that would bind
  // every project-scoped record to the same UUID, which is worse than not
  // binding at all.
  test("the projectId is never bound as the entity's own uuid (mt#4463)", () => {
    const bindings = collectShortIdBindings([
      resultLine(
        JSON.stringify({
          id: UUID_MEM_1256,
          shortId: "mem#1256",
          projectId: UUID_PROJECT_SCOPE,
        })
      ),
    ] as never);
    expect(bindings.get("mem#1256")).not.toBe(UUID_PROJECT_SCOPE);
  });

  // The field-name path must not fire when `id` holds something that is not a
  // UUID — `refs_status` puts the SHORT id there, and that shape has to keep
  // resolving through the value rule to its `uuid` field.
  test("field-name pairing does not hijack the inverted refs_status shape (mt#4463)", () => {
    const bindings = collectShortIdBindings([
      resultLine(
        JSON.stringify({
          ref: "mem#996",
          kind: "memory",
          id: "mem#996",
          uuid: UUID_REFS_STATUS,
        })
      ),
    ] as never);
    expect(bindings.get("mem#996")).toBe(UUID_REFS_STATUS);
  });

  // PR #3378 R1 — cross-type consistency. A UUID carries no type, so this is
  // checkable only where the object declares its own kind. These three pin all
  // three branches of that.
  test("a declared `kind` that disagrees with the short id blocks the binding", () => {
    const bindings = collectShortIdBindings([
      resultLine(JSON.stringify({ id: UUID_RECORD, shortId: "ask#123", kind: "memory" })),
    ] as never);
    expect(bindings.has("ask#123")).toBe(false);
  });

  test("a declared `kind` that AGREES still binds — the guard does not over-fire", () => {
    const bindings = collectShortIdBindings([
      resultLine(JSON.stringify({ id: UUID_RECORD, shortId: "ask#123", kind: "ask" })),
    ] as never);
    expect(bindings.get("ask#123")).toBe(UUID_RECORD);
  });

  test("an unrecognised `kind` is 'no declaration', not a mismatch", () => {
    // A memory record's `type: "project"` is not an entity kind, and a shape
    // that uses the word `kind` for something else must not be refused.
    const bindings = collectShortIdBindings([
      resultLine(JSON.stringify({ id: UUID_MEM_1256, shortId: "mem#1256", kind: "retrospective" })),
    ] as never);
    expect(bindings.get("mem#1256")).toBe(UUID_MEM_1256);
  });

  // The residual the guard CANNOT reach, pinned so it is a known property
  // rather than a surprise: with no `kind` declared, nothing in the values can
  // detect that `id` belongs to a different entity than `shortId` names. The
  // binding is made, and the CONSUMER's own type gate is what makes it
  // harmless — see bare-entity-ref-scan.test.ts, "AT2 — a link to a DIFFERENT
  // entity does not suppress (identity, not adjacency)".
  test("with no declared kind, a mismatched pair still binds — consumer gates it", () => {
    const bindings = collectShortIdBindings([
      resultLine(JSON.stringify({ id: UUID_RECORD, shortId: "ask#123" })),
    ] as never);
    expect(bindings.get("ask#123")).toBe(UUID_RECORD);
  });

  // mt#4463 changed this outcome too, and for the same reason as the
  // `supersededBy` case above: `shortId` names the record's OWN short id, so a
  // second short id in a REFERENCE field no longer makes the pairing ambiguous.
  // The load-bearing assertion is the second one — the referenced entity must
  // not pick up a binding it has no evidence for.
  test("a record binds its own shortId and never a referenced one (mt#4463)", () => {
    const bindings = collectShortIdBindings([
      resultLine(
        JSON.stringify({
          id: UUID_RECORD,
          shortId: "mem#43",
          relatedShortId: "mem#44",
        })
      ),
    ] as never);
    expect(bindings.get("mem#43")).toBe(UUID_RECORD);
    expect(bindings.has("mem#44")).toBe(false);
  });

  // The refusal this replaces, kept on the shape it is actually about: two
  // short ids and NO `shortId` field to say which is the record's own.
  test("two short ids with no `shortId` field still yields no binding", () => {
    const bindings = collectShortIdBindings([
      resultLine(
        JSON.stringify({
          uuid: UUID_RECORD,
          fromRef: "mem#43",
          toRef: "mem#44",
        })
      ),
    ] as never);
    expect(bindings.size).toBe(0);
  });

  test("a value REPEATED across fields is still one entity — refs_status binds", () => {
    // `refs_status` emits the same short id as both `ref` and `id`. A raw count
    // would read that as two short ids and refuse a legitimate binding, so the
    // rule counts DISTINCT values.
    const bindings = collectShortIdBindings([
      resultLine(
        JSON.stringify({
          ref: "mem#1041",
          kind: "memory",
          id: "mem#1041",
          found: true,
          uuid: "536e44cb-7234-4f7a-a7f2-bef92ef1371d",
        })
      ),
    ] as never);
    expect(bindings.get("mem#1041")).toBe("536e44cb-7234-4f7a-a7f2-bef92ef1371d");
  });
});
