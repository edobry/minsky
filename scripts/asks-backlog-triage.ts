#!/usr/bin/env bun
/**
 * One-time triage of the `detected` asks backlog (mt#2265).
 *
 * The asks table accumulated thousands of `detected` rows that nothing ever
 * advanced (3,195 at fix time — see the mt#2265 spec). These are ephemeral
 * authorization/review requests weeks past their moment; routing them now
 * would flood the operator surface with dead questions. This script expires
 * the stale ones (`detected` older than the cutoff) and leaves fresh rows
 * for the advancement sweep to route properly.
 *
 * Usage:
 *   bun scripts/asks-backlog-triage.ts                 # dry-run (default): counts only
 *   bun scripts/asks-backlog-triage.ts --execute       # apply: bulk-expire stale rows
 *   bun scripts/asks-backlog-triage.ts --max-age-days 14   # override the 7-day cutoff
 *
 * Safety:
 *   - Dry-run by default per CLAUDE.md §Operational Safety: Dry-Run First.
 *   - `direction.decide` asks are ALWAYS listed individually and NEVER
 *     bulk-expired — they may still be live questions for the principal.
 *   - Expiry is the `detected → expired` state-machine transition (legal,
 *     terminal); rows are retained, not deleted.
 *
 * Output: human-readable summary + JSON result block on stdout.
 *
 * @see mt#2265, mt#2257 (originating audit), packages/domain/src/ask/advancement.ts
 */

import "reflect-metadata";

import type { AskRepository } from "@minsky/domain/ask/repository";
import type { Ask } from "@minsky/domain/ask/types";

const DEFAULT_MAX_AGE_DAYS = 7;

async function buildAskRepository(): Promise<AskRepository> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
  const { DrizzleAskRepository } = await import("@minsky/domain/ask/repository");

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!persistence || !(persistence instanceof PersistenceProvider)) {
    throw new Error("Triage requires a SQL-capable persistence provider (Postgres).");
  }
  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    throw new Error("Triage requires a SQL-capable persistence provider (Postgres).");
  }

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("Triage requires an initialized Postgres database connection.");
  }

  return new DrizzleAskRepository(connection);
}

function ageDays(ask: Ask, nowMs: number): number {
  return (nowMs - new Date(ask.createdAt).getTime()) / (24 * 60 * 60 * 1000);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const maxAgeFlagIdx = argv.indexOf("--max-age-days");
  const maxAgeDays =
    maxAgeFlagIdx >= 0 && argv[maxAgeFlagIdx + 1]
      ? parseFloat(argv[maxAgeFlagIdx + 1] as string)
      : DEFAULT_MAX_AGE_DAYS;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    console.error(`Invalid --max-age-days: must be a positive number`);
    process.exit(1);
  }

  const repo = await buildAskRepository();
  const nowMs = Date.now();

  const detected = await repo.listByState("detected");

  const stale = detected.filter(
    (a) => a.kind !== "direction.decide" && ageDays(a, nowMs) > maxAgeDays
  );
  const fresh = detected.filter(
    (a) => a.kind !== "direction.decide" && ageDays(a, nowMs) <= maxAgeDays
  );
  const directionDecide = detected.filter((a) => a.kind === "direction.decide");

  // Counts by kind for the stale set
  const staleByKind = new Map<string, number>();
  for (const a of stale) {
    staleByKind.set(a.kind, (staleByKind.get(a.kind) ?? 0) + 1);
  }

  console.log(`asks-backlog-triage ${execute ? "(EXECUTE)" : "(dry-run)"}`);
  console.log(`  cutoff: detected asks older than ${maxAgeDays} days`);
  console.log(`  detected total:        ${detected.length}`);
  console.log(`  stale (would expire):  ${stale.length}`);
  for (const [kind, count] of staleByKind) {
    console.log(`    ${kind}: ${count}`);
  }
  console.log(`  fresh (left for sweep): ${fresh.length}`);
  console.log(`  direction.decide (never bulk-expired): ${directionDecide.length}`);
  for (const a of directionDecide) {
    console.log(
      `    ${a.id}  created=${a.createdAt}  age=${ageDays(a, nowMs).toFixed(1)}d  "${a.title}"`
    );
  }

  let expired = 0;
  const errors: Array<{ askId: string; message: string }> = [];

  if (execute) {
    for (const a of stale) {
      try {
        await repo.persistRouteOutcome(a.id, { state: "expired" });
        expired += 1;
      } catch (err) {
        errors.push({ askId: a.id, message: err instanceof Error ? err.message : String(err) });
      }
    }
    console.log(`  expired: ${expired}/${stale.length} (${errors.length} errors)`);
    for (const e of errors.slice(0, 10)) {
      console.log(`    error ${e.askId}: ${e.message}`);
    }
  } else {
    console.log(`  (no changes applied — re-run with --execute to expire the stale set)`);
  }

  const result = {
    mode: execute ? "execute" : "dry-run",
    maxAgeDays,
    detectedTotal: detected.length,
    staleCount: stale.length,
    staleByKind: Object.fromEntries(staleByKind),
    freshCount: fresh.length,
    directionDecideCount: directionDecide.length,
    expired,
    errorCount: errors.length,
  };
  console.log(JSON.stringify(result));

  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`asks-backlog-triage failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
