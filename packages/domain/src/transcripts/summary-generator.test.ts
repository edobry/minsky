/**
 * Unit tests for SummaryGenerator.
 *
 * Uses a fake CognitionProvider — no real AI API calls.
 *
 * Coverage:
 *  - Prompt structure (system/user content)
 *  - Empty-transcript handling (returns null, no cognition call)
 *  - Successful summary generation
 *  - CognitionProvider returns "unavailable" → error propagated
 *  - CognitionProvider returns "packaged" → error propagated
 *  - CognitionProvider throws → error propagated
 *  - Turn truncation (>50 turns)
 *  - Tool call names appear in the prompt
 *
 * @see mt#1353 — summary-generator.ts
 */

import { describe, test, expect } from "bun:test";

import type { CognitionProvider, CognitionResult, CognitionTask } from "../cognition/types";
import type { ExtractedTurn } from "./turn-extractor";
import { SummaryGenerator } from "./summary-generator";
import { safeTruncate } from "@minsky/shared/safe-truncate";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build an ExtractedTurn for testing. */
function makeTurn(
  turnIndex: number,
  opts: {
    userText?: string | null;
    assistantText?: string | null;
    toolNames?: string[];
  } = {}
): ExtractedTurn {
  return {
    turnIndex,
    userText: opts.userText ?? `user prompt ${turnIndex}`,
    assistantText: opts.assistantText ?? `assistant response ${turnIndex}`,
    toolCalls: opts.toolNames ? opts.toolNames.map((name) => ({ type: "tool_use", name })) : null,
    startedAt: null,
    endedAt: null,
    isSpawnBoundary: false,
  };
}

/** Captured call arguments from the fake provider. */
interface CapturedCall {
  task: CognitionTask<unknown>;
}

type FakeProviderMode =
  | { kind: "success"; summary: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "packaged" }
  | { kind: "throw"; error: Error };

/**
 * Create a fake CognitionProvider that records calls and returns a fixed result.
 */
function makeFakeProvider(
  mode: FakeProviderMode = { kind: "success", summary: "A session summary." }
): { provider: CognitionProvider; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];

  const provider: CognitionProvider = {
    async perform<T>(task: CognitionTask<T>): Promise<CognitionResult<T>> {
      calls.push({ task });

      if (mode.kind === "throw") {
        throw mode.error;
      }

      if (mode.kind === "unavailable") {
        return { kind: "unavailable", reason: mode.reason } as CognitionResult<T>;
      }

      if (mode.kind === "packaged") {
        // Return a minimal packaged bundle — content doesn't matter for these tests.
        return {
          kind: "packaged",
          bundle: { id: "bundle-1", tasks: [], order: "sequential" },
        } as CognitionResult<T>;
      }

      // "success" mode — return the summary wrapped in the expected schema shape.
      return {
        kind: "completed",
        value: { summary: mode.summary } as unknown as T,
      };
    },

    async performBatch<Ts extends readonly CognitionTask<unknown>[]>(
      _tasks: Ts
    ): Promise<CognitionResult<import("../cognition/types").CognitionBatchValues<Ts>>> {
      throw new Error("performBatch not used by SummaryGenerator");
    },
  };

  return { provider, calls };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const SESSION_ID = "aaaaaaaa-0000-0000-0000-000000000001";

