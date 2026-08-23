import { describe, test, expect, afterEach } from "bun:test";
import {
  truncateEmbeddingInput,
  truncateEmbeddingInputs,
  embeddingTokenBudget,
  setEmbeddingTokenizerForTest,
  EMBEDDING_TOKEN_LIMITS,
  EMBEDDING_TOKEN_BUFFER,
} from "./truncate-input";
import { DefaultTokenizerService, type TokenizerService } from "../tokenizer-service";

const MODEL = "text-embedding-3-small";
const BUDGET = embeddingTokenBudget(MODEL);

/**
 * Deterministic stand-in: one token per character, so a token budget is exactly
 * a character budget and every assertion below is exact rather than approximate.
 */
class CharTokenizer implements Partial<TokenizerService> {
  async tokenize(text: string): Promise<number[]> {
    return Array.from(text, (c) => c.codePointAt(0) ?? 0);
  }
  async detokenize(tokenIds: number[]): Promise<string> {
    return tokenIds.map((c) => String.fromCodePoint(c)).join("");
  }
}

/** Every call throws — exercises the char-heuristic fallback path. */
class BrokenTokenizer implements Partial<TokenizerService> {
  async tokenize(): Promise<number[]> {
    throw new Error("Failed to load gpt-tokenizer");
  }
  async detokenize(): Promise<string> {
    throw new Error("Failed to load gpt-tokenizer");
  }
}

function useTokenizer(t: Partial<TokenizerService>): void {
  setEmbeddingTokenizerForTest(t as TokenizerService);
}

afterEach(() => setEmbeddingTokenizerForTest(null));

describe("embedding input truncation (mt#4212)", () => {
  test("budget is the model limit less the boundary-drift buffer", () => {
    expect(BUDGET).toBe((EMBEDDING_TOKEN_LIMITS[MODEL] as number) - EMBEDDING_TOKEN_BUFFER);
  });

  test("text within budget is passed through byte-identical", async () => {
    useTokenizer(new CharTokenizer());
    const text = "a short turn of text";
    expect(await truncateEmbeddingInput(text, MODEL)).toBe(text);
  });

  test("text over budget is truncated to the budget", async () => {
    useTokenizer(new CharTokenizer());
    const text = "x".repeat(BUDGET + 5_000);
    const out = await truncateEmbeddingInput(text, MODEL);
    expect(out.length).toBe(BUDGET);
  });

  test("a batch with one oversize input bounds it without disturbing the rest", async () => {
    useTokenizer(new CharTokenizer());
    // The incident's shape: one over-length turn in a batch of 20 made the
    // provider reject the whole request, losing the other 19 turns.
    const normal = "an ordinary turn";
    const inputs = Array.from({ length: 20 }, (_, i) => (i === 12 ? "y".repeat(50_000) : normal));

    const out = await truncateEmbeddingInputs(inputs, MODEL);

    expect(out).toHaveLength(20);
    expect(out[12]).toHaveLength(BUDGET);
    for (const [i, value] of out.entries()) {
      if (i !== 12) expect(value).toBe(normal);
    }
  });

  test("falls back to a 3-chars-per-token cap when the tokenizer is unavailable", async () => {
    useTokenizer(new BrokenTokenizer());
    const out = await truncateEmbeddingInput("z".repeat(200_000), MODEL);
    // 3, not 4: tokenizer-service.ts records that a 4-chars-per-token cap
    // UNDER-truncates dense markdown, which is how mt#2861 kept overflowing the
    // limit after nominally truncating.
    expect(out.length).toBe(BUDGET * 3);
  });

  test("a tokenizer failure never propagates to the caller", async () => {
    useTokenizer(new BrokenTokenizer());
    // Sending an untruncated input is a guaranteed 400, so degrading is strictly
    // better than throwing here.
    await expect(truncateEmbeddingInput("short", MODEL)).resolves.toBe("short");
  });

  test("the real tokenizer brings an over-length input under the model limit", async () => {
    setEmbeddingTokenizerForTest(null);
    const tokenizer = new DefaultTokenizerService();

    // Dense prose, the ~3-chars/token shape that defeated the old char cap.
    const text = "resilience,tokenizer;embedding-boundary. ".repeat(4_000);
    const before = await tokenizer.tokenize(text, MODEL, "openai");
    expect(before.length).toBeGreaterThan(EMBEDDING_TOKEN_LIMITS[MODEL] as number);

    const out = await truncateEmbeddingInput(text, MODEL, "openai");
    const after = await tokenizer.tokenize(out, MODEL, "openai");

    // Re-encoding the decoded slice can differ at the cut point; the buffer is
    // sized to absorb that, so the check is against the real model limit.
    expect(after.length).toBeLessThanOrEqual(EMBEDDING_TOKEN_LIMITS[MODEL] as number);
  });
});
