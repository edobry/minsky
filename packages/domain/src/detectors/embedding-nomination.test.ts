import { describe, expect, test } from "bun:test";
import type { EmbeddingService } from "../ai/embeddings/types";
import {
  cosineSimilarity,
  nominate,
  splitCandidateSegments,
  isSemanticProvider,
  MAX_SEGMENT_CHARS,
  type ExemplarSet,
  type NominationDeps,
} from "./embedding-nomination";

/**
 * Fake provider returning caller-controlled vectors keyed by exact input text.
 * Unlisted inputs get an orthogonal vector, so anything not deliberately made
 * similar scores 0.
 */
function fakeService(vectors: Record<string, number[]>): EmbeddingService {
  return {
    async generateEmbedding(content: string): Promise<number[]> {
      return vectors[content] ?? [0, 1];
    },
    async generateEmbeddings(contents: string[]): Promise<number[][]> {
      return contents.map((c) => vectors[c] ?? [0, 1]);
    },
  };
}

function deps(service: EmbeddingService, semantic = true): NominationDeps {
  return { embeddingService: service, semantic };
}

const ADMISSION = "I sequenced those steps in the wrong order and only noticed afterwards.";
const EXEMPLAR = "I did the steps out of order.";

const SETS: ExemplarSet[] = [{ family: "R3", exemplars: [EXEMPLAR] }];

