/**
 * Tests for the GET /api/conversation/:agentSessionId/overview endpoint
 * (mt#2768 — conversation-keyed run overview, the reverse-join sibling of
 * `GET /api/agents/:id`).
 *
 * Covers the HTTP-layer contract: response structure for missing services
 * (503 when no DB/provider in the test environment), and that the endpoint
 * is registered ahead of the SPA catch-all. Full reverse-join resolution
 * (`pickBestWorkspaceLink`, `buildWorkspaceOverview`) is covered by pure
 * unit tests in `session-detail.test.ts` and by live verification against a
 * real database (see the task's PR body).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { createServer } from "http";
import type { Server } from "http";
import { createCockpitServer } from "./server";

const TEST_TOKEN = "test-conversation-overview-token";

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

describe("GET /api/conversation/:agentSessionId/overview", () => {
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

  test("returns a JSON 503 when the DB is unavailable (no Postgres in the test environment)", async () => {
    const url = await server();
    const res = await fetch(`${url}/api/conversation/some-conversation-id/overview`);

    expect(res.status).toBe(503);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });

  test("endpoint is registered BEFORE the SPA catch-all (not swallowed by *)", async () => {
    const url = await server();
    // If unregistered, the SPA catch-all would return 404 with HTML or the
    // "bundle not built" JSON — neither is the 503 JSON contract above.
    const res = await fetch(`${url}/api/conversation/some-conversation-id/overview`);
    expect(res.status).not.toBe(404);
  });

  test("a URL-encoded conversation id is decoded server-side (no crash, still 503 on no-DB)", async () => {
    const url = await server();
    const res = await fetch(
      `${url}/api/conversation/${encodeURIComponent("weird id/with-slash-like-chars")}/overview`
    );
    // Encoded id round-trips through Express's :agentSessionId param without
    // erroring the handler — still degrades to the same no-DB 503 contract.
    expect(res.status).toBe(503);
  });
});
