#!/usr/bin/env bun
/**
 * Smoke test for the presence claims substrate (mt#2562).
 *
 * Exercises the full upsert → list → reap lifecycle against the real Postgres DB.
 * Env-gated: skips gracefully when DATABASE_URL is absent.
 *
 * Usage:
 *   DATABASE_URL=postgres://... bun scripts/smoke-presence-claims.ts
 */

import "reflect-metadata";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log("[smoke-presence-claims] DATABASE_URL not set — skipping smoke test");
    process.exit(0);
  }

  console.log("[smoke-presence-claims] Starting presence claims smoke test...");

  // Dynamically import to avoid tsyringe side-effects at module load
  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { DrizzlePresenceClaimRepository } = await import(
    "../packages/domain/src/presence/repository"
  );

  const client = postgres(dbUrl, { max: 1 });
  const db = drizzle(client);
  const repo = new DrizzlePresenceClaimRepository(db);

  const subjectKind = "task" as const;
  const subjectId = `smoke-test-${Date.now()}`;
  const actorId = "smoke-actor-1";
  const actor2Id = "smoke-actor-2";

  // ── 1. Upsert insert ─────────────────────────────────────────────────────
  console.log("[smoke-presence-claims] 1. Upserting first claim (insert)...");
  const claim1 = await repo.upsertClaim({
    subjectKind,
    subjectId,
    actorId,
    ccConversationId: "conv-smoke-test",
    host: "smoke-host",
  });
  console.log("  claimed_at:", claim1.claimedAt);
  console.log("  last_refreshed_at:", claim1.lastRefreshedAt);
  if (!claim1.id) throw new Error("Expected claim to have an id");

  // ── 2. Upsert refresh (same actor — must not create a duplicate) ──────────
  console.log("[smoke-presence-claims] 2. Upserting again (refresh — same actor)...");
  await new Promise((r) => setTimeout(r, 50));
  const claim1b = await repo.upsertClaim({
    subjectKind,
    subjectId,
    actorId,
    ccConversationId: "conv-smoke-test-refreshed",
  });
  if (claim1b.claimedAt !== claim1.claimedAt) {
    throw new Error(
      `claimedAt changed on refresh: was ${claim1.claimedAt}, now ${claim1b.claimedAt}`
    );
  }
  if (claim1b.ccConversationId !== "conv-smoke-test-refreshed") {
    throw new Error(`ccConversationId not updated on refresh`);
  }
  console.log("  OK: claimedAt unchanged, ccConversationId updated");

  // ── 3. Multi-actor set ────────────────────────────────────────────────────
  console.log("[smoke-presence-claims] 3. Upserting second actor...");
  await repo.upsertClaim({
    subjectKind,
    subjectId,
    actorId: actor2Id,
    host: "smoke-host-2",
  });

  // ── 4. listClaims ─────────────────────────────────────────────────────────
  console.log("[smoke-presence-claims] 4. Listing claims...");
  const listed = await repo.listClaims(subjectKind, subjectId);
  if (listed.length < 2) {
    throw new Error(`Expected at least 2 claims, got ${listed.length}`);
  }
  const actorIds = listed.map((c) => c.actorId).sort();
  if (!actorIds.includes(actorId) || !actorIds.includes(actor2Id)) {
    throw new Error(`Expected both actors in claim list: ${JSON.stringify(actorIds)}`);
  }
  const freshCount = listed.filter((c) => !c.stale).length;
  console.log(`  OK: ${listed.length} claims (${freshCount} fresh)`);

  // ── 5. reapStale ──────────────────────────────────────────────────────────
  // Reap with threshold=0 to force-delete all rows (smoke only)
  console.log("[smoke-presence-claims] 5. Reaping stale (threshold=0 to clean up smoke rows)...");
  const reaped = await repo.reapStale(0);
  console.log(`  Reaped ${reaped} rows`);

  // Verify rows are gone
  const afterReap = await repo.listClaims(subjectKind, subjectId);
  if (afterReap.length !== 0) {
    throw new Error(`Expected 0 claims after reap, got ${afterReap.length}`);
  }
  console.log("  OK: all smoke rows removed");

  await client.end();
  console.log("[smoke-presence-claims] All smoke checks passed.");
}

main().catch((err) => {
  console.error("[smoke-presence-claims] FAILED:", err);
  process.exit(1);
});
