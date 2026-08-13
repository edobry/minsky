/**
 * Integration test for GET /api/changesets?project=<slug> (mt#2418).
 *
 * Mirrors the server-tasks.test.ts / server-projects.test.ts pattern: no
 * live SQL persistence provider is configured in this test process, so the
 * route degrades to whatever its no-db posture is (503 when the session
 * provider itself is unavailable, or 200 + empty list when it succeeds with
 * no rows). This test's purpose is narrower than a full scoping assertion
 * (that's covered by tests/domain/project-scope-acceptance.test.ts +
 * src/cockpit/project-scope.test.ts) — it proves the `?project=` query
 * param is accepted and does not crash the route.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { createServer } from "http";
import type { Server } from "http";
import { createCockpitServer } from "./server";
import { safeTruncate } from "../utils/safe-truncate";

const TEST_TOKEN = "test-server-changesets-token";

async function startTestServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const app = createCockpitServer({ overrideToken: TEST_TOKEN });
  const server: Server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected address");

  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

describe("GET /api/changesets?project=<slug> (mt#2418)", () => {
  let closeServer: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = null;
    }
  });

  test("accepts a ?project= query param without erroring", async () => {
    const { url, close } = await startTestServer();
    closeServer = close;

    const res = await fetch(`${url}/api/changesets?project=edobry%2Fminsky`);
    expect([200, 503]).toContain(res.status);

    const body = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) {
      expect(body).toHaveProperty("changesets");
      expect(Array.isArray(body["changesets"])).toBe(true);
    } else {
      expect(body).toHaveProperty("error");
    }
  });

  test("?project=all behaves the same as omitting the param", async () => {
    const { url, close } = await startTestServer();
    closeServer = close;

    const [allRes, noParamRes] = await Promise.all([
      fetch(`${url}/api/changesets?project=all`),
      fetch(`${url}/api/changesets`),
    ]);

    // Both responses must land in the route's documented posture: 200, or 503
    // when the session store is unavailable. Anything else — a 500 in
    // particular — is a regression, which is what the sibling mt#3096 block
    // below asserts for the detail route.
    //
    // The failure message carries the BODY, not just the status. The body is
    // what identifies which layer answered, and it is the only channel that
    // does: the route logs its own cause, but the harness silences winston's
    // Console transport in-process (packages/shared/src/logger.ts, mt#2975), so
    // a failing CI run shows the status and nothing else. Diagnosing mt#4086
    // without this cost several full-suite reproductions.
    for (const [label, res] of [
      ["?project=all", allRes],
      ["no param", noParamRes],
    ] as const) {
      if (res.status !== 200 && res.status !== 503) {
        const body = await res.text();
        throw new Error(
          `${label} -> ${res.status}, expected 200 or 503. body: ${safeTruncate(body, 800, "head")}`
        );
      }
    }

    // The param-equivalence claim is only EVALUABLE when both requests reached
    // the store. A 503 means it was unavailable for that request, and two
    // concurrent requests can legitimately differ there — mt#4086: Supavisor
    // returned EMAXCONNSESSION ("max clients reached … pool_size: 15") to one
    // of these two under full-suite load while the other succeeded. Asserting
    // status equality across that is asserting the database never saturates,
    // which is not this test's subject and is not true.
    if (allRes.status === 503 || noParamRes.status === 503) return;

    // Both reached the store, so the actual claim — the param does not change
    // the result — is checkable on the payload rather than on the status alone.
    const allBody = (await allRes.json()) as { changesets: unknown[] };
    const noParamBody = (await noParamRes.json()) as { changesets: unknown[] };
    expect(Array.isArray(allBody.changesets)).toBe(true);
    expect(Array.isArray(noParamBody.changesets)).toBe(true);
    expect(allBody.changesets.length).toBe(noParamBody.changesets.length);
  });
});

/**
 * GET /api/changeset/:id degradation contract (mt#3096).
 *
 * This harness configures NO live SQL persistence provider, so
 * `getServerSessionProvider()` resolves unavailable — precisely the
 * "session store is down" condition that used to surface as a 500 for the
 * whole page (observed live 2026-07-23, `Failed query: select ... from
 * "sessions"`). The route must degrade instead: resolve from the live PR when
 * it can, and 404 only when nothing resolves. A 500 is a regression.
 */
describe("GET /api/changeset/:id degradation (mt#3096)", () => {
  let closeServer: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = null;
    }
  });

  test("never returns 500 when the session store is unavailable", async () => {
    const { url, close } = await startTestServer();
    closeServer = close;

    const res = await fetch(`${url}/api/changeset/2222`);
    expect(res.status).not.toBe(500);
    // 200 when the live forge resolved the PR, 404 when neither source did.
    expect([200, 404]).toContain(res.status);
  });

  test("rejects a non-numeric changeset id with 400 (not 404 or 500)", async () => {
    const { url, close } = await startTestServer();
    closeServer = close;

    const res = await fetch(`${url}/api/changeset/not-a-number`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("expected a PR number");
  });

  test("a wholly unresolvable id is a 404, not a 500", async () => {
    const { url, close } = await startTestServer();
    closeServer = close;

    // PR 0 does not exist on any forge, and no session matches it.
    const res = await fetch(`${url}/api/changeset/0`);
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(404);
  });
});
