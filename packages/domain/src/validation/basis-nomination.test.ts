import { describe, expect, test } from "bun:test";

import { analyzeNegativeConstraints } from "./negative-constraint";
import { BASIS_EXEMPLARS, refineBasisWithNomination } from "./basis-nomination";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { NominationDeps } from "../detectors/embedding-nomination";

/**
 * The 2026-08-08 fire, verbatim from `.minsky/bare-prohibition-calibration.jsonl`
 * plus the recovered prompt text in mt#3861's `## The measured fire`. Sampled
 * rather than paraphrased: a detector fixture is an input drawn from a matcher's
 * domain, and paraphrasing silently moves it out (mem#1020).
 */
const MT3861_FIRE_PROMPT = [
  "NEGATIVE RESULT: no public API surface for a third party to attach an alternate UI to an",
  "Anthropic Remote Control session. Riding it is currently BLOCKED, not merely deprioritized.",
].join("\n");

/** A prohibition with no basis anywhere near it — mt#3861's stated negative control. */
const GENUINELY_BARE_PROMPT = "The approach is blocked. Do not attempt it.";

/**
 * Deterministic stand-in for the embedding provider.
 *
 * Returns `[1,0]` for every exemplar and for any segment `matches` accepts, and
 * `[0,1]` otherwise — so cosine is exactly 1.0 for an intended match and 0 for
 * everything else, on either side of any threshold. It returns
 * `segments.length + exemplars.length` vectors because `nominate` degrades with
 * `provider-shape-mismatch` on any other count; a double looser than production
 * would pass tests production fails (mem#898).
 */
function fakeDeps(matches: (segment: string) => boolean): NominationDeps {
  const embeddingService: EmbeddingService = {
    generateEmbedding: async () => [1, 0],
    generateEmbeddings: async (contents: string[]) =>
      contents.map((c) => (BASIS_EXEMPLARS.includes(c) || matches(c) ? [1, 0] : [0, 1])),
  };
  return { embeddingService, semantic: true };
}

/** Deps whose provider throws — the `provider-error` degrade path. */
function throwingDeps(): NominationDeps {
  return {
    embeddingService: {
      generateEmbedding: async () => {
        throw new Error("provider down");
      },
      generateEmbeddings: async () => {
        throw new Error("provider down");
      },
    },
    semantic: true,
  };
}

describe("fixture liveness — the positive direction, asserted before any suppression claim", () => {
  test("the 2026-08-08 prompt actually reaches the matcher and reads as BARE under Rung 1", () => {
    const report = analyzeNegativeConstraints(MT3861_FIRE_PROMPT);

    // Without this, every suppression assertion below would pass vacuously on a
    // fixture that matched nothing — and would survive its own negative control,
    // because "nothing matched" is stable whether or not the code under test runs.
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.bare.length).toBe(1);
    expect(report.bare[0]?.phrase).toBe("is currently BLOCKED");
  });

  test("the negative-control prompt also reaches the matcher and reads as BARE", () => {
    const report = analyzeNegativeConstraints(GENUINELY_BARE_PROMPT);

    expect(report.bare.length).toBeGreaterThan(0);
  });
});

describe("AT1 — a marker-free basis is recognized and the finding stops being bare", () => {
  test("the 2026-08-08 fire flips to basis-bearing", async () => {
    const rung1 = analyzeNegativeConstraints(MT3861_FIRE_PROMPT);
    const result = await refineBasisWithNomination(
      rung1,
      MT3861_FIRE_PROMPT,
      fakeDeps((s) => s.includes("NEGATIVE RESULT"))
    );

    expect(result.degraded).toBe(false);
    expect(result.refinedCount).toBe(1);
    expect(result.report.bare).toEqual([]);
    expect(result.report.findings[0]?.hasBasis).toBe(true);
  });
});

describe("AT3 — the negative control still fires", () => {
  test("a genuinely basis-less prohibition is NOT refined away", async () => {
    const rung1 = analyzeNegativeConstraints(GENUINELY_BARE_PROMPT);
    const result = await refineBasisWithNomination(
      rung1,
      GENUINELY_BARE_PROMPT,
      // Nothing in this prompt resembles a basis, so the provider nominates nothing.
      fakeDeps(() => false)
    );

    expect(result.refinedCount).toBe(0);
    expect(result.report.bare.length).toBe(rung1.bare.length);
    expect(result.report.bare.length).toBeGreaterThan(0);
  });
});

