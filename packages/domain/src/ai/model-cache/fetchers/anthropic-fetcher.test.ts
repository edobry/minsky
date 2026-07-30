/**
 * Tests for the Anthropic model fetcher (mt#3337).
 *
 * The load-bearing case is the first describe block: `validateConnection` must
 * probe the LISTING endpoint, not a completion with a hardcoded model id. That
 * hardcoded id (`claude-3-haiku-20240307`) was retired, the probe got a 404, and
 * the whole registry reported "Failed to connect to provider: anthropic" for
 * ~3 weeks while completions worked fine.
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
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;

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
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "claude-opus-5", display_name: "Claude Opus 5" },
              { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" },
            ],
          }),
          { status: 200 }
        )
    );

    const models = await new AnthropicModelFetcher().fetchModels(CONFIG);

    expect(models.map((m) => m.id)).toEqual(["claude-opus-5", "claude-haiku-4-5-20251001"]);
    expect(models.every((m) => m.provider === "anthropic")).toBe(true);
    expect(models.every((m) => m.status === "available")).toBe(true);
  });

  test("filters out non-Claude entries", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ data: [{ id: "claude-opus-5" }, { id: "some-other-model" }] }),
          { status: 200 }
        )
    );

    const models = await new AnthropicModelFetcher().fetchModels(CONFIG);

    expect(models.map((m) => m.id)).toEqual(["claude-opus-5"]);
  });

  test("throws a ModelFetchError carrying the HTTP status on a non-OK response", async () => {
    stubFetch(() => new Response("nope", { status: 500, statusText: "Internal Server Error" }));

    await expect(new AnthropicModelFetcher().fetchModels(CONFIG)).rejects.toThrow(/500/);
  });
});