describe("SummaryGenerator", () => {
  describe("empty transcript handling", () => {
    test("returns null and makes no cognition call when turns array is empty", async () => {
      const { provider, calls } = makeFakeProvider();
      const generator = new SummaryGenerator(provider);

      const result = await generator.generateSummary(SESSION_ID, []);

      expect(result).toBeNull();
      expect(calls).toHaveLength(0);
    });
  });

  describe("successful summary generation", () => {
    test("returns summary text from cognition provider", async () => {
      const expectedSummary = "The agent fixed the bug in mt#999.";
      const { provider } = makeFakeProvider({ kind: "success", summary: expectedSummary });
      const generator = new SummaryGenerator(provider);

      const turns = [makeTurn(0), makeTurn(1)];
      const result = await generator.generateSummary(SESSION_ID, turns);

      expect(result).toBe(expectedSummary);
    });

    test("makes exactly one cognition call per invocation", async () => {
      const { provider, calls } = makeFakeProvider({ kind: "success", summary: "Done." });
      const generator = new SummaryGenerator(provider);

      await generator.generateSummary(SESSION_ID, [makeTurn(0), makeTurn(1)]);

      expect(calls).toHaveLength(1);
    });

    test("task id contains the agentSessionId for correlation", async () => {
      const { provider, calls } = makeFakeProvider({ kind: "success", summary: "Done." });
      const generator = new SummaryGenerator(provider);

      await generator.generateSummary(SESSION_ID, [makeTurn(0)]);

      const capturedTask = calls[0]?.task;
      expect(capturedTask).toBeDefined();
      expect(capturedTask?.id).toContain(SESSION_ID);
    });

    test("task kind is synthesize-narrative", async () => {
      const { provider, calls } = makeFakeProvider({ kind: "success", summary: "Done." });
      const generator = new SummaryGenerator(provider);

      await generator.generateSummary(SESSION_ID, [makeTurn(0)]);

      expect(calls[0]?.task.kind).toBe("synthesize-narrative");
    });
  });

  describe("prompt structure", () => {
    test("system prompt is non-empty and instructs summarization", async () => {
      const { provider, calls } = makeFakeProvider({ kind: "success", summary: "Done." });
      const generator = new SummaryGenerator(provider);

      await generator.generateSummary(SESSION_ID, [makeTurn(0)]);

      const systemPrompt = calls[0]?.task.systemPrompt ?? "";
      expect(systemPrompt.length).toBeGreaterThan(10);
      // System prompt should mention summarization-related concepts.
      const lower = systemPrompt.toLowerCase();
      expect(lower.includes("summar") || lower.includes("session")).toBe(true);
    });

    test("user prompt contains turn content for non-null fields", async () => {
      const { provider, calls } = makeFakeProvider({ kind: "success", summary: "Done." });
      const generator = new SummaryGenerator(provider);

      const turns = [makeTurn(0, { userText: "Hello agent", assistantText: "Hello user" })];
      await generator.generateSummary(SESSION_ID, turns);

      const userPrompt = calls[0]?.task.userPrompt ?? "";
      expect(userPrompt).toContain("Hello agent");
      expect(userPrompt).toContain("Hello user");
    });

    test("user prompt includes tool call names when present", async () => {
      const { provider, calls } = makeFakeProvider({ kind: "success", summary: "Done." });
      const generator = new SummaryGenerator(provider);

      const turns = [makeTurn(0, { toolNames: ["Bash", "Read"] })];
      await generator.generateSummary(SESSION_ID, turns);

      const userPrompt = calls[0]?.task.userPrompt ?? "";
      expect(userPrompt).toContain("Bash");
      expect(userPrompt).toContain("Read");
    });

    test("user prompt handles null userText gracefully (no crash)", async () => {
      const { provider } = makeFakeProvider({ kind: "success", summary: "Done." });
      const generator = new SummaryGenerator(provider);

      const turns = [makeTurn(0, { userText: null, assistantText: "Only assistant" })];
      // Should not throw.
      await expect(generator.generateSummary(SESSION_ID, turns)).resolves.toBe("Done.");
    });

    test("user prompt handles null assistantText gracefully (no crash)", async () => {
      const { provider } = makeFakeProvider({ kind: "success", summary: "Done." });
      const generator = new SummaryGenerator(provider);

      const turns = [makeTurn(0, { userText: "Only user", assistantText: null })];
      await expect(generator.generateSummary(SESSION_ID, turns)).resolves.toBe("Done.");
    });

    test("large transcripts are truncated: only first 50 turns included in prompt", async () => {
      const { provider, calls } = makeFakeProvider({ kind: "success", summary: "Done." });
      const generator = new SummaryGenerator(provider);

      // 70 turns total — only 50 should appear in the prompt.
      const turns = Array.from({ length: 70 }, (_, i) =>
        makeTurn(i, { userText: `unique-user-text-${i}`, assistantText: `assistant-${i}` })
      );
      await generator.generateSummary(SESSION_ID, turns);

      const userPrompt = calls[0]?.task.userPrompt ?? "";
      // Turn 49 (index 48) should be present; turn 51 (index 50) should be absent.
      expect(userPrompt).toContain("unique-user-text-0");
      expect(userPrompt).toContain("unique-user-text-49");
      expect(userPrompt).not.toContain("unique-user-text-50");
      // Truncation notice should appear.
      expect(userPrompt).toContain("omitted");
    });
  });

  describe("error handling", () => {
    test("throws descriptive error when provider returns unavailable", async () => {
      const { provider } = makeFakeProvider({
        kind: "unavailable",
        reason: "No AI provider configured",
      });
      const generator = new SummaryGenerator(provider);

      let caught: unknown;
      try {
        await generator.generateSummary(SESSION_ID, [makeTurn(0)]);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain(SESSION_ID);
      expect((caught as Error).message).toContain("No AI provider configured");
    });

    test("throws descriptive error when provider returns packaged result", async () => {
      const { provider } = makeFakeProvider({ kind: "packaged" });
      const generator = new SummaryGenerator(provider);

      let caught: unknown;
      try {
        await generator.generateSummary(SESSION_ID, [makeTurn(0)]);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain(SESSION_ID);
      expect((caught as Error).message.toLowerCase()).toContain("packaged");
    });

    test("propagates errors thrown by the cognition provider", async () => {
      const underlyingError = new Error("API quota exceeded");
      const { provider } = makeFakeProvider({ kind: "throw", error: underlyingError });
      const generator = new SummaryGenerator(provider);

      let caught: unknown;
      try {
        await generator.generateSummary(SESSION_ID, [makeTurn(0)]);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBe(underlyingError);
    });
  });
});

// ---------------------------------------------------------------------------
// Surrogate-pair safety regression tests (mt#1615)
// ---------------------------------------------------------------------------

function hasUnpairedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function jsonRoundtrips(s: string): boolean {
  try {
    const encoded = JSON.stringify({ s });
    const decoded = JSON.parse(encoded) as { s: string };
    return decoded.s === s;
  } catch {
    return false;
  }
}

// The per-turn truncation limit in summary-generator.ts
const MAX_CHARS_PER_TURN = 1000;

describe("summary-generator buildUserPrompt truncation — surrogate safety (mt#1615)", () => {
  const EMOJIS = ["🔍", "🚀", "🎯", "🤖"];

  test("every cut length 0..MAX_CHARS_PER_TURN on emoji turn text produces valid UTF-16", () => {
    const emojiBlock = EMOJIS.join("").repeat(130); // 1040 code units
    for (let n = 0; n <= MAX_CHARS_PER_TURN; n++) {
      const result = safeTruncate(emojiBlock, n, "head");
      expect(hasUnpairedSurrogate(result)).toBe(false);
      expect(jsonRoundtrips(result)).toBe(true);
    }
  });

  test("boundary cut at exactly 1000 on text ending with emoji is surrogate-safe", () => {
    const prefix = "a".repeat(999);
    const userText = `${prefix}🔍 more text here`;
    // Naive .slice(0, 1000) → 999 ASCII + high surrogate (lone)
    const result = safeTruncate(userText, MAX_CHARS_PER_TURN, "head");
    expect(hasUnpairedSurrogate(result)).toBe(false);
    expect(jsonRoundtrips(result)).toBe(true);
    expect(result).toBe(prefix); // stepped back from high surrogate
  });

  test("all four spec emojis at the 1000-char boundary", () => {
    for (const emoji of EMOJIS) {
      const userText = `${"a".repeat(999) + emoji}trailing`;
      const result = safeTruncate(userText, MAX_CHARS_PER_TURN, "head");
      expect(hasUnpairedSurrogate(result)).toBe(false);
      expect(jsonRoundtrips(result)).toBe(true);
    }
  });

  test("short turn text returned unchanged", () => {
    const short = "What does this function do? 🔍";
    const result = safeTruncate(short, MAX_CHARS_PER_TURN, "head");
    expect(result).toBe(short);
    expect(hasUnpairedSurrogate(result)).toBe(false);
  });
});
