/**
 * Telegram provider tests (mt#2419). Mirrors providers.test.ts's global-fetch
 * stub pattern. The Pulumi-backed store/isConfigured paths are exercised at
 * the resolver level only (no real pulumi subprocess in unit tests).
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import { telegramProvider, resolveInfraDir } from "./telegram";
import { join } from "path";

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

describe("telegramProvider.validate (getMe)", () => {
  let stub: { restore: () => void } | null = null;
  afterEach(() => {
    stub?.restore();
    stub = null;
  });

  it("200 ok:true → ok with bot identity", async () => {
    stub = installFetchStub((url) => {
      expect(url).toContain("/getMe");
      return jsonResponse({ ok: true, result: { username: "minsky_alerts_bot" } });
    });
    const result = await telegramProvider.validate("tok");
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("minsky_alerts_bot");
  });

  it("401 → unauthorized", async () => {
    stub = installFetchStub(() => new Response("", { status: 401 }));
    const result = await telegramProvider.validate("bad");
    expect(result.ok).toBe(false);
    expect(result.unauthorized).toBe(true);
  });

  it("network error → ok:false with detail", async () => {
    stub = installFetchStub(() => {
      throw new Error("dns down");
    });
    const result = await telegramProvider.validate("tok");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("dns down");
  });
});

describe("telegramProvider.test (getUpdates summary)", () => {
  let stub: { restore: () => void } | null = null;
  afterEach(() => {
    stub?.restore();
    stub = null;
  });

  it("chats visible → ok with count", async () => {
    stub = installFetchStub((url) => {
      expect(url).toContain("/getUpdates");
      return jsonResponse({
        ok: true,
        result: [
          { message: { chat: { id: 1 } } },
          { message: { chat: { id: 1 } } },
          { message: { chat: { id: 2 } } },
        ],
      });
    });
    const result = await telegramProvider.test("tok");
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("2 chat(s)");
  });

  it("no chats yet → ok with scopeGap hint (message your bot)", async () => {
    stub = installFetchStub(() => jsonResponse({ ok: true, result: [] }));
    const result = await telegramProvider.test("tok");
    expect(result.ok).toBe(true);
    expect(result.scopeGap).toBe(true);
    expect(result.detail).toContain("send your bot one message");
  });

  it("409 (webhook set) → ok with scopeGap warning", async () => {
    stub = installFetchStub(() => new Response("", { status: 409 }));
    const result = await telegramProvider.test("tok");
    expect(result.ok).toBe(true);
    expect(result.scopeGap).toBe(true);
    expect(result.detail).toContain("webhook");
  });
});

describe("telegramProvider.isAvailable (environment gate)", () => {
  it("is gated on Pulumi-project resolvability (boundary: deployment-specific provider)", () => {
    // In this repo's checkout infra/Pulumi.yaml exists → available here;
    // the structural assertion is that the gate is wired at all.
    expect(typeof telegramProvider.isAvailable).toBe("function");
    expect(typeof telegramProvider.isAvailable?.()).toBe("boolean");
  });
});

describe("resolveInfraDir (hermetic — injected exists)", () => {
  it("finds infra/Pulumi.yaml walking up from a nested cwd", () => {
    const root = "/fake/repo";
    const projectFile = join(root, "infra", "Pulumi.yaml");
    const existsFn = (p: string) => p === projectFile;
    expect(resolveInfraDir(join(root, "a", "b"), existsFn)).toBe(join(root, "infra"));
    expect(resolveInfraDir(root, existsFn)).toBe(join(root, "infra"));
  });

  it("returns null when no Pulumi project exists above cwd (bounded walk)", () => {
    expect(resolveInfraDir("/fake/elsewhere/x/y", () => false)).toBeNull();
  });
});
