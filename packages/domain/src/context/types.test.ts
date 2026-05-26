/**
 * Tests for the canonical harness-agnostic context-analysis shapes
 * (`ContextElement` + `ContextAnalysisResult`) in `./types.ts`.
 *
 * mt#2033 (Path A, 2026-05-21) revived these shapes for the observation path.
 * Synthesis-path migration is filed separately as mt#2040.
 */

import { describe, expect, test } from "bun:test";
import type { ContextAnalysisResult, ContextElement } from "./types";

describe("ContextElement.type — canonical taxonomy (mt#2033)", () => {
  test("accepts synthesis-path element kinds (Cursor-replication era + general)", () => {
    const synthesisKinds: ContextElement["type"][] = [
      "rule",
      "file",
      "conversation",
      "metadata",
      "other",
    ];
    expect(synthesisKinds).toHaveLength(5);
  });

  test("accepts observation-path element kinds (per-harness reality)", () => {
    const observationKinds: ContextElement["type"][] = [
      "hook-injection",
      "skill-body",
      "tool-result",
      "tool-schema",
      "deferred-tool-catalog",
      "mcp-instructions",
      "system-prompt",
      "user-prompt",
      "assistant-text",
      "assistant-thinking",
    ];
    expect(observationKinds).toHaveLength(10);
  });
});

describe("ContextAnalysisResult.source — surface discriminator (mt#2033)", () => {
  test("synthesis path produces source: 'synthesized'", () => {
    const surface: Pick<ContextAnalysisResult, "source"> = { source: "synthesized" };
    expect(surface.source).toBe("synthesized");
  });

  test("observation path produces source: 'observed'", () => {
    const surface: Pick<ContextAnalysisResult, "source"> = { source: "observed" };
    expect(surface.source).toBe("observed");
  });
});

describe("observation-path categorization end-to-end (mt#2033 Path A acceptance)", () => {
  test("an observation snapshot can be expressed using extended kinds + 'observed' source", () => {
    // Models the shape mt#2022's transcript → snapshot conversion will produce.
    const observationElement: ContextElement = {
      type: "hook-injection",
      id: "memory-search-turn-3",
      name: "memory-search hook fire (turn 3)",
      content: "<system-reminder>The following memory records may be relevant…</system-reminder>",
      size: { characters: 142 },
      metadata: { contentType: "system-reminder" },
    };

    expect(observationElement.type).toBe("hook-injection");
    expect(observationElement.size.characters).toBe(142);

    const observationResult: Pick<ContextAnalysisResult, "source" | "summary"> = {
      source: "observed",
      summary: {
        totalTokens: 12345,
        utilizationPercentage: 6.2,
        totalElements: 47,
        totalCharacters: 56789,
        timestamp: new Date(),
        model: "claude-3-7-sonnet",
      },
    };

    expect(observationResult.source).toBe("observed");
    expect(observationResult.summary.totalElements).toBe(47);
  });

  test("synthesis-shaped result still compiles under the extended taxonomy", () => {
    // Backwards-compat: synthesis-path consumers (when they migrate via mt#2040) can
    // still emit pre-existing element kinds + their own 'synthesized' source value.
    const synthesisElement: ContextElement = {
      type: "rule",
      id: "decision-defaults",
      name: "decision-defaults.mdc",
      content: "# Decision Defaults\n…",
      size: { characters: 8000, lines: 240 },
      metadata: { ruleId: "decision-defaults" },
    };

    expect(synthesisElement.type).toBe("rule");
  });
});
