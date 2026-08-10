#!/usr/bin/env bun
/**
 * Unit tests for knowledge-acquisition-detector.ts
 *
 * Covers the mt#2708 acceptance tests:
 * - fires on research-without-propagation (rung 1 + rung-2-lite keyword overlap)
 * - suppressed when memory_create / `/learn` / tasks_create occurred in the trailing window
 * - suppressed when the research has no keyword overlap with any loaded skill
 * - not-yet-due grace period respected (fewer than TRAILING_WINDOW_TURNS elapsed)
 * - dedupe: an already-logged occurrence never re-fires
 * - silent on first turn and on transcript errors
 * - MANDATORY tool-interleaved transcript fixture (tool_result lines carry role "user" —
 *   memory a3e60471): trigger research tool_use -> tool_result (user-role) -> assistant
 *   text -> real user prompt
 * - the originating incident replayed (2026-06-24 essay session shape: WebSearch on
 *   AI-writing tells with `engineering-writing` loaded, no propagation) produces a match
 *
 * The tool-interleaved + originating-incident tests exercise the REAL `run()` entry point
 * against the REAL `engineering-writing` SKILL.md on disk (via `input.cwd = import.meta.dir`,
 * which `findRepoRoot` resolves to this repo's root) rather than injecting a fake keyword
 * map — the acceptance test's whole point is proving the keyword-overlap gate works against
 * a real skill's real frontmatter, not just a synthetic stand-in. All other scenarios use
 * the pure `detectKnowledgeAcquisition` function with an injected keyword map, per
 * `custom/no-real-fs-in-tests`.
 *
 * @see mt#2708
 */

import { describe, test, expect } from "bun:test";
import {
  buildMatchExcerpt,
  detectKnowledgeAcquisition,
  extractFrontmatterDescription,
  extractSkillKeywords,
  findAllKeywordOverlaps,
  isNameDerivedKeyword,
  isNominationBudgetExhausted,
  isRung2NominationEnabled,
  NOMINATION_SESSION_BUDGET_MS,
  RUNG2_NOMINATION_ENV_VAR,
  INJECTION_ENABLED,
  OVERRIDE_ENV_VAR,
  TRAILING_WINDOW_TURNS,
  RESEARCH_TOOL_NAMES,
  SESSION_VERDICT_DEDUPE_KEY,
  SUPPRESSION_PROPAGATION_IN_WINDOW,
  run,
} from "./knowledge-acquisition-detector";
import type { TranscriptLine } from "./transcript";

/** Shared fixture text — three describe blocks build the same research turn. */
const RESEARCH_PROMPT = "go ahead and research it";
const RESEARCH_QUERY = "argumentative prose AI writing tells overused phrases";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function userPromptLine(text: string): TranscriptLine {
  return { type: "user", message: { role: "user", content: text } };
}

function assistantLine(content: Array<Record<string, unknown>>): TranscriptLine {
  return { type: "assistant", message: { role: "assistant", content } };
}

function toolUseBlock(name: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "tool_use", name, input };
}

function textBlock(text: string): Record<string, unknown> {
  return { type: "text", text };
}

/** A tool_result line — Claude Code records these with `role: "user"` (memory a3e60471). */
function toolResultLine(toolUseId: string, resultText: string): TranscriptLine {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: [{ type: "text", text: resultText }],
        },
      ],
    },
  };
}

function skillLoadLine(skillName: string): TranscriptLine {
  return assistantLine([
    toolUseBlock("Skill", { skill: skillName }),
    textBlock(`Loading ${skillName}.`),
  ]);
}

function fillerTurn(promptText: string, assistantText: string): TranscriptLine[] {
  return [userPromptLine(promptText), assistantLine([textBlock(assistantText)])];
}

const HOOK_EVENT_NAME = "UserPromptSubmit" as const;

function makeCtx(transcriptLines: TranscriptLine[]): DispatchContext {
  return {
    event: HOOK_EVENT_NAME,
    hostCapSec: 15,
    budgets: { overallBudgetMs: 9000, fetchTimeoutMs: 4950, gitTimeoutMs: 1530 },
    transcriptCandidates: ["/mock/transcript.jsonl"],
    transcriptLines,
  };
}

const FAKE_HOOK_INPUT: ClaudeHookInput = {
  session_id: "mt2708-test-session",
  transcript_path: "/mock/transcript.jsonl",
  cwd: "/nonexistent/fake/repo",
  hook_event_name: HOOK_EVENT_NAME,
};

/** The real, on-disk skill this file's originating-incident replay tests exercise. */
const ENGINEERING_WRITING_SKILL = "engineering-writing";

/** The opening prompt every fixture session starts from. */
const OPENING_PROMPT = "please write an essay about AI writing tells";

/** The canonical propagation call — the destination a captured acquisition lands in. */
const MEMORY_CREATE_TOOL = "mcp__minsky__memory_create";

// ---------------------------------------------------------------------------
// extractFrontmatterDescription
// ---------------------------------------------------------------------------

