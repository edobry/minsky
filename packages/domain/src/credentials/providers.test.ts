/**
 * Provider tests (mt#1426).
 *
 * Verifies each provider correctly classifies the four common outcomes:
 *   - 401 (auth failure)
 *   - 403 (scope gap, for github.test only)
 *   - 200 with payload (success)
 *   - network error
 *
 * Uses a global fetch stub. Tests do NOT hit real APIs — the URL matched
 * against is the canonical URL each provider declares.
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import { supabaseProvider } from "./providers/supabase";
import { githubProvider } from "./providers/github";
import { anthropicProvider } from "./providers/anthropic";

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function installFetchStub(handler: FetchHandler): { restore: () => void } {
  const original = globalThis.fetch;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function statusResponse(status: number, statusText = ""): Response {
  return new Response("", { status, statusText });
}

describe("supabaseProvider", () => {
  let stub: { restore: () => void } | null = null;
  afterEach(() => {
    stub?.restore();
    stub = null;
  });

  it("validates a token by listing projects and reports the count", async () => {
    stub = installFetchStub(() => jsonResponse([{ id: "p1" }, { id: "p2" }]));
    const result = await supabaseProvider.validate("sbp_test");
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("2 projects visible");
  });

  it("treats 401 as unauthorized", async () => {
    stub = installFetchStub(() => statusResponse(401, "Unauthorized"));
    const result = await supabaseProvider.validate("sbp_bad");
    expect(result.ok).toBe(false);
    expect(result.unauthorized).toBe(true);
  });

  it("treats 403 as forbidden", async () => {
    stub = installFetchStub(() => statusResponse(403, "Forbidden"));
    const result = await supabaseProvider.validate("sbp_limited");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Management API permissions");
  });

  it("reports network errors", async () => {
    stub = installFetchStub(() => {
      throw new Error("ECONNREFUSED");
    });
    const result = await supabaseProvider.validate("sbp_x");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("network error");
  });
});

describe("githubProvider", () => {
  let stub: { restore: () => void } | null = null;
  afterEach(() => {
    stub?.restore();
    stub = null;
  });

  it("validate confirms identity via /user", async () => {
    stub = installFetchStub(() => jsonResponse({ login: "octocat" }));
    const result = await githubProvider.validate("ghp_x");
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("@octocat");
  });

  it("validate 401 returns unauthorized", async () => {
    stub = installFetchStub(() => statusResponse(401, "Unauthorized"));
    const result = await githubProvider.validate("ghp_bad");
    expect(result.ok).toBe(false);
    expect(result.unauthorized).toBe(true);
  });

  it("test reports scope-gap on 403 from /user/repos", async () => {
    let call = 0;
    stub = installFetchStub((url) => {
      call += 1;
      if (url.includes("/user/repos")) {
        return statusResponse(403, "Forbidden");
      }
      return jsonResponse({ login: "octocat" });
    });
    const result = await githubProvider.test("ghp_scoped");
    expect(call).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.scopeGap).toBe(true);
    expect(result.detail).toContain("repo");
  });

  it("test reports success when both /user and /user/repos succeed", async () => {
    stub = installFetchStub((url) => {
      if (url.includes("/user/repos")) return jsonResponse([{ name: "demo" }]);
      return jsonResponse({ login: "octocat" });
    });
    const result = await githubProvider.test("ghp_full");
    expect(result.ok).toBe(true);
    expect(result.scopeGap).toBeFalsy();
    expect(result.detail).toContain("scope present");
  });
});

describe("anthropicProvider", () => {
  let stub: { restore: () => void } | null = null;
  afterEach(() => {
    stub?.restore();
    stub = null;
  });

  it("validates by listing models", async () => {
    stub = installFetchStub(() =>
      jsonResponse({
        data: [
          { id: "claude-opus-4-7" },
          { id: "claude-sonnet-4-6" },
          { id: "claude-haiku-4-5-20251001" },
        ],
      })
    );
    const result = await anthropicProvider.validate("sk-ant-x");
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("3 models accessible");
  });

  it("treats 401 as unauthorized", async () => {
    stub = installFetchStub(() => statusResponse(401, "Unauthorized"));
    const result = await anthropicProvider.validate("sk-ant-bad");
    expect(result.ok).toBe(false);
    expect(result.unauthorized).toBe(true);
  });

  it("uses x-api-key header (not Bearer)", async () => {
    const captured: { headers: Record<string, string> | null } = { headers: null };
    stub = installFetchStub((_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      captured.headers = headers ?? null;
      return jsonResponse({ data: [] });
    });
    await anthropicProvider.validate("sk-ant-x");
    expect(captured.headers).not.toBeNull();
    const headers = captured.headers ?? {};
    expect(headers["x-api-key"]).toBe("sk-ant-x");
    expect(headers["anthropic-version"]).toBeDefined();
  });
});