describe("cosineSimilarity", () => {
  test("identical vectors score 1", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 10);
  });

  test("orthogonal vectors score 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  test("magnitude does not affect direction-only similarity", () => {
    expect(cosineSimilarity([2, 0], [7, 0])).toBeCloseTo(1, 10);
  });

  test("mismatched lengths and zero vectors score 0 rather than throwing", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("splitCandidateSegments", () => {
  test("splits on sentence boundaries and newlines", () => {
    const segments = splitCandidateSegments(
      "The first sentence here. The second sentence here.\nA third line entirely."
    );
    expect(segments).toEqual([
      "The first sentence here.",
      "The second sentence here.",
      "A third line entirely.",
    ]);
  });

  test("drops fragments too short to carry an admission", () => {
    expect(splitCandidateSegments("Yes. Done. Ok.")).toEqual([]);
  });

  test("caps the segment count", () => {
    const text = Array.from({ length: 50 }, (_, i) => `Sentence number ${i} goes here.`).join(" ");
    expect(splitCandidateSegments(text, 5)).toHaveLength(5);
  });

  test("truncates an over-long segment to the provider-friendly ceiling", () => {
    const long = `${"a".repeat(MAX_SEGMENT_CHARS + 200)}.`;
    const [segment] = splitCandidateSegments(long);
    expect(segment).toHaveLength(MAX_SEGMENT_CHARS);
  });
});

describe("nominate — scoring", () => {
  test("nominates a family whose exemplar is close to a segment", async () => {
    const result = await nominate(
      ADMISSION,
      SETS,
      deps(fakeService({ [ADMISSION]: [1, 0], [EXEMPLAR]: [1, 0] }))
    );

    expect(result.degraded).toBe(false);
    expect(result.nominations).toHaveLength(1);
    expect(result.nominations[0]?.family).toBe("R3");
    expect(result.nominations[0]?.segment).toBe(ADMISSION);
    expect(result.nominations[0]?.matchedExemplar).toBe(EXEMPLAR);
    expect(result.nominations[0]?.score).toBeCloseTo(1, 6);
  });

  test("does not nominate when similarity is below threshold", async () => {
    const result = await nominate(
      ADMISSION,
      SETS,
      deps(fakeService({ [ADMISSION]: [0, 1], [EXEMPLAR]: [1, 0] }))
    );

    expect(result.degraded).toBe(false);
    expect(result.nominations).toEqual([]);
  });

  test("returns a non-degraded empty result when there is nothing to score", async () => {
    const result = await nominate("Ok.", SETS, deps(fakeService({})));
    expect(result).toEqual({ nominations: [], degraded: false });
  });
});

describe("nominate — fail-to-Rung-1 degradation (ADR-024 invariant)", () => {
  // AT5c: the `local` provider is a deterministic hash stub, not an embedding
  // model. Scoring against it would fire at random while reporting healthy.
  test("a non-semantic provider degrades instead of nominating", async () => {
    let called = false;
    const service: EmbeddingService = {
      async generateEmbedding(): Promise<number[]> {
        called = true;
        return [1, 0];
      },
      async generateEmbeddings(): Promise<number[][]> {
        called = true;
        return [[1, 0]];
      },
    };

    const result = await nominate(ADMISSION, SETS, deps(service, false));

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe("non-semantic-provider");
    expect(result.nominations).toEqual([]);
    expect(called).toBe(false);
  });

  // AT5b: the stall case. An erroring provider and a provider that never
  // answers are different failures; only this one can wedge the turn, and it is
  // the one the original acceptance test did not cover.
  test("a stalled provider degrades within budget rather than hanging", async () => {
    const service: EmbeddingService = {
      generateEmbedding: () => new Promise<number[]>(() => {}),
      generateEmbeddings: () => new Promise<number[][]>(() => {}),
    };

    const started = performance.now();
    const result = await nominate(ADMISSION, SETS, deps(service), { timeoutMs: 50 });
    const elapsed = performance.now() - started;

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe("timeout");
    expect(result.nominations).toEqual([]);
    // The bound is the point: a stalled provider must not outlive the budget.
    expect(elapsed).toBeLessThan(2000);
  });

  test("an erroring provider degrades with the provider-error reason", async () => {
    const service: EmbeddingService = {
      generateEmbedding: () => Promise.reject(new Error("provider exploded")),
      generateEmbeddings: () => Promise.reject(new Error("provider exploded")),
    };

    const result = await nominate(ADMISSION, SETS, deps(service));

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe("provider-error");
    expect(result.nominations).toEqual([]);
  });

  test("a provider returning the wrong batch shape degrades rather than mis-scoring", async () => {
    const service: EmbeddingService = {
      async generateEmbedding(): Promise<number[]> {
        return [1, 0];
      },
      // One vector back for a two-input batch.
      async generateEmbeddings(): Promise<number[][]> {
        return [[1, 0]];
      },
    };

    const result = await nominate(ADMISSION, SETS, deps(service));

    expect(result.degraded).toBe(true);
    // Distinct from `provider-error`: this provider SUCCEEDED, it just returned
    // something unusable. Collapsing the two would hide a model/config mismatch
    // behind the same counter as a network failure.
    expect(result.degradedReason).toBe("provider-shape-mismatch");
    expect(result.nominations).toEqual([]);
  });

  test("a shape mismatch carries the observed vs expected sizes for diagnosis", async () => {
    const service: EmbeddingService = {
      async generateEmbedding(): Promise<number[]> {
        return [1, 0];
      },
      async generateEmbeddings(): Promise<number[][]> {
        return [[1, 0]];
      },
    };

    const result = await nominate(ADMISSION, SETS, deps(service));

    // 1 segment + 1 exemplar requested, 1 vector returned.
    expect(result.degradedDetail).toBe("expected 2 vectors, received 1");
  });

  test("a rejection arriving after the timeout does not escape as an unhandled rejection", async () => {
    const service: EmbeddingService = {
      generateEmbedding: () =>
        new Promise<number[]>((_, reject) => setTimeout(() => reject(new Error("late")), 60)),
      generateEmbeddings: () =>
        new Promise<number[][]>((_, reject) => setTimeout(() => reject(new Error("late")), 60)),
    };

    const result = await nominate(ADMISSION, SETS, deps(service), { timeoutMs: 10 });
    expect(result.degradedReason).toBe("timeout");

    // Outlive the provider's late rejection; the guarded handler must absorb it.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(result.nominations).toEqual([]);
  });
});

describe("isSemanticProvider", () => {
  test("recognizes the real embedding providers", () => {
    expect(isSemanticProvider("openai")).toBe(true);
    expect(isSemanticProvider("gemini")).toBe(true);
  });

  test("rejects the hash-based local stub and unknown providers", () => {
    expect(isSemanticProvider("local")).toBe(false);
    expect(isSemanticProvider(undefined)).toBe(false);
    expect(isSemanticProvider("madeup")).toBe(false);
  });
});