describe("extractFrontmatterDescription", () => {
  test("extracts a block-scalar (>-) description", async () => {
    const content = [
      "---",
      "# Generated by minsky compile. Do not edit directly.",
      "name: engineering-writing",
      "description: >-",
      "  Writing engineering essays, position papers, technical blog posts, and",
      "  architecture memos intended for external readers.",
      "user-invocable: true",
      "---",
      "",
      "# Engineering Writing",
    ].join("\n");
    const result = extractFrontmatterDescription(content);
    expect(result).toContain("engineering essays");
    expect(result).toContain("architecture memos");
  });

  test("extracts an inline scalar description", async () => {
    const content = [
      "---",
      "name: foo-skill",
      "description: A short inline description.",
      "---",
      "body",
    ].join("\n");
    expect(extractFrontmatterDescription(content)).toBe("A short inline description.");
  });

  test("returns empty string when there is no description key", async () => {
    const content = ["---", "name: foo-skill", "user-invocable: true", "---", "body"].join("\n");
    expect(extractFrontmatterDescription(content)).toBe("");
  });

  test("returns empty string when frontmatter is unterminated", async () => {
    const content = ["---", "name: foo-skill", "description: never closed"].join("\n");
    expect(extractFrontmatterDescription(content)).toBe("");
  });

  test("returns empty string for content with no leading ---", async () => {
    expect(extractFrontmatterDescription("# just a heading\nno frontmatter here")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// extractSkillKeywords
// ---------------------------------------------------------------------------

describe("extractSkillKeywords", () => {
  test("derives keywords from the hyphenated skill name", async () => {
    const keywords = extractSkillKeywords(ENGINEERING_WRITING_SKILL, "");
    expect(keywords).toContain("engineering");
    expect(keywords).toContain("writing");
  });

  test("derives distinctive keywords from the description, excluding stopwords", async () => {
    const keywords = extractSkillKeywords(
      ENGINEERING_WRITING_SKILL,
      "long-form argumentative prose intended for external readers"
    );
    expect(keywords).toContain("argumentative");
    expect(keywords).toContain("prose");
    // "intended" is a stopword, deliberately excluded.
    expect(keywords).not.toContain("intended");
  });

  test("excludes short words (< 5 chars) from the description", async () => {
    const keywords = extractSkillKeywords("foo-bar", "use when doing a task");
    expect(keywords).not.toContain("task");
  });
});

// ---------------------------------------------------------------------------
// detectKnowledgeAcquisition (pure core — injected keyword map, no real fs)
// ---------------------------------------------------------------------------

describe("detectKnowledgeAcquisition", () => {
  const SKILL = ENGINEERING_WRITING_SKILL;
  const KEYWORDS = new Map<string, string[]>([[SKILL, ["argumentative", "prose"]]]);

  /** Builds: skill loaded (turn 0), research call (turn 1), N filler turns, current prompt. */
  function buildLines(opts: {
    researchToolName?: string;
    researchQuery?: string;
    fillerTurns: number;
    propagationToolName?: string;
    propagationInFillerIndex?: number; // 0-based filler-turn index to inject propagation into
    learnSkillInFillerIndex?: number;
  }): TranscriptLine[] {
    const lines: TranscriptLine[] = [
      userPromptLine(OPENING_PROMPT),
      skillLoadLine(SKILL),
      userPromptLine(RESEARCH_PROMPT),
      assistantLine([
        toolUseBlock(opts.researchToolName ?? "WebSearch", {
          query: opts.researchQuery ?? RESEARCH_QUERY,
        }),
      ]),
    ];
    for (let i = 0; i < opts.fillerTurns; i++) {
      const assistantContent: Array<Record<string, unknown>> = [textBlock(`filler turn ${i}`)];
      if (opts.propagationToolName && opts.propagationInFillerIndex === i) {
        assistantContent.unshift(toolUseBlock(opts.propagationToolName, {}));
      }
      if (opts.learnSkillInFillerIndex === i) {
        assistantContent.unshift(toolUseBlock("Skill", { skill: "learn" }));
      }
      lines.push(userPromptLine(`turn ${i + 2}`), assistantLine(assistantContent));
    }
    lines.push(userPromptLine("current turn"));
    return lines;
  }

  test("fires on research-without-propagation once the trailing window elapses", async () => {
    const lines = buildLines({ fillerTurns: TRAILING_WINDOW_TURNS });
    const loadedSkills = [SKILL];
    const detection = await detectKnowledgeAcquisition(lines, loadedSkills, KEYWORDS, new Set());
    expect(detection).not.toBeNull();
    expect(detection?.result.matched).toBe(true);
    expect(detection?.result.detectionRung).toBe("1-lexical");
    expect(detection?.result.matchedSkill).toBe(SKILL);
    expect(detection?.result.researchTools).toContain("WebSearch");
    expect(detection?.result.loadedSkills).toEqual([SKILL]);
    expect(detection?.result.hadPropagation).toBe(false);
  });

  test("mt#3617: records EVERY keyword hit across EVERY loaded skill, while nominating the first", async () => {
    const lines = buildLines({ fillerTurns: TRAILING_WINDOW_TURNS });
    const secondSkill = "prose-review";
    const keywords = new Map<string, string[]>([
      [SKILL, ["argumentative", "prose"]],
      [secondSkill, ["prose", "review"]],
    ]);

    const detection = await detectKnowledgeAcquisition(
      lines,
      [SKILL, secondSkill],
      keywords,
      new Set()
    );

    // Nomination is UNCHANGED by the instrumentation: still the first loaded
    // skill with a hit, and that skill's first matching keyword.
    expect(detection?.result.matchedSkill).toBe(SKILL);
    expect(detection?.result.matchedKeyword).toBe("argumentative");

    // ...while the record now carries the hits nomination discards, which is
    // the whole point: "prose" also matched, and it matched a SECOND skill.
    const hits = detection?.result.keywordHits ?? [];
    expect(hits).toContainEqual({ skill: SKILL, keyword: "argumentative", source: "description" });
    expect(hits).toContainEqual({ skill: SKILL, keyword: "prose", source: "description" });
    expect(hits).toContainEqual({ skill: secondSkill, keyword: "prose", source: "name" });
    // "review" is a keyword of the second skill but absent from the text.
    expect(hits.some((h) => h.keyword === "review")).toBe(false);

    expect(detection?.result.matchedTextExcerpt).toContain("argumentative");
  });

  test("mt#3617: a suppressed (propagation-in-window) record carries the hits too", async () => {
    const lines = buildLines({
      fillerTurns: TRAILING_WINDOW_TURNS,
      propagationToolName: MEMORY_CREATE_TOOL,
      propagationInFillerIndex: 0,
    });
    const detection = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());

    expect(detection?.result.hadPropagation).toBe(true);
    expect(detection?.suppressionReasons).toEqual([SUPPRESSION_PROPAGATION_IN_WINDOW]);
    expect(detection?.result.keywordHits.length).toBeGreaterThan(0);
  });

  test("not yet due: fewer than TRAILING_WINDOW_TURNS elapsed -> null (grace period)", async () => {
    // buildLines' trailing "current turn" prompt itself counts as one elapsed
    // turn beyond the filler loop, so `fillerTurns: TRAILING_WINDOW_TURNS - 2`
    // yields elapsed = TRAILING_WINDOW_TURNS - 1 (just under the bar).
    const lines = buildLines({ fillerTurns: TRAILING_WINDOW_TURNS - 2 });
    const detection = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());
    expect(detection).toBeNull();
  });

  // mt#3207: these three used to assert `null` — the true negative left no
  // trace, so the propagation gate's own fire rate was unmeasurable. They now
  // assert the SUPPRESSED record instead: detected, named gate, never injected.
  test("suppressed (true negative): memory_create in the trailing window", async () => {
    const lines = buildLines({
      fillerTurns: TRAILING_WINDOW_TURNS,
      propagationToolName: MEMORY_CREATE_TOOL,
      propagationInFillerIndex: 1,
    });
    const detection = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());
    expect(detection?.suppressionReasons).toEqual([SUPPRESSION_PROPAGATION_IN_WINDOW]);
    expect(detection?.result.hadPropagation).toBe(true);
  });

  test("suppressed (true negative): tasks_create in the trailing window", async () => {
    const lines = buildLines({
      fillerTurns: TRAILING_WINDOW_TURNS,
      propagationToolName: "mcp__minsky__tasks_create",
      propagationInFillerIndex: 2,
    });
    const detection = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());
    expect(detection?.suppressionReasons).toEqual([SUPPRESSION_PROPAGATION_IN_WINDOW]);
  });

  test("suppressed (true negative): a `/learn` Skill invocation in the trailing window", async () => {
    const lines = buildLines({
      fillerTurns: TRAILING_WINDOW_TURNS,
      learnSkillInFillerIndex: 0,
    });
    const detection = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());
    expect(detection?.suppressionReasons).toEqual([SUPPRESSION_PROPAGATION_IN_WINDOW]);
  });

  // mt#3272 — the spec-writing channels. Research done inside /plan-task or
  // /create-task lands in the task spec, not in a memory, and was reading as
  // "never written down." Measured: 11 fires across two sessions on the
  // 2026-08-03 sweep, both of which had written their findings into specs.
  test("suppressed (mt#3272): tasks_spec_patch in the trailing window", async () => {
    const lines = buildLines({
      fillerTurns: TRAILING_WINDOW_TURNS,
      propagationToolName: "mcp__minsky__tasks_spec_patch",
      propagationInFillerIndex: 1,
    });
    const detection = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());
    expect(detection?.suppressionReasons).toEqual([SUPPRESSION_PROPAGATION_IN_WINDOW]);
    expect(detection?.result.hadPropagation).toBe(true);
  });

  test("suppressed (mt#3272): tasks_spec_search_replace in the trailing window", async () => {
    const lines = buildLines({
      fillerTurns: TRAILING_WINDOW_TURNS,
      propagationToolName: "mcp__minsky__tasks_spec_search_replace",
      propagationInFillerIndex: 0,
    });
    const detection = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());
    expect(detection?.suppressionReasons).toEqual([SUPPRESSION_PROPAGATION_IN_WINDOW]);
  });

  test("suppressed (mt#3272): memory_update in the trailing window", async () => {
    const lines = buildLines({
      fillerTurns: TRAILING_WINDOW_TURNS,
      propagationToolName: "mcp__minsky__memory_update",
      propagationInFillerIndex: 2,
    });
    const detection = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());
    expect(detection?.suppressionReasons).toEqual([SUPPRESSION_PROPAGATION_IN_WINDOW]);
  });

  // The boundary that keeps the widening from swallowing the detector. Writing
  // code is not capturing research about it; if these counted, almost nothing
  // would ever fire. Covers the CLASS, not one member (PR #2591 R1): all four
  // source-editing tools, each of which is frequent in real transcripts —
  // `session_edit_file` alone appears 1485 times across the local corpus.
  test.each([
    "mcp__minsky__session_write_file",
    "mcp__minsky__session_edit_file",
    "mcp__minsky__session_search_replace",
    "Edit",
  ])("mt#3272: a SOURCE edit (%s) is NOT propagation", async (toolName) => {
    const lines = buildLines({
      fillerTurns: TRAILING_WINDOW_TURNS,
      propagationToolName: toolName,
      propagationInFillerIndex: 1,
    });
    const detection = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());
    expect(detection?.suppressionReasons).toEqual([]);
    expect(detection?.result.hadPropagation).toBe(false);
  });

  test("mt#3207: a live fire records an EMPTY suppressionReasons, not an absent one", async () => {
    const lines = buildLines({ fillerTurns: TRAILING_WINDOW_TURNS });
    const detection = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());
    expect(detection?.suppressionReasons).toEqual([]);
    expect(detection?.result.hadPropagation).toBe(false);
  });

  test("mt#3207: the grace-period leg records NOTHING — it is a deferral, not a suppression", async () => {
    // Not yet due for evaluation: recording it would fire every turn AND burn
    // the dedupe key the eventual real fire needs (mt#3207 §D2).
    const lines = buildLines({ fillerTurns: 1 });
    expect(await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set())).toBeNull();
  });

  test("suppressed: no keyword overlap with any loaded skill -> null", async () => {
    const lines = buildLines({
      fillerTurns: TRAILING_WINDOW_TURNS,
      researchQuery: "how does the bun test runner handle timeouts",
    });
    const detection = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());
    expect(detection).toBeNull();
  });

  test("dedupe (mt#3720): a session that already recorded a verdict never re-fires", async () => {
    const lines = buildLines({ fillerTurns: TRAILING_WINDOW_TURNS });
    const detection = await detectKnowledgeAcquisition(
      lines,
      [SKILL],
      KEYWORDS,
      new Set([SESSION_VERDICT_DEDUPE_KEY])
    );
    expect(detection).toBeNull();
  });

  test("no research tool calls at all -> null", async () => {
    const lines: TranscriptLine[] = [
      userPromptLine("first"),
      skillLoadLine(SKILL),
      userPromptLine("second"),
    ];
    expect(await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set())).toBeNull();
  });

  test("no loaded skills -> null (rung 1's session-level filter)", async () => {
    const lines = buildLines({ fillerTurns: TRAILING_WINDOW_TURNS });
    expect(await detectKnowledgeAcquisition(lines, [], KEYWORDS, new Set())).toBeNull();
  });

  test("RESEARCH_TOOL_NAMES covers WebSearch, WebFetch, and the knowledge tools", async () => {
    expect(RESEARCH_TOOL_NAMES).toContain("WebSearch");
    expect(RESEARCH_TOOL_NAMES).toContain("WebFetch");
    expect(RESEARCH_TOOL_NAMES).toContain("mcp__minsky__knowledge_fetch");
    expect(RESEARCH_TOOL_NAMES).toContain("mcp__minsky__knowledge_search");
  });
});

