/**
 * Tests for the community model-limits catalog (mt#3457).
 *
 * The catalog exists because OpenAI's `GET /v1/models` publishes no token limits for any model,
 * so the fetcher previously invented them: 128 of 132 live models received a plausible-looking
 * wrong number, with `gpt-4.1` reported as 8192 against an actual 1,047,576.
 *
 * The load-bearing property under test is the FAILURE posture: every unhappy path must yield
 * `null` ("catalog unavailable"), never a partially-populated or defaulted value. A caller that
 * receives `null` omits the model; a caller handed a half-filled entry would ship a wrong number,
 * which is the defect this replaces.
 */

import { describe, expect, test } from "bun:test";

import {
  buildCatalogFromPayload,
  fetchModelLimitsCatalog,
  projectCatalogEntry,
} from "./model-limits-catalog";

/** A minimal upstream payload in LiteLLM's actual shape. */
const PAYLOAD = {
  "gpt-4.1": {
    litellm_provider: "openai",
    max_input_tokens: 1047576,
    max_output_tokens: 32768,
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.000008,
  },
  "gpt-4o": {
    litellm_provider: "openai",
    max_input_tokens: 128000,
    max_output_tokens: 16384,
  },
  "claude-sonnet-4": {
    litellm_provider: "anthropic",
    max_input_tokens: 200000,
    max_output_tokens: 64000,
  },
  "broken-entry": {
    litellm_provider: "openai",
    max_input_tokens: 128000,
    // no max_output_tokens
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("projectCatalogEntry", () => {
  test("carries both limits through when the entry has them", () => {
    expect(projectCatalogEntry({ max_input_tokens: 1047576, max_output_tokens: 32768 })).toEqual({
      contextWindow: 1047576,
      maxOutputTokens: 32768,
    });
  });

  test("converts per-token cost to per-1k, which is the unit AIModel declares", () => {
    const limits = projectCatalogEntry({
      max_input_tokens: 1047576,
      max_output_tokens: 32768,
      input_cost_per_token: 0.000002,
      output_cost_per_token: 0.000008,
    });
    // 0.000002/token * 1000 = 0.002/1k. A missing conversion here would understate cost 1000x.
    expect(limits?.costPer1kTokens).toEqual({ input: 0.002, output: 0.008 });
  });

  test("omits cost entirely when only one side is priced, rather than half-filling it", () => {
    const limits = projectCatalogEntry({
      max_input_tokens: 128000,
      max_output_tokens: 4096,
      input_cost_per_token: 0.000002,
    });
    expect(limits).not.toBeNull();
    expect(limits?.costPer1kTokens).toBeUndefined();
  });

  test("returns null when either limit is absent — a partial entry is not usable", () => {
    expect(projectCatalogEntry({ max_input_tokens: 128000 })).toBeNull();
    expect(projectCatalogEntry({ max_output_tokens: 4096 })).toBeNull();
    expect(projectCatalogEntry({})).toBeNull();
  });
});

describe("buildCatalogFromPayload", () => {
  test("keeps only the requested provider's entries", () => {
    const catalog = buildCatalogFromPayload(PAYLOAD, "openai");
    expect(catalog?.has("gpt-4.1")).toBe(true);
    expect(catalog?.has("gpt-4o")).toBe(true);
    // Present in the payload, but belongs to another provider.
    expect(catalog?.has("claude-sonnet-4")).toBe(false);
  });

  test("drops entries missing a limit instead of admitting them half-filled", () => {
    const catalog = buildCatalogFromPayload(PAYLOAD, "openai");
    expect(catalog?.has("broken-entry")).toBe(false);
  });

  test("reads the real values, not defaults", () => {
    const catalog = buildCatalogFromPayload(PAYLOAD, "openai");
    // The regression this whole task exists for: gpt-4.1 must not read 8192.
    expect(catalog?.get("gpt-4.1")?.contextWindow).toBe(1047576);
    expect(catalog?.get("gpt-4.1")?.contextWindow).not.toBe(8192);
  });

  test("returns null when the provider has no usable entries (schema drift)", () => {
    expect(buildCatalogFromPayload(PAYLOAD, "provider-that-is-not-there")).toBeNull();
  });

  test("returns null for a non-object payload rather than throwing", () => {
    expect(buildCatalogFromPayload(null, "openai")).toBeNull();
    expect(buildCatalogFromPayload("not json", "openai")).toBeNull();
    expect(buildCatalogFromPayload(42, "openai")).toBeNull();
  });
});

describe("fetchModelLimitsCatalog", () => {
  test("returns a catalog on a successful fetch", async () => {
    const catalog = await fetchModelLimitsCatalog("openai", {
      fetchImpl: (async () => jsonResponse(PAYLOAD)) as unknown as typeof fetch,
    });
    expect(catalog?.get("gpt-4o")).toEqual({ contextWindow: 128000, maxOutputTokens: 16384 });
  });

  test("returns null on a non-OK status", async () => {
    const catalog = await fetchModelLimitsCatalog("openai", {
      fetchImpl: (async () => jsonResponse({}, 503)) as unknown as typeof fetch,
    });
    expect(catalog).toBeNull();
  });

  test("returns null when the transport throws, rather than propagating", async () => {
    const catalog = await fetchModelLimitsCatalog("openai", {
      fetchImpl: (async () => {
        throw new Error("network unreachable");
      }) as unknown as typeof fetch,
    });
    expect(catalog).toBeNull();
  });

  test("returns null on malformed JSON", async () => {
    const catalog = await fetchModelLimitsCatalog("openai", {
      fetchImpl: (async () =>
        new Response("{not json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    });
    expect(catalog).toBeNull();
  });
});
