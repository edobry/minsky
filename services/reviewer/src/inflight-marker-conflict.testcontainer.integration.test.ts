/**
 * acquireMarker's ON CONFLICT semantics against a REAL Postgres (mt#4267).
 *
 * ## Why this file exists
 *
 * `inflight-marker.test.ts` exercises `acquireMarker` against a Map-backed fake
 * whose INSERT branch HARDCODES the conflict semantics — it decides "insert /
 * take over / deny" in TypeScript rather than by interpreting the ON CONFLICT
 * clause. That fake is fine for the module's control flow and structurally
 * incapable of answering the two questions this change actually turns on:
 *
 *   1. Does `ON CONFLICT (owner, repo, pr_number, head_sha)` INFER the table's
 *      named `uniq_pr_head` UNIQUE constraint as its arbiter?
 *   2. When `DO UPDATE ... WHERE` matches nothing, does Postgres return an empty
 *      RETURNING (which `acquireMarker` reads as `acquired: false`) rather than
 *      raising, or updating anyway?
 *
 * Both are properties of Postgres, not of our code, and a fake that models the
 * answer cannot test it. This is the same gap mt#3005 was filed for: mt#2966 /
 * mt#2967 shipped a bare `.onConflictDoNothing({ target })` against a PARTIAL
 * unique index, every one of their tests used a fake whose `onConflictDoNothing`
 * was a passthrough, and the arbiter-inference mismatch only surfaced in
 * production — every session and memory insert failing with "no unique or
 * exclusion constraint matching the ON CONFLICT specification". Question 1 above
 * is that exact failure mode, one table over.
 *
 * The DDL is read from the SHIPPED migration (`migrations/pg/0002_inflight_reviews.sql`)
 * rather than re-declared here, so the constraint this test proves the arbiter
 * infers is the constraint production actually has.
 *
 * ## Two-level gate
 *
 * Mirrors `tests/integration/short-id-conflict-inference.testcontainer.integration.test.ts`:
 *
 *   RUN_INTEGRATION_TESTS=1
 *   RUN_TESTCONTAINER_TESTS=1
 *
 * Run:
 *   RUN_INTEGRATION_TESTS=1 RUN_TESTCONTAINER_TESTS=1 \
 *     bun test --cwd services/reviewer --preload ../../tests/setup.ts --timeout=180000 \
 *       src/inflight-marker-conflict.testcontainer.integration.test.ts
 *
 * With either variable unset this file defines no tests and costs nothing, which
 * is why it can sit beside the unit tests in the reviewer's default run.
 *
 * If the container fails to start with a "Log message ... Started ... not
 * received" error, that is testcontainers' Ryuk reaper sidecar failing to come
 * up — set `TESTCONTAINERS_RYUK_DISABLED=true` (see the mt#3005 file's header
 * for the full note).
 *
 * @see mt#4267 — this file's originating task
 * @see mt#1907 — the marker, its TTL, and the AT-4/AT-5 the deny path preserves
 * @see mt#3005 — the precedent: a fake conflict-handler hiding a real arbiter rule
 */

import { afterAll, describe, test, expect } from "bun:test";
import { GenericContainer, type WaitStrategy } from "testcontainers";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { join } from "path";
// Reads the real committed migration so the DDL under test is production's own,
// not a copy that can drift from it. Mirrors the mt#3005 file's use of the real
// migration journal — not test-state faking.
// eslint-disable-next-line custom/no-real-fs-in-tests -- reads the real committed migration DDL so the arbiter constraint under test is production's own
import { readFileSync } from "fs";
import { acquireMarker, refreshMarker } from "./inflight-marker";
import type { ReviewerDb } from "./db/client";

/**
 * No-op wait strategy — every built-in testcontainers wait strategy hangs under
 * Bun; readiness is determined by our own SQL probe below. See
 * `tests/integration/postgres-pool-saturation.testcontainer.integration.test.ts`
 * for the full rationale.
 */
function makeNoOpWaitStrategy(defaultTimeoutMs: number): WaitStrategy {
  let storedTimeoutMs: number | undefined;
  const strategy: WaitStrategy = {
    async waitUntilReady() {
      // Intentionally empty — readiness is determined by the SQL probe below.
    },
    withStartupTimeout(timeoutMs: number) {
      storedTimeoutMs = timeoutMs;
      return strategy;
    },
    isStartupTimeoutSet() {
      return storedTimeoutMs !== undefined;
    },
    getStartupTimeout() {
      return storedTimeoutMs ?? defaultTimeoutMs;
    },
  };
  return strategy;
}

/** No pgvector needed — this table has no vector column. */
const POSTGRES_IMAGE = "postgres:16";

const OWNER = "edobry";
const REPO = "minsky";
const PR_NUMBER = 3107;
const HEAD_SHA = "sha-3107";
const FIVE_MINUTES_MS = 300_000;