// ---------------------------------------------------------------------------
// Session-grain verdict (mt#3720)
//
// The block above uses single-occurrence fixtures, where session grain and the
// old per-occurrence grain coincide. These tests cover what only session grain
// can express: multiple research calls in one session, a propagation that lands
// far beyond the grace period, and the once-per-session record bound.
// ---------------------------------------------------------------------------

describe("detectKnowledgeAcquisition — session grain (mt#3720)", () => {
  const SKILL = ENGINEERING_WRITING_SKILL;
  const KEYWORDS = new Map<string, string[]>([[SKILL, ["argumentative", "prose"]]]);

  type SessionEvent = "research" | "propagate" | "filler";

  /**
   * Builds a session transcript: the skill loads first, then one turn per entry
   * in `events`, then a final real user prompt. Every entry is its own turn, so
   * the count of entries after an event is also the count of turn boundaries
   * after it.
   */
  function buildSession(events: SessionEvent[]): TranscriptLine[] {
    const lines: TranscriptLine[] = [userPromptLine(OPENING_PROMPT), skillLoadLine(SKILL)];
    events.forEach((event, i) => {
      lines.push(userPromptLine(`turn ${i}`));
      if (event === "research") {
        lines.push(
          assistantLine([toolUseBlock("WebSearch", { query: `argumentative prose pass ${i}` })])
        );
      } else if (event === "propagate") {
        lines.push(assistantLine([toolUseBlock(MEMORY_CREATE_TOOL, {})]));
      } else {
        lines.push(assistantLine([textBlock(`filler ${i}`)]));
      }
    });
    lines.push(userPromptLine("current turn"));
    return lines;
  }

  const filler = (n: number): SessionEvent[] => Array.from({ length: n }, () => "filler" as const);

  test("AT1: research early, the durable write ~18 turns later -> propagated, not a miss", async () => {
    // The originating false-positive shape (session aecd65f4, ask#6891): the
    // save lands FAR beyond the 5-turn grace. v1 judged the research call the
    // moment grace elapsed — 13 turns before this memory_create existed — and
    // its per-occurrence dedupe made that wrong verdict permanent.
    const lines = buildSession(["research", ...filler(18), "propagate", ...filler(2)]);
    const detection = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());

    expect(detection).not.toBeNull();
    expect(detection?.result.hadPropagation).toBe(true);
    expect(detection?.suppressionReasons).toEqual([SUPPRESSION_PROPAGATION_IN_WINDOW]);
    expect(detection?.dedupeKey).toBe(SESSION_VERDICT_DEDUPE_KEY);
  });

  test("AT2: research with no propagation records exactly one verdict per session", async () => {
    const lines = buildSession(["research", ...filler(6)]);

    const first = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());
    expect(first).not.toBeNull();
    expect(first?.result.hadPropagation).toBe(false);
    expect(first?.suppressionReasons).toEqual([]);
    expect(first?.dedupeKey).toBe(SESSION_VERDICT_DEDUPE_KEY);

    // A later Stop invocation on the same session, with that verdict now in the
    // log. Asserting the second call is silent is what makes "exactly once" a
    // tested invariant rather than an assumption about how often Stop fires.
    const second = await detectKnowledgeAcquisition(
      lines,
      [SKILL],
      KEYWORDS,
      new Set([SESSION_VERDICT_DEDUPE_KEY])
    );
    expect(second).toBeNull();
  });

  test("AT3: six research calls in one session collapse to a single verdict", async () => {
    // The `aecd65f4` cluster's shape: repeated research, one eventual save. v1
    // keyed dedupe per occurrence, so each of these fired independently.
    const lines = buildSession([
      "research",
      "research",
      "research",
      "research",
      "research",
      "research",
      ...filler(12),
      "propagate",
      ...filler(2),
    ]);

    const detection = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());
    expect(detection?.dedupeKey).toBe(SESSION_VERDICT_DEDUPE_KEY);
    expect(detection?.result.hadPropagation).toBe(true);
    expect(
      await detectKnowledgeAcquisition(
        lines,
        [SKILL],
        KEYWORDS,
        new Set([SESSION_VERDICT_DEDUPE_KEY])
      )
    ).toBeNull();
  });

  test("one uncaptured occurrence makes the whole session's verdict a miss", async () => {
    // The propagation sits BETWEEN the two research calls, so the first is
    // captured and the second never is. The session's purpose is catching
    // knowledge that was never captured anywhere, so this is a miss.
    const lines = buildSession(["research", "propagate", "research", ...filler(6)]);
    const detection = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());

    expect(detection?.result.hadPropagation).toBe(false);
    expect(detection?.suppressionReasons).toEqual([]);
  });

  test("the grace period runs against the LATEST matched occurrence, not the first", async () => {
    // The first research call's own grace elapsed long ago; the second's has
    // not, so the session is not yet eligible and nothing is recorded. This is
    // the clock-extension that stops a still-working session being judged.
    const lines = buildSession(["research", ...filler(10), "research", "filler"]);
    expect(await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set())).toBeNull();
  });

  // Stop fires once per TURN, so the detector sees a GROWING transcript, not
  // the finished one. These two tests pin what that costs — the residual this
  // re-grain accepts rather than removes, and the reason mt#3740 exists. The
  // first asserts the CURRENT wrong behavior deliberately: mt#3740 must invert
  // it, not delete it.
  test("known limitation: a miss recorded before a late propagation stays permanent", async () => {
    const full: SessionEvent[] = ["research", ...filler(18), "propagate", ...filler(2)];

    // Stop invocation at turn ~8: grace has elapsed, the save does not exist
    // yet, so the session records a miss and burns its one dedupe key.
    const early = await detectKnowledgeAcquisition(
      buildSession(full.slice(0, 8)),
      [SKILL],
      KEYWORDS,
      new Set()
    );
    expect(early?.result.hadPropagation).toBe(false);
    expect(early?.suppressionReasons).toEqual([]);

    // A later Stop invocation, now seeing the memory_create. The verdict it
    // would produce is correct — but the burned key means it is never recorded,
    // so the log keeps the earlier wrong answer.
    const late = await detectKnowledgeAcquisition(
      buildSession(full),
      [SKILL],
      KEYWORDS,
      new Set([SESSION_VERDICT_DEDUPE_KEY])
    );
    expect(late).toBeNull();
  });

  test("a session that goes quiet before propagating is still bounded to ONE record", async () => {
    // The bound is what this re-grain buys unconditionally: whatever the
    // verdict's accuracy, the 13-records-from-one-session shape cannot recur.
    const full: SessionEvent[] = ["research", "research", "research", ...filler(9)];
    const logged = new Set<string>();
    let records = 0;

    for (let turn = 6; turn <= full.length; turn++) {
      const detection = await detectKnowledgeAcquisition(
        buildSession(full.slice(0, turn)),
        [SKILL],
        KEYWORDS,
        logged
      );
      if (detection) {
        records++;
        logged.add(detection.dedupeKey);
      }
    }

    expect(records).toBe(1);
  });

  test("mt#3207 census semantics survive the re-grain: both verdicts emit a record", async () => {
    const missed = await detectKnowledgeAcquisition(
      buildSession(["research", ...filler(6)]),
      [SKILL],
      KEYWORDS,
      new Set()
    );
    const propagated = await detectKnowledgeAcquisition(
      buildSession(["research", ...filler(6), "propagate", ...filler(2)]),
      [SKILL],
      KEYWORDS,
      new Set()
    );

    // Both paths emit — the propagation RATE stays measurable from the log
    // alone, which a miss-only record shape would regress.
    expect(missed?.result.hadPropagation).toBe(false);
    expect(missed?.suppressionReasons).toEqual([]);
    expect(propagated?.result.hadPropagation).toBe(true);
    expect(propagated?.suppressionReasons).toEqual([SUPPRESSION_PROPAGATION_IN_WINDOW]);
  });

  // mt#3901 — the verdict was written as `every(occ => hasPropagationAfter(occ))`
  // and commented as per-occurrence strictness. Because `hasPropagationAfter` is
  // unbounded, it is monotone in position, so that conjunction was equivalent to
  // a single check on the LAST occurrence. These pin the equivalence, so a future
  // change that reintroduces the redundant form (or breaks the semantic) fails.
  describe("mt#3901 — the verdict is a last-occurrence check, not a per-occurrence one", () => {
    test("mt#3901 AT1: two research occurrences sharing ONE later capture -> propagated", async () => {
      // The case that distinguishes the two formulations. The retired comment
      // said this should be a miss ("one uncaptured piece of research is
      // enough"); the code has always scored it propagated, and that is now the
      // documented semantic. Recording it as a test makes the choice visible
      // rather than emergent — the strict reading is mt#3783's rung-3 scope.
      const lines = buildSession([
        "research",
        ...filler(2),
        "research",
        ...filler(2),
        "propagate",
        ...filler(6),
      ]);
      const detection = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());

      expect(detection?.result.hadPropagation).toBe(true);
      expect(detection?.suppressionReasons).toEqual([SUPPRESSION_PROPAGATION_IN_WINDOW]);
    });

    test("mt#3901 AT2: mt#3720 regression control — one occurrence, far-later capture, still propagated", async () => {
      // mt#3720 deliberately made late capture a TRUE NEGATIVE. Re-bounding the
      // propagation search to a window was the rejected option (a); this pins
      // that it was not quietly adopted.
      const lines = buildSession(["research", ...filler(18), "propagate", ...filler(2)]);
      const detection = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());

      expect(detection?.result.hadPropagation).toBe(true);
    });

    test("mt#3901 AT3: research AFTER the last capture -> miss", async () => {
      // The case the old and new forms both get right, and the only shape that
      // can still produce a miss: the session's final research is uncaptured.
      const lines = buildSession([
        "research",
        ...filler(2),
        "propagate",
        ...filler(2),
        "research",
        ...filler(6),
      ]);
      const detection = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());

      expect(detection?.result.hadPropagation).toBe(false);
      expect(detection?.suppressionReasons).toEqual([]);
    });

    test("mt#3901 AT4: occurrence ORDER does not change the verdict", async () => {
      // The implementation takes the max index rather than `at(-1)`, because
      // nothing guarantees `matchedOccurrences` is ordered and the equivalence
      // argument depends on genuinely reaching the LAST occurrence. Two research
      // calls with the capture between them must be a miss regardless of the
      // order the occurrences are collected in — the second research is
      // uncaptured either way.
      const lines = buildSession(["research", "propagate", "research", ...filler(6)]);
      const detection = await detectKnowledgeAcquisition(lines, [SKILL], KEYWORDS, new Set());

      expect(detection?.result.hadPropagation).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// run() (dispatcher-compatible) — silent-path + override tests (fake cwd is fine;
// these all return before any fs read happens)
// ---------------------------------------------------------------------------

describe("run() (dispatcher-compatible) — silent paths", () => {
  test("no transcript_path -> null", async () => {
    const input: ClaudeHookInput = { ...FAKE_HOOK_INPUT, transcript_path: undefined };
    expect(await run(input, makeCtx([]))).toBeNull();
  });

  test("empty transcriptLines -> null", async () => {
    expect(await run(FAKE_HOOK_INPUT, makeCtx([]))).toBeNull();
  });

  test("first turn (fewer than 2 real prompts) -> null (silent)", async () => {
    const lines = [skillLoadLine(ENGINEERING_WRITING_SKILL), userPromptLine("only prompt")];
    expect(await run(FAKE_HOOK_INPUT, makeCtx(lines))).toBeNull();
  });

  test("no loaded skills, even with research + enough elapsed turns -> null", async () => {
    const lines: TranscriptLine[] = [
      userPromptLine("turn 1"),
      assistantLine([toolUseBlock("WebSearch", { query: "something" })]),
    ];
    for (let i = 0; i < TRAILING_WINDOW_TURNS; i++) {
      lines.push(...fillerTurn(`turn ${i + 2}`, "filler"));
    }
    lines.push(userPromptLine("current"));
    expect(await run(FAKE_HOOK_INPUT, makeCtx(lines))).toBeNull();
  });

  test("override env var suppresses detection and returns an audit line", async () => {
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const lines = [skillLoadLine(ENGINEERING_WRITING_SKILL), userPromptLine("second")];
      const outcome = await run(FAKE_HOOK_INPUT, makeCtx(lines));
      expect(outcome?.calibration).toBeUndefined();
      expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
    } finally {
      delete process.env[OVERRIDE_ENV_VAR];
    }
  });

  test("INJECTION_ENABLED is false (calibration-only, v1)", async () => {
    expect(INJECTION_ENABLED).toBe(false);
  });

  test("OVERRIDE_ENV_VAR exports the correct env var name", async () => {
    expect(OVERRIDE_ENV_VAR).toBe("MINSKY_ACK_KNOWLEDGE_ACQUISITION");
  });
});

// ---------------------------------------------------------------------------
// run() against the REAL engineering-writing skill file on disk (mt#2708
// acceptance test: "the originating incident replayed... produces a match"
// AND the MANDATORY tool-interleaved transcript fixture — memory a3e60471:
// tool_result lines carry role "user", which silently killed three sibling
// hooks. This detector's whole signal is tool calls interleaved with text.
// ---------------------------------------------------------------------------

describe("run() against the real engineering-writing skill (mt#2708 originating-incident replay)", () => {
  // input.cwd = import.meta.dir (this file's own directory, `.minsky/hooks/`) —
  // findRepoRoot walks up from a REAL on-disk path to the real repo root, so
  // readSkillDescription reads the REAL `.claude/skills/engineering-writing/SKILL.md`.
  // A distinctive, never-reused session_id keeps the dedupe read (a real,
  // read-only fs access against `.minsky/knowledge-acquisition-calibration.jsonl`)
  // from ever colliding with a genuine prior record.
  const REAL_REPO_INPUT: ClaudeHookInput = {
    session_id: "mt2708-unittest-originating-incident-do-not-reuse",
    transcript_path: "/mock/transcript.jsonl",
    cwd: import.meta.dir,
    hook_event_name: HOOK_EVENT_NAME,
  };

  test("tool-interleaved fixture (research -> tool_result[user-role] -> assistant text -> real prompt) produces a match", async () => {
    const lines: TranscriptLine[] = [
      // Turn 0: skill loaded.
      userPromptLine(OPENING_PROMPT),
      skillLoadLine(ENGINEERING_WRITING_SKILL),
      // Turn 1: research call, tool_result interleaved (the mandatory shape),
      // then assistant follow-up TEXT in the SAME turn.
      userPromptLine(RESEARCH_PROMPT),
      assistantLine([
        toolUseBlock("WebSearch", {
          query: RESEARCH_QUERY,
        }),
      ]),
      toolResultLine("toolu_mt2708_1", "Common AI tells: em dashes, tricolons, hedging phrases."),
      assistantLine([textBlock("Found several AI-writing tells to avoid in the essay.")]),
    ];
    // TRAILING_WINDOW_TURNS filler turns so the grace period has elapsed.
    for (let i = 0; i < TRAILING_WINDOW_TURNS; i++) {
      lines.push(...fillerTurn(`turn ${i + 3}`, `continuing the draft (${i})`));
    }
    lines.push(userPromptLine("current turn (triggers the hook)"));

    const outcome = await run(REAL_REPO_INPUT, makeCtx(lines));

    expect(outcome?.calibration).toBeDefined();
    expect(outcome?.calibration?.matchedSkill).toBe(ENGINEERING_WRITING_SKILL);
    expect(outcome?.calibration?.detectionRung).toBe("1-lexical");
    expect(outcome?.calibration?.hadPropagation).toBe(false);
    expect(Array.isArray(outcome?.calibration?.researchTools)).toBe(true);
    expect(outcome?.calibration?.researchTools).toContain("WebSearch");
    expect(outcome?.additionalContext).toBeUndefined();
  });

  // PR #2239 R1/R2 regression: resolveSkillKeywords must ALWAYS populate an
  // entry for a loaded skill, even when its SKILL.md is missing/unreadable —
  // extractSkillKeywords derives name tokens from the skill NAME independently
  // of the description, so a skill with no readable file must still be able
  // to match on a name-token overlap. An earlier revision gated the map
  // entry on a truthy description, silently dropping the name tokens for
  // exactly this case (a false-negative path the rung-2-lite gate must not
  // have).
  test("a loaded skill with no readable SKILL.md still matches on a name-token overlap", async () => {
    const NONEXISTENT_SKILL = "totally-nonexistent-widget-skill";
    const lines: TranscriptLine[] = [
      userPromptLine("please help me design something"),
      skillLoadLine(NONEXISTENT_SKILL),
      userPromptLine("go research it"),
      assistantLine([
        toolUseBlock("WebSearch", { query: "how to build a nonexistent widget prototype" }),
      ]),
    ];
    for (let i = 0; i < TRAILING_WINDOW_TURNS; i++) {
      lines.push(...fillerTurn(`turn ${i + 3}`, `continuing (${i})`));
    }
    lines.push(userPromptLine("current turn (triggers the hook)"));

    const outcome = await run(
      {
        session_id: "mt2708-unittest-unreadable-skill-do-not-reuse",
        transcript_path: "/mock/transcript.jsonl",
        cwd: import.meta.dir,
        hook_event_name: HOOK_EVENT_NAME,
      },
      makeCtx(lines)
    );

    expect(outcome?.calibration).toBeDefined();
    expect(outcome?.calibration?.matchedSkill).toBe(NONEXISTENT_SKILL);
    // Matched on a NAME token ("nonexistent" or "widget"), not a description
    // keyword — there is no description at all for a skill whose SKILL.md
    // does not exist on disk.
    expect(["nonexistent", "widget"]).toContain(outcome?.calibration?.matchedKeyword);
  });
});

// ---------------------------------------------------------------------------
// mt#3617 — keyword-hit instrumentation primitives
// ---------------------------------------------------------------------------

describe("Rung-2 nomination (mt#3772)", () => {
  const SKILL = ENGINEERING_WRITING_SKILL;
  const OTHER = "tanstack-query";
  // The lexical gate matches these; Rung 2 is asked the same question and can
  // disagree, which is the entire point of the change.
  const KEYWORDS = new Map<string, string[]>([
    [SKILL, ["argumentative", "prose"]],
    [OTHER, ["query", "tanstack"]],
  ]);

  function buildLines(fillerTurns: number): TranscriptLine[] {
    const lines: TranscriptLine[] = [
      userPromptLine("please write an essay about AI writing tells"),
      skillLoadLine(SKILL),
      userPromptLine(RESEARCH_PROMPT),
      assistantLine([
        toolUseBlock("WebSearch", {
          query: RESEARCH_QUERY,
        }),
      ]),
    ];
    for (let i = 0; i < fillerTurns; i++) {
      lines.push(userPromptLine(`turn ${i + 2}`), assistantLine([textBlock(`filler ${i}`)]));
    }
    lines.push(userPromptLine("current turn"));
    return lines;
  }

  test("a nomination decides the skill, and the record says rung 2 decided it", async () => {
    const detection = await detectKnowledgeAcquisition(
      buildLines(TRAILING_WINDOW_TURNS),
      [SKILL, OTHER],
      KEYWORDS,
      new Set(),
      TRAILING_WINDOW_TURNS,
      async () => ({ kind: "nominated", skill: OTHER, score: 0.61, segment: "a segment" })
    );

    // OTHER wins even though the lexical gate would have picked SKILL first —
    // proof the nomination, not the keyword scan, decided the verdict.
    expect(detection?.result.matchedSkill).toBe(OTHER);
    expect(detection?.result.detectionRung).toBe("2-embedding");
    expect(detection?.result.nominationScore).toBe(0.61);
    expect(detection?.result.degradedReason).toBeUndefined();
  });

  test("`none` is a real negative — it does NOT fall through to the lexical gate", async () => {
    const detection = await detectKnowledgeAcquisition(
      buildLines(TRAILING_WINDOW_TURNS),
      [SKILL, OTHER],
      KEYWORDS,
      new Set(),
      TRAILING_WINDOW_TURNS,
      async () => ({ kind: "none" })
    );

    // The lexical gate WOULD have matched this text (see the sibling tests
    // above). Rung 2 ran and said no, so the verdict is silence — suppressing
    // exactly the tautological keyword fire this task exists to remove.
    expect(detection).toBeNull();
  });

  test("`degraded` falls back to the lexical gate and records the reason", async () => {
    const detection = await detectKnowledgeAcquisition(
      buildLines(TRAILING_WINDOW_TURNS),
      [SKILL, OTHER],
      KEYWORDS,
      new Set(),
      TRAILING_WINDOW_TURNS,
      async () => ({ kind: "degraded", reason: "provider-unconfigured" })
    );

    expect(detection?.result.matchedSkill).toBe(SKILL);
    expect(detection?.result.detectionRung).toBe("1-lexical");
    expect(detection?.result.degradedReason).toBe("provider-unconfigured");
    expect(detection?.result.nominationScore).toBeUndefined();
  });

  test("a degradation part-way through discards the rung-2 results — no mixed verdict", async () => {
    let call = 0;
    const detection = await detectKnowledgeAcquisition(
      buildLines(TRAILING_WINDOW_TURNS),
      [SKILL, OTHER],
      KEYWORDS,
      new Set(),
      TRAILING_WINDOW_TURNS,
      async () => {
        call += 1;
        return call === 1
          ? { kind: "nominated", skill: OTHER, score: 0.9, segment: "seg" }
          : { kind: "degraded", reason: "late-failure" };
      }
    );

    // Were the earlier nomination kept, matchedSkill would be OTHER at score
    // 0.9 while detectionRung said lexical — a record that misdescribes how its
    // own verdict was reached.
    if (call > 1) {
      expect(detection?.result.detectionRung).toBe("1-lexical");
      expect(detection?.result.matchedSkill).toBe(SKILL);
      expect(detection?.result.nominationScore).toBeUndefined();
    }
  });

  test("no nominator supplied — behaviour is the pre-mt#3772 lexical path", async () => {
    const detection = await detectKnowledgeAcquisition(
      buildLines(TRAILING_WINDOW_TURNS),
      [SKILL, OTHER],
      KEYWORDS,
      new Set()
    );

    expect(detection?.result.matchedSkill).toBe(SKILL);
    expect(detection?.result.detectionRung).toBe("1-lexical");
    expect(detection?.result.degradedReason).toBeUndefined();
  });

  test("the session budget is spent only once the deadline is reached", () => {
    const deadline = 10_000;
    expect(isNominationBudgetExhausted(deadline, 9_999)).toBe(false);
    expect(isNominationBudgetExhausted(deadline, 10_000)).toBe(true);
    expect(isNominationBudgetExhausted(deadline, 10_001)).toBe(true);
  });

  test("SC5 invariant: the nomination budget leaves headroom inside the registered guard timeout", async () => {
    // Read the budget the DISPATCHER enforces rather than restating it — a
    // registry change that shrinks this guard's timeout must fail here, not in
    // production where the symptom is a killed guard and no record at all.
    const { GUARD_REGISTRY } = await import("./registry");
    const entry = GUARD_REGISTRY.find((g) => g.name === "knowledge-acquisition-detector");
    expect(entry).toBeDefined();
    const guardBudget = entry?.timeoutMs ?? 0;

    expect(guardBudget).toBeGreaterThan(0);
    // Nomination may not consume the whole slot: the detector still has to run
    // its propagation scan and write the record after nomination returns.
    expect(NOMINATION_SESSION_BUDGET_MS).toBeLessThan(guardBudget);
    expect(guardBudget - NOMINATION_SESSION_BUDGET_MS).toBeGreaterThanOrEqual(3000);
  });

  test("Rung 2 is OFF by default — the env var is the only way in", () => {
    delete process.env[RUNG2_NOMINATION_ENV_VAR];
    expect(isRung2NominationEnabled()).toBe(false);
    process.env[RUNG2_NOMINATION_ENV_VAR] = "1";
    expect(isRung2NominationEnabled()).toBe(true);
    delete process.env[RUNG2_NOMINATION_ENV_VAR];
  });
});

describe("isNameDerivedKeyword (mt#3617)", () => {
  test("a hyphen-split name segment is name-derived", async () => {
    expect(isNameDerivedKeyword("plan-task", "task")).toBe(true);
    expect(isNameDerivedKeyword("plan-task", "plan")).toBe(true);
  });

  test("a word absent from the name is description-derived", async () => {
    expect(isNameDerivedKeyword("implement-task", "minsky")).toBe(false);
  });

  test("a segment shorter than 4 chars is not a name keyword", async () => {
    // `extractSkillKeywords` never emits it, so it must not be claimed as one.
    expect(isNameDerivedKeyword("draft-rfc", "rfc")).toBe(false);
  });

  test("underscore-separated names split the same way", async () => {
    expect(isNameDerivedKeyword("tanstack_query", "query")).toBe(true);
  });
});

describe("findAllKeywordOverlaps (mt#3617)", () => {
  const TEXTS = ["designing a retrospective for the release", "notes about query planning"];

  test("returns EVERY matching keyword, not just the first", async () => {
    const hits = findAllKeywordOverlaps("retrospective", TEXTS, [
      "retrospective",
      "query",
      "absent",
    ]);
    expect(hits.map((h) => h.keyword)).toEqual(["retrospective", "query"]);
  });

  test("tags provenance per keyword", async () => {
    const hits = findAllKeywordOverlaps("retrospective", TEXTS, ["retrospective", "query"]);
    expect(hits).toEqual([
      { skill: "retrospective", keyword: "retrospective", source: "name" },
      { skill: "retrospective", keyword: "query", source: "description" },
    ]);
  });

  test("matches whole words only", async () => {
    expect(findAllKeywordOverlaps("s", ["retrospectives are useful"], ["retrospective"])).toEqual(
      []
    );
  });

  test("returns [] when nothing matches", async () => {
    expect(findAllKeywordOverlaps("skill", TEXTS, ["nothing", "here"])).toEqual([]);
  });
});

describe("buildMatchExcerpt (mt#3617)", () => {
  test("returns a bounded window containing the keyword", async () => {
    const long = `${"x".repeat(1000)} needle ${"y".repeat(1000)}`;
    const excerpt = buildMatchExcerpt([long], "needle");
    expect(excerpt).toContain("needle");
    expect(excerpt?.length).toBeLessThanOrEqual(400);
  });

  test("returns undefined when the keyword is absent", async () => {
    expect(buildMatchExcerpt(["nothing relevant"], "needle")).toBeUndefined();
  });

  test("returns undefined when there is no matched keyword", async () => {
    expect(buildMatchExcerpt(["anything"], undefined)).toBeUndefined();
  });

  test("does not truncate a short text", async () => {
    expect(buildMatchExcerpt(["a needle here"], "needle")).toBe("a needle here");
  });
});
