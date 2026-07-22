import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  isRealUserPrompt,
  extractLastAssistantTurn,
  extractAssistantText,
  extractToolUseNames,
  extractLastUserMessage,
  findRealPromptIndices,
  extractFinalTurn,
  resolveParentTranscriptLines,
  readLogTailText,
  sessionHasLoggedKey,
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

  test("returns [] with fewer than 2 real prompts (tool_results do not count)", () => {
    const lines: TranscriptLine[] = [
      userPrompt("only prompt"),
      assistantText("work"),
      toolResult(),
      assistantText("more"),
    ];
    expect(extractLastAssistantTurn(lines)).toEqual([]);
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
    expect(readLogTailText(logPath)).toBe(readLogTailText(logPath, DEFAULT_MAX_DEDUPE_READ_BYTES));
  });
});
/* eslint-enable custom/no-real-fs-in-tests */
