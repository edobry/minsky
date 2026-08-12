/**
 * Supabase service-role provider tests (mt#4028).
 *
 * `checkServiceRoleKey` takes the project URL and the fetch as parameters, so
 * these tests inject both — no `globalThis.fetch` patching, no configuration
 * initialization (testing-standards.mdc §Testable Design).
 */
import { describe, it, expect } from "bun:test";
import {
  checkServiceRoleKey,
  supabaseServiceRoleProvider,
  type FetchLike,
} from "./supabase-service-role";
import { getCredentialProvider, listCredentialProviders, KNOWN_PROVIDER_IDS } from "./index";
import { supabaseProvider } from "./supabase";

const PROJECT_URL = "https://abcdefghijklmnop.supabase.co";
/** Shaped like a real service-role JWT; never a live value. */
const TEST_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-service-role.signature";

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

/** Fetch stub that records what it was called with and returns a canned reply. */
function stubFetch(
  reply: { status: number; statusText?: string; body?: unknown; nonJson?: boolean },
  calls: RecordedCall[] = []
): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    return {
      status: reply.status,
      statusText: reply.statusText ?? "",
      ok: reply.status >= 200 && reply.status < 300,
      json: async () => {
        if (reply.nonJson) throw new Error("not JSON");
        return reply.body;
      },
    };
  };
  return { fetchImpl, calls };
}

describe("checkServiceRoleKey", () => {
  it("reports the missing project URL by name, without calling the network", async () => {
    const { fetchImpl, calls } = stubFetch({ status: 200, body: [] });
    const result = await checkServiceRoleKey(TEST_KEY, null, fetchImpl);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("supabase.url");
    expect(calls).toHaveLength(0);
  });

  it("targets the Storage bucket-list endpoint with both auth headers", async () => {
    const { fetchImpl, calls } = stubFetch({ status: 200, body: [] });
    await checkServiceRoleKey(TEST_KEY, PROJECT_URL, fetchImpl);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${PROJECT_URL}/storage/v1/bucket`);
    expect(calls[0]?.headers["apikey"]).toBe(TEST_KEY);
    expect(calls[0]?.headers["Authorization"]).toBe(`Bearer ${TEST_KEY}`);
  });

  it("trims a trailing slash off the configured project URL", async () => {
    const { fetchImpl, calls } = stubFetch({ status: 200, body: [] });
    await checkServiceRoleKey(TEST_KEY, `${PROJECT_URL}/`, fetchImpl);

    expect(calls[0]?.url).toBe(`${PROJECT_URL}/storage/v1/bucket`);
  });

  it("passes and counts buckets on a successful list", async () => {
    const { fetchImpl } = stubFetch({ status: 200, body: [{ name: "a" }, { name: "b" }] });
    const result = await checkServiceRoleKey(TEST_KEY, PROJECT_URL, fetchImpl);

    expect(result.ok).toBe(true);
    expect(result.detail).toBe("2 buckets visible");
  });

  it("singularizes the bucket count", async () => {
    const { fetchImpl } = stubFetch({ status: 200, body: [{ name: "only" }] });
    const result = await checkServiceRoleKey(TEST_KEY, PROJECT_URL, fetchImpl);

    expect(result.detail).toBe("1 bucket visible");
  });

  it("flags 401 as unauthorized and names the two look-alike credentials", async () => {
    const { fetchImpl } = stubFetch({ status: 401 });
    const result = await checkServiceRoleKey(TEST_KEY, PROJECT_URL, fetchImpl);

    expect(result.ok).toBe(false);
    expect(result.unauthorized).toBe(true);
    // The mis-paste this row exists to disambiguate: anon key, or an sbp_ PAT.
    expect(result.detail).toContain("anon");
    expect(result.detail).toContain("sbp_");
  });

  it("distinguishes 403 (authenticated but not service-role) from 401", async () => {
    const { fetchImpl } = stubFetch({ status: 403 });
    const result = await checkServiceRoleKey(TEST_KEY, PROJECT_URL, fetchImpl);

    expect(result.ok).toBe(false);
    expect(result.unauthorized).toBeUndefined();
    expect(result.detail).toContain("403");
  });

  it("reports other HTTP failures with status and text", async () => {
    const { fetchImpl } = stubFetch({ status: 503, statusText: "Service Unavailable" });
    const result = await checkServiceRoleKey(TEST_KEY, PROJECT_URL, fetchImpl);

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("HTTP 503 Service Unavailable");
  });

  it("reports a non-JSON body rather than throwing", async () => {
    const { fetchImpl } = stubFetch({ status: 200, nonJson: true });
    const result = await checkServiceRoleKey(TEST_KEY, PROJECT_URL, fetchImpl);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("not valid JSON");
  });

  it("rejects an unexpected (non-array) response shape", async () => {
    const { fetchImpl } = stubFetch({ status: 200, body: { buckets: [] } });
    const result = await checkServiceRoleKey(TEST_KEY, PROJECT_URL, fetchImpl);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("unexpected response shape");
  });

  it("reports a network throw instead of propagating it", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await checkServiceRoleKey(TEST_KEY, PROJECT_URL, fetchImpl);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ECONNREFUSED");
  });

  it("never echoes the key into any result detail", async () => {
    const replies = [
      { status: 200, body: [] },
      { status: 401 },
      { status: 403 },
      { status: 503, statusText: "Service Unavailable" },
      { status: 200, nonJson: true },
      { status: 200, body: { wrong: "shape" } },
    ];
    for (const reply of replies) {
      const { fetchImpl } = stubFetch(reply);
      const result = await checkServiceRoleKey(TEST_KEY, PROJECT_URL, fetchImpl);
      expect(result.detail).not.toContain(TEST_KEY);
    }
    const noUrl = await checkServiceRoleKey(TEST_KEY, null, stubFetch({ status: 200 }).fetchImpl);
    expect(noUrl.detail).not.toContain(TEST_KEY);
  });
});

describe("supabaseServiceRoleProvider registration", () => {
  it("is registered under an id distinct from the Management-PAT provider", () => {
    expect(supabaseServiceRoleProvider.id).not.toBe(supabaseProvider.id);
    expect(KNOWN_PROVIDER_IDS).toContain(supabaseServiceRoleProvider.id);
    expect(getCredentialProvider(supabaseServiceRoleProvider.id)).toBe(supabaseServiceRoleProvider);
  });

  it("owns supabase.serviceRoleKey and leaves supabase.accessToken to the PAT provider", () => {
    expect(supabaseServiceRoleProvider.configPath).toBe("supabase.serviceRoleKey");
    expect(supabaseProvider.configPath).toBe("supabase.accessToken");
  });

  it("is always listed — no isAvailable gate (mt#3569: absence reads as non-existence)", () => {
    expect(supabaseServiceRoleProvider.isAvailable).toBeUndefined();
    const listed = listCredentialProviders().map((p) => p.id);
    expect(listed).toContain(supabaseServiceRoleProvider.id);
  });

  it("points at the project API-keys page and warns off the look-alike keys", () => {
    expect(supabaseServiceRoleProvider.acquireUrl).toContain("settings/api-keys");
    expect(supabaseServiceRoleProvider.scopeGuidance).toContain("service_role");
    expect(supabaseServiceRoleProvider.scopeGuidance).toContain("supabase.url");
  });
});
