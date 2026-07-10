#!/usr/bin/env bun
/**
 * Smoke / live-verification for mt#2288 + mt#2721 — per-review token + USD cost
 * persistence, including cached-input tokens and the cache discount.
 *
 * Structural change verified (per implement-task §7a): the review_timing schema
 * migrations (0006 token/cost, 0007 cached_tokens) plus the recordReviewTiming
 * write path carry input/output/reasoning/cached tokens + cost_usd; the cockpit
 * widget medians cost via PERCENTILE_CONT and computes a cache-hit ratio.
 *
 * Two tiers:
 *   1. DEFAULT (read-only): assert the new columns exist on review_timing
 *      (information_schema) — confirms migrations applied. Safe against any
 *      database, including production.
 *   2. OPT-IN (SMOKE_TOKEN_COST_WRITE=1): also exercise the full round-trip —
 *      insert a synthetic MARKER-owned row via the real recordReviewTiming writer,
 *      read it back asserting non-null/correct token+cost, run the cockpit median
 *      SQL, then DELETE the marker rows. Point this at a dev/test DB.
 *
 * Gates on a Postgres URL env var (MINSKY_PERSISTENCE_POSTGRES_URL /
 * MINSKY_SESSIONDB_POSTGRES_URL / MINSKY_POSTGRES_URL). Skips gracefully
 * (exit 0, "SKIP") when none is set.
 *
 * Usage:
 *   MINSKY_PERSISTENCE_POSTGRES_URL=postgres://... \
 *     bun services/reviewer/scripts/smoke-token-cost.ts            # read-only
 *   SMOKE_TOKEN_COST_WRITE=1 MINSKY_PERSISTENCE_POSTGRES_URL=... \
 *     bun services/reviewer/scripts/smoke-token-cost.ts            # full round-trip
 */

import postgres from "postgres";
import { createDb } from "../src/db/client";
import { recordReviewTiming } from "../src/review-timing";
import { timingTokenFields } from "../src/token-cost";

const url =
  process.env.MINSKY_PERSISTENCE_POSTGRES_URL ||
  process.env.MINSKY_SESSIONDB_POSTGRES_URL ||
  process.env.MINSKY_POSTGRES_URL;

if (!url) {
  console.log("SKIP: no Postgres URL env var set; skipping token-cost DB smoke.");
  process.exit(0);
}

const MARKER_OWNER = "smoke-mt2288";
const NEW_COLUMNS = [
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cached_tokens",
  "cost_usd",
];
const doWrite = process.env["SMOKE_TOKEN_COST_WRITE"] === "1";

const sql = postgres(url);
let failed = false;
const results: Record<string, unknown> = {};