if (process.env.RUN_INTEGRATION_TESTS && process.env.RUN_TESTCONTAINER_TESTS) {
  process.stdout.write(`[inflight-marker/testcontainer] starting ${POSTGRES_IMAGE}\n`);

  const container = await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_USER: "postgres",
      POSTGRES_DB: "postgres",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(makeNoOpWaitStrategy(120_000))
    .withStartupTimeout(120_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const connectionString = `postgresql://postgres:postgres@${host}:${port}/postgres`;

  const client = postgres(connectionString, { max: 4, onnotice: () => {} });

  // Readiness probe — poll until the server answers, since the wait strategy above
  // deliberately does not.
  const READY_ATTEMPTS = 60;
  let ready = false;
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    try {
      await client`SELECT 1`;
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!ready) {
    throw new Error(`Postgres container did not accept connections after ${READY_ATTEMPTS}s`);
  }

  // Apply the SHIPPED migration's DDL. drizzle's migrator wants the whole
  // reviewer migration tree plus a journal; this table is self-contained, so
  // replaying its own statements is both sufficient and narrower.
  const migrationPath = join(
    import.meta.dir,
    "..",
    "migrations",
    "pg",
    "0002_inflight_reviews.sql"
  );
  // eslint-disable-next-line custom/no-real-fs-in-tests -- reads the real committed migration DDL so the arbiter constraint under test is production's own; mocking it would defeat the file's entire purpose
  const migrationSql = readFileSync(migrationPath, "utf-8");
  for (const statement of migrationSql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed.length === 0) continue;
    await client.unsafe(trimmed);
  }

  const db = drizzle(client) as unknown as ReviewerDb;

  afterAll(async () => {
    await client.end({ timeout: 5 });
    await container.stop();
  });

  /** Force the row's expires_at into the past, simulating a killed runReview. */
  async function expireMarker(): Promise<void> {
    await db.execute(
      sql`UPDATE reviewer_inflight_reviews
             SET expires_at = now() - interval '11 minutes'
           WHERE owner = ${OWNER} AND repo = ${REPO}
             AND pr_number = ${PR_NUMBER} AND head_sha = ${HEAD_SHA}`
    );
  }

  // `expires_at` is typed as a string, not a Date: drizzle's raw `execute` returns
  // the driver's own row shape with no schema-driven type mapping, so a
  // `timestamptz` arrives as its ISO text. Typing it as Date compiles fine and
  // fails at runtime on `.getTime()`, which is how this was found.
  async function markerRow(): Promise<{
    id: string;
    acquired_by: string;
    delivery_id: string;
    expires_at: string;
  }> {
    const rows = await db.execute<{
      id: string;
      acquired_by: string;
      delivery_id: string;
      expires_at: string;
    }>(
      sql`SELECT id, acquired_by, delivery_id, expires_at
            FROM reviewer_inflight_reviews
           WHERE owner = ${OWNER} AND repo = ${REPO}
             AND pr_number = ${PR_NUMBER} AND head_sha = ${HEAD_SHA}`
    );
    const row = rows[0];
    if (row === undefined) throw new Error("expected exactly one marker row");
    return row;
  }

  async function rowCount(): Promise<number> {
    const rows = await db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM reviewer_inflight_reviews`
    );
    return Number(rows[0]?.n ?? "-1");
  }

  describe("acquireMarker against real Postgres (mt#4267)", () => {
    test("the column-list conflict target infers the uniq_pr_head constraint", async () => {
      // If the arbiter did NOT infer, Postgres raises 42P10 "no unique or
      // exclusion constraint matching the ON CONFLICT specification" — the
      // mt#2966/mt#2967 production failure, one table over. Reaching an
      // ordinary result at all is this assertion's real content.
      const first = await acquireMarker(db, {
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        headSha: HEAD_SHA,
        acquiredBy: "webhook",
        deliveryId: "del-first",
        ttlMs: FIVE_MINUTES_MS,
      });

      expect(first.acquired).toBe(true);
      expect(await rowCount()).toBe(1);
    });

    test("a LIVE marker denies — DO UPDATE's WHERE does not match, RETURNING is empty", async () => {
      const second = await acquireMarker(db, {
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        headSha: HEAD_SHA,
        acquiredBy: "sweeper",
        deliveryId: "del-second",
        ttlMs: FIVE_MINUTES_MS,
      });

      expect(second.acquired).toBe(false);
      if (!second.acquired) {
        expect(second.heldBy).toBe("webhook");
      }

      // The losing acquire must not have mutated the winner's row — that is what
      // makes mt#1907's AT-4/AT-5 (two live acquirers, exactly one wins) hold.
      const row = await markerRow();
      expect(row.acquired_by).toBe("webhook");
      expect(row.delivery_id).toBe("del-first");
    });

    test("an EXPIRED marker is taken over in place, keeping its id", async () => {
      const before = await markerRow();
      await expireMarker();

      const taken = await acquireMarker(db, {
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        headSha: HEAD_SHA,
        acquiredBy: "sweeper",
        deliveryId: "del-after-redeploy",
        ttlMs: FIVE_MINUTES_MS,
      });

      expect(taken.acquired).toBe(true);
      // DO UPDATE updates the existing row; RETURNING gives that row's id back.
      // A takeover that minted a new id would leave the old row for releaseMarker
      // to miss.
      if (taken.acquired) {
        expect(taken.id).toBe(before.id);
      }
      expect(await rowCount()).toBe(1);

      const after = await markerRow();
      expect(after.acquired_by).toBe("sweeper");
      expect(after.delivery_id).toBe("del-after-redeploy");
      // The takeover reset the expiry to now + ttl, so the row is live again —
      // this is what makes the NEXT caller see a held marker rather than another
      // free-for-all.
      expect(new Date(after.expires_at).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe("refreshMarker against real Postgres (mt#4993)", () => {
    // Same argument as this file's docblock, one function over. The unit fake's
    // UPDATE branch decides "matched / did not match" in TypeScript, so it can
    // only confirm the predicate I wrote into the fake. Two properties here are
    // Postgres's, not ours:
    //   1. `now() + $1 * interval '1 millisecond'` — interval arithmetic against
    //      a BOUND parameter. A bound int multiplied by an interval is not
    //      obviously well-typed, and getting it wrong is a runtime 42883
    //      (operator does not exist), invisible to any fake.
    //   2. `RETURNING id` on an UPDATE whose WHERE matches nothing — empty
    //      result rather than an error, which is what `refreshMarker` reads as
    //      "ownership lost".

    test("the refresh extends expiry — bound-parameter interval arithmetic works", async () => {
      const before = await markerRow();
      const beforeExpiry = new Date(before.expires_at).getTime();

      const refreshed = await refreshMarker(db, {
        markerId: before.id,
        deliveryId: before.delivery_id,
        ttlMs: FIVE_MINUTES_MS * 2,
      });

      expect(refreshed).toBe(true);

      const after = await markerRow();
      // Strictly later than it was: the UPDATE ran AND the interval expression
      // evaluated. An expiry that merely stayed live would also satisfy a
      // "> now()" check while the SET did nothing.
      expect(new Date(after.expires_at).getTime()).toBeGreaterThan(beforeExpiry);
      // Nothing else moved — a refresh is not a takeover.
      expect(after.id).toBe(before.id);
      expect(after.acquired_by).toBe(before.acquired_by);
      expect(after.delivery_id).toBe(before.delivery_id);
    });

    test("a STALE delivery_id refreshes nothing — the ownership guard holds in Postgres", async () => {
      const before = await markerRow();
      const beforeExpiry = new Date(before.expires_at).getTime();

      // The row id is STABLE across a takeover (proved by the test above), so an
      // id-only predicate would match here and let a superseded holder extend a
      // marker it no longer owns.
      const refreshed = await refreshMarker(db, {
        markerId: before.id,
        deliveryId: "del-a-previous-holder",
        ttlMs: FIVE_MINUTES_MS * 10,
      });

      expect(refreshed).toBe(false);

      const after = await markerRow();
      expect(new Date(after.expires_at).getTime()).toBe(beforeExpiry);
    });

    test("a refreshed marker is NOT taken over — the mt#4993 property, end to end", async () => {
      // Expire the row, then refresh it as its rightful owner would. A second
      // acquirer must still be denied: this is precisely the case that produced
      // 19 duplicate concurrent reviews over 30 days before the heartbeat.
      await expireMarker();
      const held = await markerRow();

      expect(
        await refreshMarker(db, {
          markerId: held.id,
          deliveryId: held.delivery_id,
          ttlMs: FIVE_MINUTES_MS,
        })
      ).toBe(true);

      const contender = await acquireMarker(db, {
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        headSha: HEAD_SHA,
        acquiredBy: "webhook",
        deliveryId: "del-would-have-duplicated",
        ttlMs: FIVE_MINUTES_MS,
      });

      expect(contender.acquired).toBe(false);
      expect(await rowCount()).toBe(1);

      // Negative control for the same expiry: WITHOUT the refresh, the contender
      // gets in. This is the pre-mt#4993 behaviour, observed rather than assumed.
      await expireMarker();
      const duplicate = await acquireMarker(db, {
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        headSha: HEAD_SHA,
        acquiredBy: "webhook",
        deliveryId: "del-would-have-duplicated",
        ttlMs: FIVE_MINUTES_MS,
      });
      expect(duplicate.acquired).toBe(true);
    });
  });
}
