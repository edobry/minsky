import { describe, expect, test, beforeEach } from "bun:test";

import {
  RAILWAY_OAUTH_TOKEN_URL,
  RAILWAY_OAUTH_DEFAULT_CLIENT_ID,
  RailwayAuthError,
  RailwayApiError,
  type RailwayConfigShape,
  type RailwayConfigStore,
  refreshRailwayToken,
  getValidRailwayToken,
  railwayGraphQLAuthed,
  fetchServiceMetrics,
  SERVICE_METRIC_MEASUREMENTS,
  _resetInflightRefreshForTesting,
} from "./graphql-client";

// ---------------------------------------------------------------------------
// Shared constants (extracted per `custom/no-magic-string-duplication`)
// ---------------------------------------------------------------------------

const FRESH_TOKEN = "single-flight-fresh";
const RT_PLACEHOLDER = "rt";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStore(
  initial: RailwayConfigShape
): RailwayConfigStore & { current: RailwayConfigShape; writeCount: number } {
  let current = structuredClone(initial);
  let writeCount = 0;
  return {
    read: () => structuredClone(current),
    write: (cfg) => {
      writeCount++;
      current = structuredClone(cfg);
    },
    get current() {
      return current;
    },
    get writeCount() {
      return writeCount;
    },
  };
}

type FetchCall = { url: string; init?: RequestInit };

function makeFetchMock(handler: (call: FetchCall) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: FetchCall = { url, init };
    calls.push(call);
    return handler(call);
  };
  // `typeof fetch` carries a `preconnect` static; tests don't exercise it.
  const fetchImpl = fn as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Unwrap calls[index] with a descriptive failure when missing — avoids `!`. */
function requireCall(calls: FetchCall[], index = 0): FetchCall {
  const call = calls[index];
  if (!call) {
    throw new Error(`Expected fetch call at index ${index}, got ${calls.length}`);
  }
  return call;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  _resetInflightRefreshForTesting();
});

// ---------------------------------------------------------------------------
// refreshRailwayToken — low-level OAuth POST
// ---------------------------------------------------------------------------

describe("refreshRailwayToken()", () => {
  test("POSTs grant_type=refresh_token to the OAuth endpoint with default client_id", async () => {
    const { fetchImpl, calls } = makeFetchMock(() =>
      jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })
    );

    const response = await refreshRailwayToken("old-refresh", { fetchImpl });

    expect(calls).toHaveLength(1);
    const call = requireCall(calls);
    expect(call.url).toBe(RAILWAY_OAUTH_TOKEN_URL);
    expect(call.init?.method).toBe("POST");
    expect(call.init?.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const body = String(call.init?.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=old-refresh");
    expect(body).toContain(`client_id=${RAILWAY_OAUTH_DEFAULT_CLIENT_ID}`);
    expect(response.access_token).toBe("new-access");
    expect(response.refresh_token).toBe("new-refresh");
    expect(response.expires_in).toBe(3600);
  });

  test("honors an explicit clientId override", async () => {
    const { fetchImpl, calls } = makeFetchMock(() =>
      jsonResponse({ access_token: "a", expires_in: 60 })
    );
    await refreshRailwayToken(RT_PLACEHOLDER, { fetchImpl, clientId: "custom-client" });
    expect(String(requireCall(calls).init?.body)).toContain("client_id=custom-client");
  });

  test("throws RailwayAuthError on 4xx (refresh token rejected)", async () => {
    const { fetchImpl } = makeFetchMock(() => new Response("invalid_grant", { status: 400 }));
    await expect(refreshRailwayToken(RT_PLACEHOLDER, { fetchImpl })).rejects.toBeInstanceOf(
      RailwayAuthError
    );
  });

  test("throws RailwayApiError on 5xx", async () => {
    const { fetchImpl } = makeFetchMock(() => new Response("server error", { status: 503 }));
    await expect(refreshRailwayToken(RT_PLACEHOLDER, { fetchImpl })).rejects.toBeInstanceOf(
      RailwayApiError
    );
  });

  test("throws RailwayApiError on network failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(refreshRailwayToken(RT_PLACEHOLDER, { fetchImpl })).rejects.toBeInstanceOf(
      RailwayApiError
    );
  });

  test("throws RailwayApiError on non-JSON response body", async () => {
    const { fetchImpl } = makeFetchMock(() => new Response("<html>oops</html>", { status: 200 }));
    await expect(refreshRailwayToken(RT_PLACEHOLDER, { fetchImpl })).rejects.toBeInstanceOf(
      RailwayApiError
    );
  });

  test("throws RailwayApiError when response is missing required fields", async () => {
    const { fetchImpl } = makeFetchMock(() => jsonResponse({ access_token: "a" })); // no expires_in
    await expect(refreshRailwayToken(RT_PLACEHOLDER, { fetchImpl })).rejects.toThrow(
      /missing expected fields/
    );
  });
});

