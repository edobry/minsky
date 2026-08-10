/**
 * Tests for token counting in the context-generation path (mt#3458).
 *
 * The defect these cover: `generateContext` set every component's `token_count`
 * from `Math.floor(content.length / 4)` and summed those estimates into
 * `metadata.totalTokens`, while the analysis screen re-counted the same text
 * with the real tokenizer. The breakdown therefore divided a measurement by an
 * estimate, and percentages exceeded 100%.
 */

import { describe, expect, test } from "bun:test";
import { registerDefaultComponents } from "@minsky/domain/context/components/index";
import { FALLBACK_CHARS_PER_TOKEN, generateContext, type TokenCounter } from "./generate-core";
import type { GenerateRequest, GenerateResult } from "./generate-types";

/** Narrows the first component, so the assertions below read without `!`. */
function firstComponent(result: GenerateResult): GenerateResult["components"][number] {
  const [component] = result.components;
  if (!component) {
    throw new Error("expected the request to produce at least one component");
  }
  return component;
}

registerDefaultComponents();

const MODEL = "claude-opus-5";

function request(components: string[], targetModel = MODEL): GenerateRequest {
  return {
    components,
    input: {
      environment: { os: "test-os test-arch", shell: "/bin/test" },
      workspacePath: "/tmp/mt3458-fixture",
      task: { id: "mt#3458", title: "fixture", status: "IN-PROGRESS" },
      userQuery: "fixture query",
      targetModel,
      interfaceConfig: { interface: "cli", mcpEnabled: false, preferMcp: false },
    },
  };
}

/**
 * Returns a count deliberately unequal to the character estimate, so a test
 * asserting "the tokenizer was used" cannot pass on the estimate by coincidence.
 */
function countingStub(tokensPerCall?: number): TokenCounter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async countTokens(text: string, model: string) {
      calls.push(model);
      return tokensPerCall ?? text.length;
    },
  };
}

describe("generateContext token counting (mt#3458)", () => {
  test("counts each component with the tokenizer rather than a character estimate", async () => {
    const counter = countingStub();

    const result = await generateContext(request(["environment"]), counter);

    const component = firstComponent(result);
    // The stub returns the character length, so an estimate would be 4x smaller.
    expect(component.token_count).toBe(component.content.length);
    expect(component.token_count).not.toBe(
      Math.floor(component.content.length / FALLBACK_CHARS_PER_TOKEN)
    );
    expect(counter.calls).toContain(MODEL);
  });

  test("totalTokens is the sum of the per-component counts", async () => {
    const result = await generateContext(request(["environment"]), countingStub(7));

    const summed = result.components.reduce((sum, c) => sum + (c.token_count ?? 0), 0);
    expect(result.metadata.totalTokens).toBe(summed);
    expect(result.metadata.totalTokens).toBe(7 * result.components.length);
  });

  test("records which model the counts were produced for", async () => {
    const result = await generateContext(request(["environment"], "gpt-4o"), countingStub(1));

    expect(result.metadata.tokenizedForModel).toBe("gpt-4o");
  });

  test("assembledTokens covers the generation header, which belongs to no component", async () => {
    const counter = countingStub();

    const result = await generateContext(request(["environment"]), counter);

    // The stub counts characters, so the assembled figure is the assembled
    // string's length — strictly greater than the components' own lengths
    // because of the header the assembly prepends.
    expect(result.metadata.assembledTokens).toBe(result.content.length);
    expect(result.metadata.assembledTokens).toBeGreaterThan(result.metadata.totalTokens);
  });

  test("falls back to a character estimate on a tokenizer failure, and names what fell back", async () => {
    const throwing: TokenCounter = {
      async countTokens() {
        throw new Error("no tokenizer for this model");
      },
    };

    const result = await generateContext(request(["environment"]), throwing);

    const component = firstComponent(result);
    expect(component.token_count).toBe(
      Math.floor(component.content.length / FALLBACK_CHARS_PER_TOKEN)
    );
    // A silent substitution is what made the original defect invisible: the
    // estimate has to be distinguishable from a measurement.
    expect(result.metadata.tokenCountFallbacks).toContain("environment");
    expect(result.metadata.tokenCountFallbacks).toContain("<assembled context>");
    // Generation still succeeds — a failed count degrades the figure, not the output.
    expect(result.metadata.errors).toHaveLength(0);
    expect(result.content).toContain("Generated AI Context");
  });

  test("no fallback is recorded on the normal path", async () => {
    const result = await generateContext(request(["environment"]), countingStub(1));

    expect(result.metadata.tokenCountFallbacks).toEqual([]);
  });
});