try {
  // ---- Tier 1 (read-only): migration columns exist ------------------------
  const colRows = await sql`
    SELECT column_name, is_nullable, data_type
    FROM information_schema.columns
    WHERE table_name = 'review_timing' AND column_name = ANY(${NEW_COLUMNS})`;
  const present = new Set(colRows.map((r) => String(r.column_name)));
  results["columnsPresent"] = [...present];
  const missing = NEW_COLUMNS.filter((c) => !present.has(c));
  if (missing.length === 0) {
    console.log(
      `PASS: all ${NEW_COLUMNS.length} token/cost columns present on review_timing (${NEW_COLUMNS.join(", ")})`
    );
  } else {
    console.log(`FAIL: missing columns on review_timing: ${missing.join(", ")}`);
    failed = true;
  }
  const allNullable = colRows.every((r) => String(r.is_nullable) === "YES");
  if (!allNullable) {
    console.log("FAIL: token/cost columns must be NULLABLE (skip paths write NULL)");
    failed = true;
  }

  // ---- Tier 2 (opt-in): full write -> readback -> median -> cleanup --------
  if (doWrite) {
    const db = createDb();
    const fields = timingTokenFields({
      model: "gpt-5",
      usage: {
        promptTokens: 30_000,
        completionTokens: 3_000,
        reasoningTokens: 500,
        cachedTokens: 20_000,
      },
    });
    // gpt-5 with cache: (30000-20000)*1.25 + 20000*0.125 + 3000*10, all /1e6
    //   = (12500 + 2500 + 30000)/1e6 = 0.045
    const prNumber = 990_000 + (Date.now() % 1000);
    await recordReviewTiming(db, {
      prOwner: MARKER_OWNER,
      prRepo: "smoke",
      prNumber,
      headSha: "smoke-head",
      iterationIndex: 1,
      totalWallClockMs: 12_345,
      perRoundLatenciesMs: [12_345],
      timeoutCount: 0,
      retryCount: 0,
      retryOutcomes: [],
      scopeClassification: null,
      toolUseActive: false,
      provider: "openai",
      model: "gpt-5",
      ...fields,
    });

    const rows = await sql`
      SELECT input_tokens, output_tokens, reasoning_tokens, cached_tokens, cost_usd
      FROM review_timing
      WHERE pr_owner = ${MARKER_OWNER} AND pr_number = ${prNumber}
      LIMIT 1`;
    const row = rows[0];
    results["readback"] = row ?? null;
    const roundTripOk =
      !!row &&
      Number(row.input_tokens) === 30_000 &&
      Number(row.output_tokens) === 3_000 &&
      Number(row.reasoning_tokens) === 500 &&
      Number(row.cached_tokens) === 20_000 &&
      row.cost_usd != null &&
      Math.abs(Number(row.cost_usd) - Number(fields.costUsd)) < 1e-6;
    if (!roundTripOk) failed = true;
    const persistedCost = row?.cost_usd != null ? Number(row.cost_usd) : null;
    console.log(
      roundTripOk
        ? `PASS: recordReviewTiming persisted tokens + cost_usd=${persistedCost} (expected ${fields.costUsd})`
        : "FAIL: token/cost round-trip mismatch"
    );

    const medianRows = await sql`
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cost_usd)::numeric AS median_cost
      FROM review_timing
      WHERE cost_usd IS NOT NULL AND pr_owner = ${MARKER_OWNER}`;
    const medianCost = medianRows[0]?.median_cost;
    results["medianCost"] = medianCost ?? null;
    const medianOk = medianCost != null && Number(medianCost) > 0;
    console.log(
      medianOk
        ? `PASS: cockpit median-cost SQL returned ${Number(medianCost)}`
        : "FAIL: median-cost SQL returned null"
    );
    if (!medianOk) failed = true;

    // mt#2721: exercise the cockpit cache-hit-ratio SQL against real PG.
    const cacheRows = await sql`
      SELECT SUM(cached_tokens)::float8 / NULLIF(SUM(input_tokens), 0) AS cache_hit_ratio
      FROM review_timing
      WHERE input_tokens IS NOT NULL AND cached_tokens IS NOT NULL AND pr_owner = ${MARKER_OWNER}`;
    const cacheHit = cacheRows[0]?.cache_hit_ratio;
    results["cacheHitRatio"] = cacheHit ?? null;
    // 20000 cached / 30000 input ≈ 0.6667
    const cacheOk = cacheHit != null && Math.abs(Number(cacheHit) - 20_000 / 30_000) < 1e-6;
    console.log(
      cacheOk
        ? `PASS: cache-hit-ratio SQL returned ${Number(cacheHit).toFixed(4)}`
        : "FAIL: cache-hit-ratio SQL wrong"
    );
    if (!cacheOk) failed = true;

    const deleted = await sql`DELETE FROM review_timing WHERE pr_owner = ${MARKER_OWNER}`;
    console.log(`cleanup: deleted ${deleted.count} synthetic smoke row(s)`);
  } else {
    console.log(
      "INFO: set SMOKE_TOKEN_COST_WRITE=1 to run the full write round-trip (dev/test DB)."
    );
  }
} catch (err) {
  console.error("FAIL: smoke threw:", err instanceof Error ? err.message : String(err));
  failed = true;
} finally {
  await sql.end();
}

console.log(
  JSON.stringify({ ok: !failed, tier: doWrite ? "write" : "read-only", ...results }, null, 2)
);
process.exit(failed ? 1 : 0);
