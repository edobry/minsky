/**
 * `checkTokenRepoAccess` (mt#5154): one `GET /repos/{owner}/{repo}`, classified.
 * The token never appears in any result, and a transport failure is `unknown`.
 */
import { describe, test, expect } from "bun:test";
import { checkTokenRepoAccess } from "./token-repo-access";

function fakeFetch(
  status: number,
  body?: unknown
): { fetchImpl: typeof fetch; calls: Array<{ url: string; auth: string }> } {
  const calls: Array<{ url: string; auth: string }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), auth: headers.authorization ?? "" });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("checkTokenRepoAccess", () => {
  test("200 with permissions.push → push", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { permissions: { push: true, pull: true } });
    const r = await checkTokenRepoAccess("edobry/flotato", "ghp_x", { fetchImpl });
    expect(r).toEqual({ state: "push", repo: "edobry/flotato" });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/edobry/flotato");
    expect(calls[0]?.auth).toBe("Bearer ghp_x");
  });

  test("200 without push → read-only", async () => {
    const { fetchImpl } = fakeFetch(200, { permissions: { push: false, pull: true } });
    expect(await checkTokenRepoAccess("edobry/flotato", "t", { fetchImpl })).toEqual({
      state: "read-only",
      repo: "edobry/flotato",
    });
  });

  test("404 and 403 are both not-accessible, carrying the status", async () => {
    for (const status of [404, 403]) {
      const { fetchImpl } = fakeFetch(status, { message: "Not Found" });
      expect(await checkTokenRepoAccess("edobry/flotato", "t", { fetchImpl })).toEqual({
        state: "not-accessible",
        repo: "edobry/flotato",
        status,
      });
    }
  });

  test("another non-2xx is unknown, not a verdict", async () => {
    const { fetchImpl } = fakeFetch(502);
    expect(await checkTokenRepoAccess("edobry/flotato", "t", { fetchImpl })).toMatchObject({
      state: "unknown",
      reason: "HTTP 502",
    });
  });

  test("a transport failure is unknown with the reason, never a throw", async () => {
    const fetchImpl = (async () => {
      throw new Error("ENOTFOUND api.github.com");
    }) as unknown as typeof fetch;
    expect(await checkTokenRepoAccess("edobry/flotato", "t", { fetchImpl })).toEqual({
      state: "unknown",
      repo: "edobry/flotato",
      reason: "ENOTFOUND api.github.com",
    });
  });
});
