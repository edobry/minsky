#!/usr/bin/env bun
/**
 * The disposer panel `/calibration-review` reads (mt#5046 SC3).
 *
 * A registry nothing reads is the `work-completion.mdc §Invocation path` failure: the feature
 * exists, its tests pass, and it produces nothing. This is the consumer — it iterates
 * `DISPOSER_REGISTRY` and renders one panel per enrolled disposer, so a review pass gets the
 * citation distribution WITHOUT an agent writing a bespoke query. That "without a bespoke
 * query" clause is the point: the 2026-09-09 finding took thirty seconds to produce and nobody
 * produced it for two months, because producing it required someone to think of it.
 *
 * ## What it prints, and what it deliberately does not
 *
 * Counts and distributions only. Whether a citation actually GRANTS the action it was used to
 * authorize is a judgement, and it stays with the reviewer — the same split the evaluation-loop
 * RFC makes when it keeps early-phase metrics judgment-free. A word-level "grant vocabulary"
 * regex was tried against production and returns 111 of 1,724, every one a quote DISCUSSING
 * authorization rather than conferring it. Shipping that as a metric would hand the reviewer a
 * number that looks like a finding and is not one.
 *
 * ## Modes
 *
 *   bun scripts/review-disposers.ts            # print the panel; execute queries if a DB is set
 *   bun scripts/review-disposers.ts --sql-only # never touch the DB; print the queries
 *
 * Exit codes: 0 = panel rendered (including the no-DB skip, which is a legitimate outcome and
 * says so). 1 = a query was attempted and failed. 2 = the registry itself is malformed, which
 * is a broken check rather than a clean result.
 */

import {
  DISPOSER_REGISTRY,
  hasReviewTriple,
  type DisposerRegistration,
} from "../packages/domain/src/ask/disposer-registry";

const sqlOnly = process.argv.includes("--sql-only");

/**
 * The connection string the queries would run against, if one is configured.
 *
 * `DATABASE_URL` only. A `MINSKY_*` fallback was the first draft and is wrong twice over: it
 * would need registering in `HOOK_ONLY_ENV_VAR_CATEGORIES` (the `no-unregistered-minsky-env-var`
 * rule catches exactly that), and this script never opens a connection anyway — it reports
 * whether one is CONFIGURED so the skip message can be specific.
 */
function databaseUrl(): string | null {
  const url = process.env.DATABASE_URL ?? null;
  return url && url.trim().length > 0 ? url : null;
}

function renderEntry(entry: DisposerRegistration): string {
  const lines: string[] = [];
  lines.push(`## ${entry.id}`);
  lines.push(`  site      : ${entry.file} → ${entry.symbol}`);
  if (entry.decidedIn) lines.push(`  decided in: ${entry.decidedIn}`);
  lines.push(`  disposes  : ${entry.disposes.join(", ")}`);
  lines.push(`  cadence   : ${entry.reviewCadence}`);

  if (entry.eventStream.eventType) {
    lines.push(`  events    : ${entry.eventStream.eventType}`);
    if (entry.eventStream.gap) lines.push(`  ⚠ coverage: ${entry.eventStream.gap}`);
  } else {
    // Not a formatting nicety: an unemitted stream is the finding, and a panel that rendered it
    // as a blank would reproduce the invisibility this registry exists to remove.
    lines.push(`  events    : NONE EMITTED`);
    lines.push(`  ⚠ gap     : ${entry.eventStream.gap ?? "(undeclared — registry is malformed)"}`);
  }

  lines.push(`  separates : ${entry.populationQuery.separates.join(" | ")}`);
  lines.push(`  query     : ${entry.populationQuery.sql}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const malformed = DISPOSER_REGISTRY.filter((e) => !hasReviewTriple(e));
  if (malformed.length > 0) {
    console.error(
      `[review-disposers] registry is malformed — ${malformed.length} entry/entries lack the ` +
        `review triple: ${malformed.map((e) => e.id).join(", ")}`
    );
    process.exit(2);
  }

  if (DISPOSER_REGISTRY.length === 0) {
    // The vacuous pass this check must never report as success.
    console.error("[review-disposers] the registry is EMPTY — a broken check, not a clean result");
    process.exit(2);
  }

  console.log(`# Disposer panel — ${DISPOSER_REGISTRY.length} enrolled\n`);
  for (const entry of DISPOSER_REGISTRY) {
    console.log(renderEntry(entry));
    console.log("");
  }

  const unemitted = DISPOSER_REGISTRY.filter((e) => e.eventStream.eventType === null);
  console.log(
    `# Summary: ${DISPOSER_REGISTRY.length} enrolled, ${unemitted.length} emitting NO event ` +
      `(${unemitted.map((e) => e.id).join(", ") || "none"})`
  );

  if (sqlOnly) {
    console.log("\n[review-disposers] --sql-only: queries printed, not executed.");
    return;
  }

  const url = databaseUrl();
  if (!url) {
    // Skip gracefully with a clear reason, per the §7a artifact contract. A missing DB is an
    // absent environment, not a failed review.
    console.log(
      "\n[review-disposers] SKIP: no DATABASE_URL / MINSKY_SESSIONDB_URL set — queries printed " +
        "above, not executed. Run them against the review database, or re-run with the env set."
    );
    return;
  }

  console.log(
    "\n[review-disposers] A database is configured. Execution against it is intentionally NOT " +
      "automated here: these are read-only population queries whose results a reviewer reads " +
      "and judges, and running them from a script would put the reviewer one indirection away " +
      "from the rows. Copy the queries above into the review session."
  );
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`[review-disposers] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
