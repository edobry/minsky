/**
 * apiFetch default-project-append behavior (mt#4730).
 *
 * Mirrors widget-client.test.ts's fetch-capture pattern.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { apiFetch, apiFetchJson } from "./api-client";

const STORAGE_KEY = "cockpit.project.v1";
const originalFetch = globalThis.fetch;

function captureFetch(): { urls: string[] } {
  const captured = { urls: [] as string[] };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    captured.urls.push(String(input));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return captured;
}

function clearPersistedProject(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore — matches loadPersistedSlug's own fail-open posture */
  }
}

describe("apiFetch default-project-append (mt#4730)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearPersistedProject();
  });

  test("no project selected: no ?project= appended", async () => {
    clearPersistedProject();
    const captured = captureFetch();
    await apiFetch("/api/tasks");
    expect(captured.urls).toEqual(["/api/tasks"]);
  });

  test("a project is selected: appended by default with no caller opt-in", async () => {
    localStorage.setItem(STORAGE_KEY, "edobry/minsky");
    const captured = captureFetch();
    await apiFetch("/api/tasks");
    expect(captured.urls).toEqual(["/api/tasks?project=edobry%2Fminsky"]);
  });

  test("an explicit project param wins over the persisted default", async () => {
    localStorage.setItem(STORAGE_KEY, "edobry/minsky");
    const captured = captureFetch();
    await apiFetch("/api/tasks", { project: "other/repo" });
    expect(captured.urls).toEqual(["/api/tasks?project=other%2Frepo"]);
  });

  test("{ global: true } opts out even when a project is selected", async () => {
    localStorage.setItem(STORAGE_KEY, "edobry/minsky");
    const captured = captureFetch();
    await apiFetch("/api/projects", undefined, { global: true });
    expect(captured.urls).toEqual(["/api/projects"]);
  });

  test("other params are preserved alongside the default-appended project", async () => {
    localStorage.setItem(STORAGE_KEY, "edobry/minsky");
    const captured = captureFetch();
    await apiFetch("/api/tasks", { limit: 10 });
    expect(captured.urls).toEqual(["/api/tasks?limit=10&project=edobry%2Fminsky"]);
  });

  test("apiFetchJson parses a successful body", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ hello: "world" }), { status: 200 })) as unknown as typeof fetch;
    const result = await apiFetchJson<{ hello: string }>("/api/x");
    expect(result).toEqual({ hello: "world" });
  });

  test("apiFetchJson throws on a non-ok response", async () => {
    globalThis.fetch = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(apiFetchJson("/api/y")).rejects.toThrow(/failed: 500/);
  });
});