// ---------------------------------------------------------------------------
// getValidRailwayToken — refresh-aware token reader (the headline feature)
// ---------------------------------------------------------------------------

describe("getValidRailwayToken()", () => {
  test("returns the existing access token when not expired (no refresh)", async () => {
    const store = makeStore({
      user: {
        accessToken: "current-access",
        refreshToken: "current-refresh",
        tokenExpiresAt: 10_000,
        token: "side-field",
      },
    });
    const { fetchImpl, calls } = makeFetchMock(() => {
      throw new Error("should not fetch");
    });

    const token = await getValidRailwayToken({
      store,
      fetchImpl,
      nowSeconds: () => 5_000, // well within validity
    });

    expect(token).toBe("current-access");
    expect(calls).toHaveLength(0);
    expect(store.writeCount).toBe(0);
  });

  test("refreshes and persists when access token is past expiry", async () => {
    const store = makeStore({
      user: {
        accessToken: "expired-access",
        refreshToken: "valid-refresh",
        tokenExpiresAt: 1_000,
        token: "side-field",
      },
    });
    const { fetchImpl, calls } = makeFetchMock(() =>
      jsonResponse({
        access_token: "fresh-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      })
    );

    const token = await getValidRailwayToken({
      store,
      fetchImpl,
      nowSeconds: () => 5_000, // tokenExpiresAt is in the past
    });

    expect(token).toBe("fresh-access");
    expect(calls).toHaveLength(1);
    expect(requireCall(calls).url).toBe(RAILWAY_OAUTH_TOKEN_URL);
    expect(store.writeCount).toBe(1);

    // Verify config-file round-trip preserves unrelated fields (the `token`
    // field is NOT modified by this module per spec).
    expect(store.current.user?.accessToken).toBe("fresh-access");
    expect(store.current.user?.refreshToken).toBe("rotated-refresh");
    expect(store.current.user?.tokenExpiresAt).toBe(5_000 + 3600);
    expect(store.current.user?.token).toBe("side-field");
  });

  test("refreshes when access token is within the 5-minute safety window", async () => {
    const store = makeStore({
      user: {
        accessToken: "expiring-soon",
        refreshToken: "valid-refresh",
        tokenExpiresAt: 5_100, // 100 seconds away — inside window
      },
    });
    const { fetchImpl } = makeFetchMock(() =>
      jsonResponse({ access_token: "fresh", expires_in: 3600 })
    );

    const token = await getValidRailwayToken({
      store,
      fetchImpl,
      nowSeconds: () => 5_000,
    });

    expect(token).toBe("fresh");
  });

  test("preserves the existing refreshToken when the response omits a rotated one", async () => {
    const store = makeStore({
      user: { accessToken: "old", refreshToken: "keep-me", tokenExpiresAt: 100 },
    });
    const { fetchImpl } = makeFetchMock(() =>
      jsonResponse({ access_token: "new-access", expires_in: 3600 })
    );

    await getValidRailwayToken({ store, fetchImpl, nowSeconds: () => 1_000 });

    expect(store.current.user?.refreshToken).toBe("keep-me");
  });

  test("throws RailwayAuthError with railway-login guidance when refresh is rejected", async () => {
    const store = makeStore({
      user: { accessToken: "old", refreshToken: "expired-refresh", tokenExpiresAt: 100 },
    });
    const { fetchImpl } = makeFetchMock(() => new Response("invalid_grant", { status: 400 }));

    await expect(
      getValidRailwayToken({ store, fetchImpl, nowSeconds: () => 1_000 })
    ).rejects.toThrow(RailwayAuthError);
    await expect(
      getValidRailwayToken({ store, fetchImpl, nowSeconds: () => 1_000 })
    ).rejects.toThrow(/railway login/i);
  });

  test("throws RailwayAuthError when access token is missing entirely", async () => {
    const store = makeStore({ user: {} });
    const { fetchImpl } = makeFetchMock(() => {
      throw new Error("should not fetch");
    });
    await expect(getValidRailwayToken({ store, fetchImpl })).rejects.toThrow(RailwayAuthError);
  });

  test("throws RailwayAuthError when access token is expired and refresh token is missing", async () => {
    const store = makeStore({
      user: { accessToken: "old", tokenExpiresAt: 100 },
    });
    const { fetchImpl } = makeFetchMock(() => {
      throw new Error("should not fetch");
    });

    await expect(
      getValidRailwayToken({ store, fetchImpl, nowSeconds: () => 1_000 })
    ).rejects.toThrow(/no refresh token is available/);
  });

  test("treats absent tokenExpiresAt as 'no refresh needed' (back-compat path)", async () => {
    // Older Railway config.json files may not carry tokenExpiresAt yet; in
    // that case we trust the token and let the GraphQL call fail with
    // "Not Authorized" if it's actually expired — matching pre-refresh behavior.
    const store = makeStore({
      user: { accessToken: "unknown-validity", refreshToken: RT_PLACEHOLDER },
    });
    const { fetchImpl, calls } = makeFetchMock(() => {
      throw new Error("should not fetch");
    });

    const token = await getValidRailwayToken({ store, fetchImpl, nowSeconds: () => 1_000 });

    expect(token).toBe("unknown-validity");
    expect(calls).toHaveLength(0);
  });

  test("single-flight: concurrent calls during the refresh window trigger exactly one POST", async () => {
    const store = makeStore({
      user: { accessToken: "old", refreshToken: RT_PLACEHOLDER, tokenExpiresAt: 100 },
    });

    let resolveResponse: ((value: Response) => void) | undefined;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });

    const { fetchImpl, calls } = makeFetchMock(() => responsePromise);

    const p1 = getValidRailwayToken({ store, fetchImpl, nowSeconds: () => 1_000 });
    const p2 = getValidRailwayToken({ store, fetchImpl, nowSeconds: () => 1_000 });
    const p3 = getValidRailwayToken({ store, fetchImpl, nowSeconds: () => 1_000 });

    // Yield so the inflight promise is set before resolution.
    await new Promise((r) => setTimeout(r, 0));

    if (!resolveResponse) {
      throw new Error("resolveResponse was not captured");
    }
    resolveResponse(jsonResponse({ access_token: FRESH_TOKEN, expires_in: 3600 }));

    const [t1, t2, t3] = await Promise.all([p1, p2, p3]);

    expect(t1).toBe(FRESH_TOKEN);
    expect(t2).toBe(FRESH_TOKEN);
    expect(t3).toBe(FRESH_TOKEN);
    expect(calls).toHaveLength(1);
    expect(store.writeCount).toBe(1);
  });

  test("after a refresh completes, subsequent calls reuse the cached fresh token", async () => {
    const store = makeStore({
      user: { accessToken: "old", refreshToken: RT_PLACEHOLDER, tokenExpiresAt: 100 },
    });
    const { fetchImpl, calls } = makeFetchMock(() =>
      jsonResponse({ access_token: "fresh", expires_in: 3600 })
    );

    const first = await getValidRailwayToken({ store, fetchImpl, nowSeconds: () => 1_000 });
    const second = await getValidRailwayToken({ store, fetchImpl, nowSeconds: () => 1_000 });

    expect(first).toBe("fresh");
    expect(second).toBe("fresh");
    // Second call reads the (already-refreshed) tokenExpiresAt of 1000+3600=4600,
    // which at now=1000 is far outside the window → no second fetch.
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// railwayGraphQLAuthed — convenience wrapper
// ---------------------------------------------------------------------------

describe("railwayGraphQLAuthed()", () => {
  test("obtains a refresh-aware token and forwards to railwayGraphQL", async () => {
    const store = makeStore({
      user: { accessToken: "valid", refreshToken: RT_PLACEHOLDER, tokenExpiresAt: 999_999 },
    });

    const { fetchImpl, calls } = makeFetchMock((call) => {
      if (call.url.includes("/graphql")) {
        return jsonResponse({ data: { ok: true } });
      }
      throw new Error("unexpected refresh call");
    });

    const result = await railwayGraphQLAuthed<{ ok: boolean }>(
      "query { ok }",
      {},
      { store, fetchImpl, nowSeconds: () => 100 }
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const graphqlCall = requireCall(calls);
    expect(graphqlCall.url).toMatch(/\/graphql/);
    const authHeader = (graphqlCall.init?.headers as Record<string, string>)["Authorization"];
    expect(authHeader).toBe("Bearer valid");
  });

  test("refreshes the token first when expired, then issues the GraphQL call with the new token", async () => {
    const store = makeStore({
      user: { accessToken: "old", refreshToken: RT_PLACEHOLDER, tokenExpiresAt: 100 },
    });

    const { fetchImpl, calls } = makeFetchMock((call) => {
      if (call.url === RAILWAY_OAUTH_TOKEN_URL) {
        return jsonResponse({ access_token: "fresh", expires_in: 3600 });
      }
      // GraphQL call: assert it carries the refreshed token.
      const authHeader = (call.init?.headers as Record<string, string>)["Authorization"];
      expect(authHeader).toBe("Bearer fresh");
      return jsonResponse({ data: { ok: true } });
    });

    await railwayGraphQLAuthed(
      "query { ok }",
      {},
      {
        store,
        fetchImpl,
        nowSeconds: () => 1_000,
      }
    );

    expect(calls).toHaveLength(2);
    expect(requireCall(calls, 0).url).toBe(RAILWAY_OAUTH_TOKEN_URL);
    expect(requireCall(calls, 1).url).toMatch(/\/graphql/);
  });
});

describe("fetchServiceMetrics (mt#2296)", () => {
  test("sends serviceId/startDate/measurements/sampleRate and parses the series", async () => {
    const { fetchImpl, calls } = makeFetchMock(() =>
      jsonResponse({
        data: {
          metrics: [
            { measurement: "CPU_USAGE", values: [{ ts: 100, value: 0.5 }] },
            { measurement: "CPU_LIMIT", values: [{ ts: 100, value: 8 }] },
          ],
        },
      })
    );

    const result = await fetchServiceMetrics(
      "svc-1",
      "2026-06-04T00:00:00.000Z",
      SERVICE_METRIC_MEASUREMENTS,
      "tok",
      300,
      fetchImpl
    );

    expect(result).toHaveLength(2);
    const cpuUsage = result.find((s) => s.measurement === "CPU_USAGE");
    expect(cpuUsage?.values[0]).toEqual({ ts: 100, value: 0.5 });

    const body = JSON.parse(String(requireCall(calls, 0).init?.body));
    expect(body.variables).toEqual({
      serviceId: "svc-1",
      startDate: "2026-06-04T00:00:00.000Z",
      measurements: ["CPU_USAGE", "CPU_LIMIT", "MEMORY_USAGE_GB", "MEMORY_LIMIT_GB"],
      sampleRateSeconds: 300,
    });
    expect(body.query).toMatch(/metrics\(/);
  });

  test("defaults sampleRateSeconds to null when omitted", async () => {
    const { fetchImpl, calls } = makeFetchMock(() => jsonResponse({ data: { metrics: [] } }));

    await fetchServiceMetrics(
      "svc-1",
      "2026-06-04T00:00:00.000Z",
      ["CPU_USAGE"],
      "tok",
      undefined,
      fetchImpl
    );

    const body = JSON.parse(String(requireCall(calls, 0).init?.body));
    expect(body.variables.sampleRateSeconds).toBeNull();
  });
});
