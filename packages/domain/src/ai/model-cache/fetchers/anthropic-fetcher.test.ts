/**
 * Tests for the Anthropic model fetcher.
 *
 * Two load-bearing cases, one per bug this file has carried:
 *
 * 1. `validateConnection` must probe the LISTING endpoint, not a completion with
 *    a hardcoded model id. That hardcoded id (`claude-3-haiku-20240307`) was
 *    retired, the probe got a 404, and the whole registry reported "Failed to
 *    connect to provider: anthropic" for ~3 weeks while completions worked
 *    fine (mt#3337).
 *
 * 2. `fetchModels` must take token limits from the response. They used to come
 *    from a hand-maintained catalog whose six entries were all retired models,
 *    so every current model fell through to a hardcoded 200000/8192 — a 5x
 *    understatement of context and ~15x of output on the 1M-context models
 *    (mt#3379).
 */

import { describe, expect, test, afterEach } from "bun:test";

import { AnthropicModelFetcher } from "./anthropic-fetcher";
import type { ModelFetchConfig } from "../types";

const CONFIG: ModelFetchConfig = { apiKey: "test-key" };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Record every request the fetcher makes so we can assert on the shape. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response): {
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  return { calls };
}

/** Read the first recorded call, failing the test if nothing was requested. */
function firstCall(calls: Array<{ url: string; init?: RequestInit }>): {
  url: string;
  init?: RequestInit;
} {
  const call = calls[0];
  if (call === undefined) throw new Error("expected at least one fetch call, got none");
  return call;
}

/** Stub the listing endpoint with the given model entries. */
function stubListing(models: Array<Record<string, unknown>>): void {
  stubFetch(() => new Response(JSON.stringify({ data: models }), { status: 200 }));
}

/**
 * A listing entry shaped like the live API's, with the fields under test
 * overridable. Values mirror `claude-opus-5` as returned on 2026-07-30.
 */
function listingEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "model",
    id: "claude-opus-5",
    display_name: "Claude Opus 5",
    created_at: "2026-07-24T00:00:00Z",
    max_input_tokens: 1000000,
    max_tokens: 128000,
    capabilities: {
      image_input: { supported: true },
      structured_outputs: { supported: true },
      thinking: { supported: true, types: { adaptive: { supported: true } } },
    },
    ...overrides,
  };
}

/** Fetch a single-entry listing and return the one cached model, or fail. */
async function fetchOne(entry: Record<string, unknown>) {
  stubListing([entry]);
  const models = await new AnthropicModelFetcher().fetchModels(CONFIG);
  const model = models[0];
  if (model === undefined) throw new Error("expected one cached model, got none");
  return model;
}

describe("AnthropicModelFetcher.validateConnection", () => {
  test("probes the models listing endpoint, not a completion", async () => {
    const { calls } = stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const ok = await new AnthropicModelFetcher().validateConnection(CONFIG);

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(firstCall(calls).url).toBe("https://api.anthropic.com/v1/models");
    expect(firstCall(calls).init?.method).toBe("GET");
  });

  test("sends no request body and names no model id", async () => {
    // The regression guard: a probe that carries a model id can be invalidated
    // by that model's retirement, which is exactly how this broke.
    const { calls } = stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await new AnthropicModelFetcher().validateConnection(CONFIG);

    const init = firstCall(calls).init;
    expect(init?.body).toBeUndefined();
    expect(JSON.stringify(init ?? {})).not.toContain("claude-3-haiku-20240307");
  });

  test("a 404 from a retired model id can no longer fail the probe", async () => {
    // Reproduces the exact upstream response the old probe received. The new
    // probe never asks about a model, so a model-not-found cannot occur — the
    // listing call succeeds and validation passes.
    const { calls } = stubFetch((url) => {
      if (url.endsWith("/messages")) {
        return new Response(JSON.stringify({ type: "error", error: { type: "not_found_error" } }), {
          status: 404,
        });
      }
      return new Response(JSON.stringify({ data: [{ id: "claude-opus-5" }] }), { status: 200 });
    });

    const ok = await new AnthropicModelFetcher().validateConnection(CONFIG);

    expect(ok).toBe(true);
    expect(calls.every((c) => !c.url.endsWith("/messages"))).toBe(true);
  });

  test("returns false when the listing endpoint rejects the credentials", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));

    expect(await new AnthropicModelFetcher().validateConnection(CONFIG)).toBe(false);
  });

  test("returns false on a network error rather than throwing", async () => {
    // `as unknown as` because bun-types' global `fetch` carries `preconnect`,
    // which a plain stub cannot supply — and this assigns to the GLOBAL, so the
    // full shape is genuinely required here (unlike an injectable parameter).
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;

    expect(await new AnthropicModelFetcher().validateConnection(CONFIG)).toBe(false);
  });

  test("honors a custom baseURL", async () => {
    const { calls } = stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await new AnthropicModelFetcher().validateConnection({
      apiKey: "test-key",
      baseURL: "https://proxy.internal/v1",
    });

    expect(firstCall(calls).url).toBe("https://proxy.internal/v1/models");
  });
});

