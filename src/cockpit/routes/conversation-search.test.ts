/**
 * Tests for GET /api/conversations/search (mt#2523).
 *
 * Mirrors the HTTP-layer contract pattern of `../server-conversation-overview.test.ts`:
 * no real Postgres in the test environment, so `getContextInspectorDb()`
 * resolves to `null` and every request that passes the `q` validation
 * degrades to the same 503 contract. Full search-result behavior (ranking,
 * coverage-gap detection) is covered by the domain-layer unit tests
 * (`transcript-fts-service.test.ts`, `transcript-similarity-service.test.ts`,
 * `transcript-search-filters.test.ts`) and the CLI/MCP command tests
 * (`search-command.test.ts`, `search-text-command.test.ts`) — this file
 * covers only the route's own request-parsing and HTTP-contract behavior.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { createServer } from "http";
import type { Server } from "http";
import { createCockpitServer } from "../server";

const TEST_TOKEN = "test-conversation-search-token";

async function startTestServer(
  opts?: Parameters<typeof createCockpitServer>[0]
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createCockpitServer({ overrideToken: TEST_TOKEN, ...opts });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected addr shape");
  const url = `http://127.0.0.1:${addr.port}`;
  const close = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return { url, close };
}

describe("GET /api/conversations/search", () => {
  const closeList: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closeList.splice(0)) {
      await close();
    }
  });

  async function server(opts?: Parameters<typeof createCockpitServer>[0]) {
    const s = await startTestServer(opts);
    closeList.push(s.close);
    return s.url;
  }

  test("returns 400 when 'q' is missing", async () => {
    const url = await server();
    const res = await fetch(`${url}/api/conversations/search`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });

  test("returns 400 when 'q' is blank/whitespace", async () => {
    const url = await server();
    const res = await fetch(`${url}/api/conversations/search?q=${encodeURIComponent("   ")}`);
    expect(res.status).toBe(400);
  });

  test("returns a JSON 503 when the DB is unavailable (no Postgres in the test environment)", async () => {
    const url = await server();
    const res = await fetch(`${url}/api/conversations/search?q=hello`);

    expect(res.status).toBe(503);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });

  test("endpoint is registered BEFORE the SPA catch-all (not swallowed by *)", async () => {
    const url = await server();
    const res = await fetch(`${url}/api/conversations/search?q=hello`);
    expect(res.status).not.toBe(404);
  });

  test("mode=semantic is accepted without crashing the request (still degrades to the same 503)", async () => {
    const url = await server();
    const res = await fetch(`${url}/api/conversations/search?q=hello&mode=semantic`);
    expect(res.status).toBe(503);
  });

  test("a from/to date window is accepted without crashing the request", async () => {
    const url = await server();
    const res = await fetch(
      `${url}/api/conversations/search?q=hello&from=2026-06-01&to=2026-06-07`
    );
    expect(res.status).toBe(503);
  });

  test("an unparseable date string degrades gracefully rather than crashing (still the same 503)", async () => {
    const url = await server();
    const res = await fetch(`${url}/api/conversations/search?q=hello&from=not-a-date`);
    expect(res.status).toBe(503);
  });
});
