/**
 * fetchWidgetData URL-composition tests (mt#2443).
 *
 * Three memories widgets embedded query strings in the widget id, composing
 * /api/widget/<id>?<qs>/data — the "?" ends the URL path before "/data", the
 * request misses the widget route, and the SPA fallback returns index.html
 * (permanent "Loading…" in the UI). These tests pin the correct composition
 * and the boundary guard against the malformed shape.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { fetchWidgetData } from "./widget-client";

// Safety assumption for the globalThis.fetch override: `bun test` executes
// test files sequentially in one process, and afterEach restores the original
// before any other file runs. If parallel file execution ever lands, switch
// to a scoped mock API.
const originalFetch = globalThis.fetch;

function captureFetch(): { urls: string[] } {
  const captured = { urls: [] as string[] };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    captured.urls.push(String(input));
    return new Response(JSON.stringify({ state: "ok", payload: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return captured;
}

describe("fetchWidgetData URL composition (mt#2443)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("bare id composes /api/widget/<id>/data", async () => {
    const captured = captureFetch();
    await fetchWidgetData("memories-list");
    expect(captured.urls).toEqual(["/api/widget/memories-list/data"]);
  });

  test("params compose AFTER /data, URL-encoded", async () => {
    const captured = captureFetch();
    await fetchWidgetData("memories-detail", { id: "abc def", n: 5 });
    expect(captured.urls).toEqual(["/api/widget/memories-detail/data?id=abc+def&n=5"]);
  });

  test("an id embedding a query string is rejected at the boundary", async () => {
    captureFetch();
    await expect(fetchWidgetData("memories-list?excludeSuperseded=true")).rejects.toThrow(
      /bare kebab-case widget id/
    );
  });

  test("other path-breaking characters are rejected too", async () => {
    captureFetch();
    for (const bad of ["memories/list", "memories#list", "memories%2Flist", "../memories"]) {
      await expect(fetchWidgetData(bad)).rejects.toThrow(/bare kebab-case widget id/);
    }
  });
});
