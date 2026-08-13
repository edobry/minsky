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
import { getLoggedErrors } from "../utils/test-utils/mock-logger";

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

    // The route answers 503 (no session provider) or 200, and turns any
    // unexpected throw into an opaque 500 whose body says only "An internal
    // error occurred" — so a bare status-equality assertion reports THAT the
    // statuses diverged and never why. The real cause is logged at
    // routes/changesets.ts's catch, into the globally-mocked logger, where the
    // run output cannot see it. Surfacing it here is what makes a failure
    // diagnosable from CI output alone (mt#4086).
    if (allRes.status !== noParamRes.status) {
      const changesetErrors = getLoggedErrors().filter((m) => m.includes("changesets"));
      throw new Error(
        `status mismatch: ?project=all -> ${allRes.status}, no param -> ${noParamRes.status}. ` +
          `Logged route errors: ${JSON.stringify(changesetErrors)}`
      );
    }
    expect(allRes.status).toBe(noParamRes.status);
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
