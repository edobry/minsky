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

type ChangesetsBody = { changesets: { pr: { number: number; state: string } }[] };

/**
 * The identity of a changeset set, for comparing two `/api/changesets`
 * responses (mt#4086, PR #2979 R1).
 *
 * Identifiers rather than a count: equal LENGTHS pass even when the responses
 * carry different PRs or duplicates.
 *
 * Order-insensitive, deliberately. The route sorts by a recency proxy
 * (`lastActivityAt ?? createdAt`), and the two requests being compared are
 * concurrent — a session touched between the two reads reorders one and not the
 * other. Asserting positional equality would reintroduce the transient-state
 * dependence mt#4086 exists to remove. The claim under test is set membership
 * ("the param does not change WHICH changesets come back"); the sort belongs to
 * `compareChangesetsByRecency` and its own tests.
 */
function changesetIdentifiers(body: ChangesetsBody): string[] {
  return body.changesets.map((c) => `${c.pr.number}:${c.pr.state}`).sort();
}

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
    // WHICH changesets come back — is checkable on the payload.
    const allBody = (await allRes.json()) as ChangesetsBody;
    const noParamBody = (await noParamRes.json()) as ChangesetsBody;
    expect(Array.isArray(allBody.changesets)).toBe(true);
    expect(Array.isArray(noParamBody.changesets)).toBe(true);
    expect(changesetIdentifiers(allBody)).toEqual(changesetIdentifiers(noParamBody));
  });

  // `changesetIdentifiers` is compared above only when BOTH requests reach the
  // store, and this harness configures no live provider — so under bun test that
  // branch does not execute (measured: a deliberately-failing assertion planted
  // there passed 1798/1798 in `src/cockpit`, i.e. it was never reached). An
  // assertion that never runs cannot be trusted to discriminate, so the
  // comparison is exercised directly here on the payload shape the route
  // actually returns (PR #2979 R1).
  test("changesetIdentifiers discriminates equal-length payloads with different PRs", () => {
    const one: ChangesetsBody = { changesets: [{ pr: { number: 2975, state: "open" } }] };
    const alsoOne: ChangesetsBody = { changesets: [{ pr: { number: 2975, state: "open" } }] };
    const differentPr: ChangesetsBody = { changesets: [{ pr: { number: 2976, state: "open" } }] };
    const differentState: ChangesetsBody = {
      changesets: [{ pr: { number: 2975, state: "draft" } }],
    };

    expect(changesetIdentifiers(one)).toEqual(changesetIdentifiers(alsoOne));
    // Same LENGTH, different content — the case a count comparison passes.
    expect(changesetIdentifiers(one)).not.toEqual(changesetIdentifiers(differentPr));
    expect(changesetIdentifiers(one)).not.toEqual(changesetIdentifiers(differentState));
    // Order-insensitive: see the note on `changesetIdentifiers`.
    const ab: ChangesetsBody = {
      changesets: [{ pr: { number: 1, state: "open" } }, { pr: { number: 2, state: "open" } }],
    };
    const ba: ChangesetsBody = {
      changesets: [{ pr: { number: 2, state: "open" } }, { pr: { number: 1, state: "open" } }],
    };
    expect(changesetIdentifiers(ab)).toEqual(changesetIdentifiers(ba));
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

    // PR 0 does not exist on any forge, and no session matches it. `0` is not a
    // valid PR number, but this route's contract is that an unresolvable id is
    // a 404 — mt#4724 widened the syntactic gate without changing that.
    const res = await fetch(`${url}/api/changeset/0`);
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(404);
  });
});

/**
 * GET /api/changeset/:id — project-qualified ids (mt#4724).
 *
 * The route-level half of the collision fix: the endpoint must ACCEPT an
 * `owner/repo#N` id (percent-encoded into the single path segment) rather than
 * rejecting it as non-numeric the way the pre-mt#4724 `/^[0-9]+$/` gate did.
 * WHICH PR each form resolves to is decided by `resolveChangesetRepoSource` /
 * `selectSessionForChangeset` and asserted directly against a two-project
 * fixture in `changeset-resolution.test.ts` — this harness configures no live
 * provider, so a two-project assertion here would be unreachable (the mistake
 * PR #2979 R1 caught in the sibling block above).
 */
describe("GET /api/changeset/:id project-qualified ids (mt#4724)", () => {
  let closeServer: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = null;
    }
  });

  test("accepts a qualified owner/repo#N id (not the pre-mt#4724 400)", async () => {
    const { url, close } = await startTestServer();
    closeServer = close;

    const res = await fetch(`${url}/api/changeset/${encodeURIComponent("edobry/peezombie.me#1")}`);
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(500);
    expect([200, 404]).toContain(res.status);
  });

  test("a ?project= qualifier on a bare id is accepted", async () => {
    const { url, close } = await startTestServer();
    closeServer = close;

    const res = await fetch(`${url}/api/changeset/1?project=edobry%2Fpeezombie.me`);
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(500);
    expect([200, 404]).toContain(res.status);
  });

  test("an UNRESOLVABLE ?project= fails closed rather than answering with another project's PR", async () => {
    const { url, close } = await startTestServer();
    closeServer = close;

    // `not-a-project` is not a known project row and is not an owner/repo pair,
    // so no repo resolves for it. Falling through to the default project would
    // hand the caller the default project's PR #1 — a different PR, and
    // indistinguishable from a correct answer (PR #3455 R1).
    const res = await fetch(`${url}/api/changeset/1?project=not-a-project`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("not-a-project");
  });

  test("a malformed qualified id is still a 400", async () => {
    const { url, close } = await startTestServer();
    closeServer = close;

    for (const id of ["edobry/peezombie.me#abc", "edobry/peezombie.me", "/repo#1"]) {
      const res = await fetch(`${url}/api/changeset/${encodeURIComponent(id)}`);
      expect(res.status).toBe(400);
    }
  });
});
