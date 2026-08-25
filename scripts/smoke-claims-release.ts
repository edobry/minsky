#!/usr/bin/env bun
/**
 * Smoke test for presence-claim RELEASE (mt#4568).
 *
 * Replays the originating incident against real Postgres — agent A claims, agent
 * B claims, agent A releases — and asserts the three properties the unit tests
 * cannot reach, because they are about rows actually leaving the table:
 *
 *   AT1  the caller's claim is gone and the peer's is untouched
 *   AT2  releasing a claim you do not hold deletes nothing and says so
 *   AT3  `total` goes 2 → 1 and the survivor is B
 *   SC5  the release names the actorId and claimedAt of what it removed
 *
 * Uses a synthetic `subjectId` so it never touches a real task's claims, and
 * cleans up after itself on every exit path.
 *
 * Resolves the DB connection via Minsky's own configuration system rather than
 * requiring DATABASE_URL directly — same pattern as
 * `scripts/smoke-session-attachment.ts`, the session-grain sibling. Skips
 * gracefully (exit 0) when no Postgres connection is configured.
 *
 * Usage:
 *   bun scripts/smoke-claims-release.ts
 */

import "reflect-metadata";

import { selectOwnClaims } from "../src/adapters/shared/commands/tasks/claims-command";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main() {
  const { loadConfiguration } = await import("@minsky/domain/configuration/loader");
  const configResult = await loadConfiguration();
  const connectionString = configResult.config.persistence?.postgres?.connectionString;
  if (!connectionString) {
    console.log("[smoke-claims-release] No Postgres connection configured — skipping smoke test");
    process.exit(0);
  }

  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { DrizzlePresenceClaimRepository } = await import(
    "../packages/domain/src/presence/repository"
  );

  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);
  const repo = new DrizzlePresenceClaimRepository(db);

  const subjectKind = "task" as const;
  const subjectId = `smoke-release-${Date.now()}`;
  const actorA = "com.anthropic.claude-code:conv:smoke-actor-a";
  const actorB = "com.anthropic.claude-code:conv:smoke-actor-b";
  const actorC = "com.anthropic.claude-code:conv:smoke-actor-c-never-claimed";

  const results: Record<string, unknown> = { subjectId };

  try {
    // ── AT3 setup: A claims, then B claims the same subject ──────────────────
    console.log("[smoke-claims-release] 1. Agent A claims...");
    const claimA = await repo.upsertClaim({ subjectKind, subjectId, actorId: actorA });
    await new Promise((r) => setTimeout(r, 25));
    console.log("[smoke-claims-release] 2. Agent B claims the same subject...");
    await repo.upsertClaim({ subjectKind, subjectId, actorId: actorB });

    const before = await repo.listClaims(subjectKind, subjectId);
    console.log(`  total before release: ${before.length}`);
    assert(before.length === 2, `expected 2 claims before release, got ${before.length}`);
    results.totalBefore = before.length;

    // ── AT2: a caller holding no claim releases nothing ─────────────────────
    console.log("[smoke-claims-release] 3. Agent C (never claimed) releases — expect a no-op...");
    const cOwn = selectOwnClaims(before, actorC);
    assert(cOwn.length === 0, `expected C to own 0 claims, got ${cOwn.length}`);
    const cDeleted = cOwn.length > 0 ? await repo.deleteByIds(cOwn.map((c) => c.id)) : 0;
    assert(cDeleted === 0, `expected C's release to delete 0 rows, got ${cDeleted}`);
    const afterNoop = await repo.listClaims(subjectKind, subjectId);
    assert(
      afterNoop.length === 2,
      `a no-op release must not delete anything; got ${afterNoop.length} rows`
    );
    console.log("  released: 0, rows intact: 2");
    results.noopRelease = { released: cDeleted, rowsRemaining: afterNoop.length };

    // ── AT1 + AT3 + SC5: A releases its own claim ───────────────────────────
    console.log("[smoke-claims-release] 4. Agent A releases its own claim...");
    const aOwn = selectOwnClaims(afterNoop, actorA);
    assert(aOwn.length === 1, `expected A to own exactly 1 claim, got ${aOwn.length}`);

    // SC5: the release must be able to NAME what it removed.
    const removed = aOwn.map((c) => ({ actorId: c.actorId, claimedAt: c.claimedAt }));
    assert(removed[0]?.actorId === actorA, "removed row must carry the actorId");
    assert(
      removed[0]?.claimedAt === claimA.claimedAt,
      "removed row must carry the original claimedAt"
    );
    console.log(`  removing: ${JSON.stringify(removed)}`);

    const releasedCount = await repo.deleteByIds(aOwn.map((c) => c.id));
    assert(releasedCount === 1, `expected to release 1 row, got ${releasedCount}`);
    results.released = { count: releasedCount, removed };

    // ── AT1/AT3 verification: read the table back ───────────────────────────
    console.log("[smoke-claims-release] 5. Reading claims back...");
    const after = await repo.listClaims(subjectKind, subjectId);
    console.log(`  total after release: ${after.length}`);
    assert(after.length === 1, `expected total 2 -> 1, got ${after.length}`);
    assert(
      after[0]?.actorId === actorB,
      `the surviving claim must be B's, got ${after[0]?.actorId}`
    );
    assert(
      !after.some((c) => c.actorId === actorA),
      "A's claim must be gone immediately, not lingering until TTL"
    );
    console.log(`  survivor: ${after[0]?.actorId}`);
    results.totalAfter = after.length;
    results.survivor = after[0]?.actorId;

    console.log("\n[smoke-claims-release] PASS");
    console.log(JSON.stringify(results, null, 2));
  } finally {
    // Always clean up the synthetic subject, including on assertion failure.
    const deleted = await repo.deleteBySubject(subjectKind, subjectId);
    console.log(`[smoke-claims-release] cleanup: removed ${deleted} row(s) for ${subjectId}`);
    await client.end();
  }
}

main().catch((err) => {
  console.error("[smoke-claims-release] FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