describe("AnthropicModelFetcher.fetchModels", () => {
  test("maps the listing response into cached models", async () => {
    stubListing([
      listingEntry(),
      listingEntry({
        id: "claude-haiku-4-5-20251001",
        display_name: "Claude Haiku 4.5",
        max_input_tokens: 200000,
        max_tokens: 64000,
      }),
    ]);

    const models = await new AnthropicModelFetcher().fetchModels(CONFIG);

    expect(models.map((m) => m.id)).toEqual(["claude-opus-5", "claude-haiku-4-5-20251001"]);
    expect(models.every((m) => m.provider === "anthropic")).toBe(true);
    expect(models.every((m) => m.status === "available")).toBe(true);
  });

  test("filters out non-Claude entries", async () => {
    stubListing([listingEntry(), listingEntry({ id: "some-other-model" })]);

    const models = await new AnthropicModelFetcher().fetchModels(CONFIG);

    expect(models.map((m) => m.id)).toEqual(["claude-opus-5"]);
  });

  test("throws a ModelFetchError carrying the HTTP status on a non-OK response", async () => {
    stubFetch(() => new Response("nope", { status: 500, statusText: "Internal Server Error" }));

    await expect(new AnthropicModelFetcher().fetchModels(CONFIG)).rejects.toThrow(/500/);
  });
});

describe("AnthropicModelFetcher token limits", () => {
  test("carries max_input_tokens and max_tokens through unmodified", async () => {
    const model = await fetchOne(listingEntry({ max_input_tokens: 1000000, max_tokens: 128000 }));

    expect(model.contextWindow).toBe(1000000);
    expect(model.maxOutputTokens).toBe(128000);
  });

  test("does not substitute the retired catalog's 200000/8192 for a current model", async () => {
    // The mt#3379 regression in one assertion: `claude-opus-5` matched no entry
    // in the old static catalog, so it fell through to a hardcoded default that
    // understated its context by 5x and its output cap by ~15x.
    const model = await fetchOne(listingEntry());

    expect(model.contextWindow).not.toBe(200000);
    expect(model.maxOutputTokens).not.toBe(8192);
  });

  test("an id absent from every static table still gets the API's real limits", async () => {
    const model = await fetchOne(
      listingEntry({
        id: "claude-not-a-model-we-know-of",
        display_name: "Claude Unknown",
        max_input_tokens: 4242,
        max_tokens: 424,
      })
    );

    expect(model.id).toBe("claude-not-a-model-we-know-of");
    expect(model.contextWindow).toBe(4242);
    expect(model.maxOutputTokens).toBe(424);
  });

  test("excludes a model whose entry carries no limits rather than inventing them", async () => {
    // Never observed live (all 11 listed models carry both fields), but the
    // point of the fix is that an unknown limit stays unknown: a fabricated
    // number would be indistinguishable from a real one downstream.
    const noLimits = listingEntry({ id: "claude-limitless" });
    delete noLimits.max_input_tokens;
    delete noLimits.max_tokens;
    stubListing([listingEntry(), noLimits]);

    const models = await new AnthropicModelFetcher().fetchModels(CONFIG);

    expect(models.map((m) => m.id)).toEqual(["claude-opus-5"]);
  });

  test("excludes a model missing only the output cap", async () => {
    const partial = listingEntry({ id: "claude-half-known" });
    delete partial.max_tokens;
    stubListing([partial]);

    expect(await new AnthropicModelFetcher().fetchModels(CONFIG)).toEqual([]);
  });
});

describe("AnthropicModelFetcher capabilities", () => {
  test("keeps the API's capability tree verbatim in providerMetadata", async () => {
    // The API tree overlaps AICapability's closed union on two keys, so it is
    // preserved rather than lossily projected.
    const model = await fetchOne(listingEntry());

    expect(model.providerMetadata?.api_capabilities).toEqual(listingEntry().capabilities);
  });

  test("reports the real context window as the reasoning capability's maxTokens", async () => {
    const model = await fetchOne(listingEntry({ max_input_tokens: 1000000 }));

    const reasoning = model.capabilities.find((c) => c.name === "reasoning");
    expect(reasoning?.maxTokens).toBe(1000000);
  });

  test("reads image-input and structured-output support from the API tree", async () => {
    const model = await fetchOne(
      listingEntry({
        capabilities: {
          image_input: { supported: false },
          structured_outputs: { supported: false },
        },
      })
    );

    expect(model.capabilities.find((c) => c.name === "image-input")?.supported).toBe(false);
    expect(model.capabilities.find((c) => c.name === "structured-output")?.supported).toBe(false);
  });

  test("keeps tool-calling and prompt-caching supported though the API reports neither", async () => {
    // Guards the projection: these two names have no key in the API tree, so a
    // naive "source capabilities from the response" would silently drop them.
    const model = await fetchOne(listingEntry({ capabilities: {} }));

    expect(model.capabilities.find((c) => c.name === "tool-calling")?.supported).toBe(true);
    expect(model.capabilities.find((c) => c.name === "prompt-caching")?.supported).toBe(true);
  });

  test("getModelCapabilities reports no maxTokens, since an id cannot imply one", async () => {
    const capabilities = await new AnthropicModelFetcher().getModelCapabilities("claude-opus-5");

    const reasoning = capabilities.find((c) => c.name === "reasoning");
    expect(reasoning?.supported).toBe(true);
    expect(reasoning?.maxTokens).toBeUndefined();
    expect(capabilities.find((c) => c.name === "tool-calling")?.supported).toBe(true);
  });

  test("getModelCapabilities marks the claude-2 family as pre-tool-use", async () => {
    const capabilities = await new AnthropicModelFetcher().getModelCapabilities("claude-2.1");

    expect(capabilities.find((c) => c.name === "tool-calling")?.supported).toBe(false);
    expect(capabilities.find((c) => c.name === "image-input")?.supported).toBe(false);
  });
});

describe("AnthropicModelFetcher cost", () => {
  test("leaves costPer1kTokens unset, because the listing carries no pricing", async () => {
    // Verified against the live API: no cost, price, or rate field appears on
    // any model. The catalog that used to supply this held only retired models,
    // so no fetched model had ever matched one — this is explicit now.
    const model = await fetchOne(listingEntry());

    expect(model.costPer1kTokens).toBeUndefined();
  });
});