describe("AT5 — every failure path falls back to the Rung-1 verdict, which fires MORE", () => {
  test("an unconfigured provider leaves the report untouched and still bare", async () => {
    const rung1 = analyzeNegativeConstraints(MT3861_FIRE_PROMPT);
    const result = await refineBasisWithNomination(rung1, MT3861_FIRE_PROMPT, null);

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe("provider-unconfigured");
    // The direction that matters: degrading must not SUPPRESS. ADR-024's
    // fail-to-Rung-1 invariant accepts lower precision, never a missed trigger.
    expect(result.report.bare.length).toBe(1);
    expect(result.report).toBe(rung1);
  });

  test("a throwing provider leaves the report untouched and still bare", async () => {
    const rung1 = analyzeNegativeConstraints(MT3861_FIRE_PROMPT);
    const result = await refineBasisWithNomination(rung1, MT3861_FIRE_PROMPT, throwingDeps());

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe("provider-error");
    expect(result.report.bare.length).toBe(1);
  });

  test("a non-semantic provider degrades rather than scoring hash vectors", async () => {
    const rung1 = analyzeNegativeConstraints(MT3861_FIRE_PROMPT);
    const result = await refineBasisWithNomination(rung1, MT3861_FIRE_PROMPT, {
      embeddingService: fakeDeps(() => true).embeddingService,
      semantic: false,
    });

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe("non-semantic-provider");
    expect(result.report.bare.length).toBe(1);
  });
});

describe("PR #3033 R1 — a mid-sweep degradation discards partial positives", () => {
  test("a positive found before the provider dies is NOT applied", async () => {
    // Two bare prohibitions; the provider answers the first window and throws on
    // the second. Applying the first would suppress one fire on incomplete
    // evidence AND make the verdict depend on where the failure landed.
    const text = [
      "The endpoint returns 403 for every caller we tried.",
      "Do not attempt it.",
      "",
      "Some unrelated prose sits here to push the second match out of the first window.",
      "x".repeat(600),
      "",
      "Do not pursue the polling approach.",
    ].join("\n");

    const rung1 = analyzeNegativeConstraints(text);
    // Liveness first: this fixture must actually produce two bare findings, or
    // the assertion below passes vacuously (mem#1020).
    expect(rung1.bare.length).toBe(2);

    let call = 0;
    const deps = {
      semantic: true,
      embeddingService: {
        generateEmbedding: async () => [1, 0],
        generateEmbeddings: async (contents: string[]) => {
          call += 1;
          if (call > 1) throw new Error("provider died mid-sweep");
          return contents.map(() => [1, 0]);
        },
      },
    };

    const result = await refineBasisWithNomination(rung1, text, deps);

    expect(result.degraded).toBe(true);
    expect(result.refinedCount).toBe(0);
    // Both still bare — including the one the provider DID answer positively.
    expect(result.report.bare.length).toBe(2);
    expect(result.report).toBe(rung1);
  });
});

describe("the stage does no work when Rung 1 left nothing bare", () => {
  test("a report with no bare findings returns unchanged and NOT degraded", async () => {
    // A basis-bearing prohibition: the causal connective is a Rung-1 marker.
    const text = "Do not attempt it because the endpoint returns 403 for every caller.";
    const rung1 = analyzeNegativeConstraints(text);
    expect(rung1.findings.length).toBeGreaterThan(0);
    expect(rung1.bare).toEqual([]);

    const result = await refineBasisWithNomination(rung1, text, throwingDeps());

    // Not degraded: the provider was never called, because there was nothing to
    // re-examine. Rung 1 recognizing a basis is never revisited — this stage can
    // only ADD basis recognition, never remove it.
    expect(result.degraded).toBe(false);
    expect(result.refinedCount).toBe(0);
    expect(result.report).toBe(rung1);
  });
});
