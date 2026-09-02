/**
 * Tests for the transcript search result projection (mt#4917).
 *
 * The BYTE-SIZE regression this exists for lives beside the command, in
 * `src/adapters/shared/commands/transcripts/search-text-command.test.ts`: the
 * limit it must clear is `MAX_TOOL_RESPONSE_TEXT_BYTES`, which is an MCP-layer
 * constant, and asserting it from the domain layer would mean importing
 * upward. These are the shape rules the projection has to get right for that
 * assertion to be worth anything.
 */

import { describe, test, expect } from "bun:test";
import {
  DEFAULT_TRANSCRIPT_SEARCH_PROJECTION,
  deriveTurnRole,
  parseSearchProjection,
  projectTurnResult,
  projectTurnResults,
} from "./transcript-search-projection";
import type { TranscriptTurnResult } from "./transcript-similarity-service";

function makeResult(overrides: Partial<TranscriptTurnResult> = {}): TranscriptTurnResult {
  return {
    agentSessionId: "session-a",
    turnIndex: 7,
    userText: "what did we decide about the pooler",
    userOrigin: "human",
    assistantText: "we kept session-pool mode",
    startedAt: new Date("2026-09-01T10:00:00Z"),
    endedAt: new Date("2026-09-01T10:00:05Z"),
    isSpawnBoundary: false,
    score: 0.42,
    sessionMetadata: {
      agentSessionId: "session-a",
      startedAt: new Date("2026-09-01T09:00:00Z"),
      model: "claude",
      messageCount: 12,
      relatedTaskIds: ["mt#4917"],
      relatedPrNumbers: ["#1"],
      parentAgentSessionId: null,
    },
    resumeHint: "cd '/repo' && claude --resume session-a",
    snippet: "what did we decide about the [pooler]",
    ...overrides,
  };
}

describe("deriveTurnRole", () => {
  test("both sides present reads as 'both'", () => {
    expect(deriveTurnRole("u", "a")).toBe("both");
  });

  test("one side present names that side", () => {
    expect(deriveTurnRole("u", null)).toBe("user");
    expect(deriveTurnRole(null, "a")).toBe("assistant");
  });

  test("neither side present reads as 'none'", () => {
    expect(deriveTurnRole(null, null)).toBe("none");
  });

  test("an EMPTY string is present, not absent", () => {
    // The role filter tests `IS NOT NULL`, not emptiness, so a turn whose text
    // is the empty string still HAS that side. Reading `""` as absent here
    // would disagree with the filter that selected the row.
    expect(deriveTurnRole("", null)).toBe("user");
    expect(deriveTurnRole("", "")).toBe("both");
  });
});

describe("projectTurnResult", () => {
  test("drops the full text and keeps everything needed to fetch it", () => {
    const projected = projectTurnResult(makeResult());

    expect("userText" in projected).toBe(false);
    expect("assistantText" in projected).toBe(false);

    // The coordinates transcripts_get needs to retrieve the same turn.
    expect(projected.agentSessionId).toBe("session-a");
    expect(projected.turnIndex).toBe(7);

    // And the rest of the envelope, unchanged.
    expect(projected.userOrigin).toBe("human");
    expect(projected.startedAt).toEqual(new Date("2026-09-01T10:00:00Z"));
    expect(projected.endedAt).toEqual(new Date("2026-09-01T10:00:05Z"));
    expect(projected.isSpawnBoundary).toBe(false);
    expect(projected.score).toBe(0.42);
    expect(projected.snippet).toBe("what did we decide about the [pooler]");
    expect(projected.resumeHint).toBe("cd '/repo' && claude --resume session-a");
    expect(projected.sessionMetadata.messageCount).toBe(12);
  });

  test("carries the role, which is otherwise unrecoverable once the text is gone", () => {
    expect(projectTurnResult(makeResult()).role).toBe("both");
    expect(projectTurnResult(makeResult({ assistantText: null })).role).toBe("user");
    expect(projectTurnResult(makeResult({ userText: null })).role).toBe("assistant");
  });

  test("reports how many characters it dropped, summed across both sides", () => {
    const projected = projectTurnResult(
      makeResult({ userText: "12345", assistantText: "1234567890" })
    );
    expect(projected.omittedTextChars).toBe(15);
  });

  test("omittedTextChars is 0 when the turn carried no text", () => {
    const projected = projectTurnResult(makeResult({ userText: null, assistantText: null }));
    expect(projected.omittedTextChars).toBe(0);
  });

  test("a missing snippet becomes an empty string rather than undefined", () => {
    // `snippet` is optional on the source type; the projected shape declares it
    // required, so a consumer never has to branch on undefined-vs-empty.
    const projected = projectTurnResult(makeResult({ snippet: undefined }));
    expect(projected.snippet).toBe("");
  });
});

describe("projectTurnResults", () => {
  test("the 'full' projection returns the SAME array, untouched", () => {
    const results = [makeResult(), makeResult({ turnIndex: 8 })];
    expect(projectTurnResults(results, "full")).toBe(results);
  });

  test("the 'snippet' projection maps every row", () => {
    const results = [makeResult(), makeResult({ turnIndex: 8 })];
    const projected = projectTurnResults(results, "snippet");

    expect(projected).toHaveLength(2);
    expect(projected).not.toBe(results);
    for (const row of projected) {
      expect("userText" in row).toBe(false);
    }
  });

  test("an empty result set projects to an empty set", () => {
    expect(projectTurnResults([], "snippet")).toEqual([]);
  });
});

describe("parseSearchProjection", () => {
  test("'full' is the only value that turns the projection off", () => {
    expect(parseSearchProjection("full")).toBe("full");
  });

  test("everything else takes the default, including undefined", () => {
    expect(parseSearchProjection(undefined)).toBe(DEFAULT_TRANSCRIPT_SEARCH_PROJECTION);
    expect(parseSearchProjection("snippet")).toBe("snippet");
    expect(parseSearchProjection("nonsense")).toBe("snippet");
    expect(parseSearchProjection(null)).toBe("snippet");
  });

  test("the default is 'snippet' — the whole point of the change", () => {
    expect(DEFAULT_TRANSCRIPT_SEARCH_PROJECTION).toBe("snippet");
  });
});
