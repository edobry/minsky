/**
 * Tests for the OpenAI model fetcher (mt#3457).
 *
 * OpenAI's `GET /v1/models` returns only `id` / `object` / `created` / `owned_by` — no token
 * limits, for any model. The fetcher used to fill that gap from a hand-maintained table plus
 * `startsWith` fallbacks, which meant 128 of 132 live models got a plausible-looking wrong
 * number: `gpt-4.1` reported an 8192-token context window against an actual 1,047,576, roughly
 * 128x off, with nothing failing.
 *
 * Limits now come from the community catalog, and a model the catalog does not cover is OMITTED
 * rather than invented — mt#3379's rule ("a fabricated value is worse than an absent model"),
 * applied to a provider that publishes no limits at all.
 */

import { describe, expect, test, afterEach } from "bun:test";

import { OpenAIModelFetcher } from "./openai-fetcher";
import type { ModelLimitsCatalog } from "../model-limits-catalog";
import type { ModelFetchConfig } from "../types";

const CONFIG: ModelFetchConfig = { apiKey: "test-key" };

/** An id no DISPLAY_NAMES entry covers, used to exercise the unlisted-model paths. */
const UNLISTED_ID = "gpt-4-some-future-variant";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub the OpenAI listing endpoint with the given ids, in the API's real shape. */
function stubListing(ids: string[]): void {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        object: "list",
        data: ids.map((id) => ({
          id,
          object: "model",
          created: 1700000000,
          owned_by: "openai",
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as unknown as typeof fetch;
}

/** A catalog covering exactly the ids given, with distinguishable values. */
function catalogWith(entries: Record<string, { ctx: number; out: number }>): ModelLimitsCatalog {
  return new Map(
    Object.entries(entries).map(([id, v]) => [id, { contextWindow: v.ctx, maxOutputTokens: v.out }])
  );
}

function fetcherWithCatalog(catalog: ModelLimitsCatalog | null): OpenAIModelFetcher {
  return new OpenAIModelFetcher({ fetchLimitsCatalog: async () => catalog });
}

describe("OpenAIModelFetcher limits sourcing (mt#3457)", () => {
  test("reports the catalog's real context window, not a startsWith default", async () => {
    stubListing(["gpt-4.1"]);
    const models = await fetcherWithCatalog(
      catalogWith({ "gpt-4.1": { ctx: 1047576, out: 32768 } })
    ).fetchModels(CONFIG);

    expect(models).toHaveLength(1);
    expect(models[0]?.contextWindow).toBe(1047576);
    expect(models[0]?.maxOutputTokens).toBe(32768);
    // The precise regression: the old `startsWith("gpt-4")` branch returned 8192 here.
    expect(models[0]?.contextWindow).not.toBe(8192);
  });

  test("omits a model the catalog does not cover instead of inventing a limit", async () => {
    stubListing(["gpt-4o", UNLISTED_ID]);
    const models = await fetcherWithCatalog(
      catalogWith({ "gpt-4o": { ctx: 128000, out: 16384 } })
    ).fetchModels(CONFIG);

    expect(models.map((m) => m.id)).toEqual(["gpt-4o"]);
    // Under the old generic/startsWith fallbacks this id would have been present with a
    // fabricated window rather than absent.
    expect(models.some((m) => m.id === UNLISTED_ID)).toBe(false);
  });

  test("returns no models at all when the catalog is unavailable", async () => {
    stubListing(["gpt-4o", "gpt-4.1"]);
    const models = await fetcherWithCatalog(null).fetchModels(CONFIG);

    // Degrading to empty is deliberate: with no limits source, every value would be invented.
    expect(models).toEqual([]);
  });

  test("carries catalog pricing through when present", async () => {
    stubListing(["gpt-4.1"]);
    const catalog: ModelLimitsCatalog = new Map([
      [
        "gpt-4.1",
        {
          contextWindow: 1047576,
          maxOutputTokens: 32768,
          costPer1kTokens: { input: 0.002, output: 0.008 },
        },
      ],
    ]);
    const models = await new OpenAIModelFetcher({
      fetchLimitsCatalog: async () => catalog,
    }).fetchModels(CONFIG);

    expect(models[0]?.costPer1kTokens).toEqual({ input: 0.002, output: 0.008 });
  });

  // PR #2752 R1: removing the old table dropped the human-readable name, so the CLI would have
  // shown "gpt-4o" where it previously showed "GPT-4o" — a user-visible regression.
  test("keeps the human-readable display name for well-known ids", async () => {
    stubListing(["gpt-4o"]);
    const models = await fetcherWithCatalog(
      catalogWith({ "gpt-4o": { ctx: 128000, out: 16384 } })
    ).fetchModels(CONFIG);

    expect(models[0]?.name).toBe("GPT-4o");
    expect(models[0]?.description).toContain("GPT-4o");
  });

  test("falls back to the raw id for an unlisted model rather than inventing a label", async () => {
    stubListing([UNLISTED_ID]);
    const models = await fetcherWithCatalog(
      catalogWith({ [UNLISTED_ID]: { ctx: 128000, out: 4096 } })
    ).fetchModels(CONFIG);

    // The retired branch would have called this "GPT-4 (gpt-4-some-future-variant)", labelling a
    // non-GPT-4 model as GPT-4. The bare id is honest.
    expect(models[0]?.name).toBe(UNLISTED_ID);
  });

  test("still applies the supported-model filter before consulting the catalog", async () => {
    stubListing(["gpt-4o", "whisper-1"]);
    const models = await fetcherWithCatalog(
      catalogWith({ "gpt-4o": { ctx: 128000, out: 16384 }, "whisper-1": { ctx: 1, out: 1 } })
    ).fetchModels(CONFIG);

    // `whisper-1` matches no supported pattern, so it never reaches the catalog lookup.
    expect(models.map((m) => m.id)).toEqual(["gpt-4o"]);
  });
});
