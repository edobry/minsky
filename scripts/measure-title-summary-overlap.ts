#!/usr/bin/env bun
/**
 * mt#5044 SC1 — measure how often a task's title and its `## Summary` describe different subjects.
 *
 * ## What question this answers
 *
 * mt#5044 proposes a create-seam check comparing a task's `title` against its spec's `## Summary`.
 * The evidence for that check is n=2 (mem#578's R1, and mt#5042's mistitle), which is not a rate.
 * SC1 requires this measurement BEFORE any matcher is written, and SC5 makes **"measured, too rare
 * to mechanize" an explicit valid close** — so this script is designed to be capable of killing
 * the task it belongs to, not just of sizing it.
 *
 * It is not a hook and is wired into nothing.
 *
 * ## Reading the output
 *
 * `coverage` is the share of the TITLE's content words that the Summary also uses — asymmetric on
 * purpose, see `scripts/lib/title-summary-overlap.ts`. Low coverage means the title spends its
 * words on something the Summary does not discuss.
 *
 * **A low score is a CANDIDATE, not a defect.** A terse title over a long Summary can score low
 * legitimately, and no lexical measure decides which it is. So the script prints the lowest-scoring
 * pairs for a human to label, and SC1's number is a HAND-CLASSIFIED rate — a script cannot hand it
 * to you unlabeled. The histogram sizes the review; the labels produce the finding.
 *
 * ## Egress
 *
 * Reads task rows from the project's own Postgres via the configured persistence provider, and
 * writes to **stdout only**. Enumerated: no file is written, no network call is made beyond that
 * database connection, no subprocess is spawned, and no third-party SDK is involved. In
 * particular this measure is LEXICAL and deliberately does NOT embed anything — no spec text is
 * sent to an embedding provider or any other third party (mem#1056). Titles and Summary excerpts
 * printed to stdout come from the operator's own task corpus.
 *
 * ## Usage
 *
 *   bun scripts/measure-title-summary-overlap.ts
 *   bun scripts/measure-title-summary-overlap.ts --show 40
 *   bun scripts/measure-title-summary-overlap.ts --threshold 0.25
 *   bun scripts/measure-title-summary-overlap.ts --show 20 --summaries
 *   bun scripts/measure-title-summary-overlap.ts --json
 *
 * `--summaries` prints each listed pair's Summary text, which is what makes the hand
 * classification reproducible by someone other than its author.
 *
 * Exit 0 = measured. Exit 1 = a malformed argument, or the corpus could not be fetched.
 * Exit 2 = the fetch succeeded but returned nothing, which means the query is wrong rather than
 * the corpus being empty — never conflated with a clean measurement.
 *
 * @see mt#5044, scripts/lib/title-summary-overlap.ts, mem#578
 */

import "reflect-metadata";

import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";

import { MT5042_TASK_ID, MT5042_WRONG_TITLE } from "./lib/mt5042-fixture";
import { extractSummary, overlapReport, type OverlapReport } from "./lib/title-summary-overlap";

/** Default number of lowest-scoring pairs to print for hand classification. */
const DEFAULT_SHOW = 25;

/**
 * Default coverage below which a pair is counted as a candidate.
 *
 * Chosen from the fixture rather than as a round number: mt#5042's real mistitle scores ~0.15 and
 * its correction ~0.79 over the same spec, so any cut in the wide gap between them separates the
 * known case. 0.25 sits just above the known positive, which biases toward a LARGER review set —
 * the safe direction when the whole point is to hand-classify. It is a reporting default, not a
 * shipped threshold; SC1 exists to decide where a threshold would sit, and this script prints the
 * full histogram so the choice is visible rather than baked in.
 */
const DEFAULT_THRESHOLD = 0.25;

interface Args {
  readonly show: number;
  readonly threshold: number;
  readonly json: boolean;
  /** Print each listed pair's Summary text, so the hand-classification SC1 requires is doable here. */
  readonly summaries: boolean;
  /**
   * Which text the title is compared against.
   *
   * mt#5044's SC2 names `## Summary`, but that was an authoring assumption rather than a measured
   * choice — so the alternative is measured here rather than asserted away. `spec` compares the
   * title against the WHOLE spec body, which is the natural repair if the Summary-only false
   * positives turn out to be summaries that discuss provenance while later sections carry the
   * subject.
   */
  readonly against: "summary" | "spec";
}

interface SpecRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly content: string;
}

interface Measured extends OverlapReport {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly summaryLength: number;
  readonly summaryText: string;
}

function fail(message: string, code = 1): never {
  process.stderr.write(`[measure-title-summary-overlap] ${message}\n`);
  process.exit(code);
}

function parseArgs(argv: readonly string[]): Args {
  let show = DEFAULT_SHOW;
  let threshold = DEFAULT_THRESHOLD;
  let json = false;
  let summaries = false;
  let against: "summary" | "spec" = "summary";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--summaries") {
      summaries = true;
    } else if (arg === "--against") {
      const value = argv[++i];
      if (value !== "summary" && value !== "spec") fail(`--against needs "summary" or "spec"`);
      against = value;
    } else if (arg === "--show") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) fail(`--show needs a non-negative integer`);
      show = value;
    } else if (arg === "--threshold") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0 || value > 1)
        fail(`--threshold needs a 0..1 number`);
      threshold = value;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return { show, threshold, json, summaries, against };
}

/** A driver row is external input: narrow it with a runtime guard rather than an assertion. */
function isSpecRow(row: unknown): row is SpecRow {
  if (row === null || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.title === "string" &&
    typeof r.status === "string" &&
    typeof r.content === "string"
  );
}

/**
 * Read every task that has a spec.
 *
 * Bootstrapped exactly as `scripts/asks-backlog-triage.ts` does — the established script-side
 * pattern for reaching a SQL-capable provider. One query rather than the CLI's one-subprocess-
 * per-spec loop, because the corpus is the whole task table.
 */
async function fetchSpecRows(): Promise<SpecRow[]> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
  const { sql } = await import("drizzle-orm");

  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!persistence || !(persistence instanceof PersistenceProvider)) {
    fail("this measurement requires a SQL-capable persistence provider (Postgres)");
  }
  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    fail("this measurement requires a SQL-capable persistence provider (Postgres)");
  }

  const db = await (persistence as SqlCapablePersistenceProvider).getDatabaseConnection();
  if (!db) fail("this measurement requires an initialized Postgres connection");

  const rows = await db.execute(sql`
    select t.id as id, t.title as title, t.status::text as status, s.content as content
    from tasks t
    join task_specs s on s.task_id = t.id
  `);

  // Widened to `unknown[]` before filtering so the type predicate does the narrowing. The driver
  // types its result as `Record<string, unknown>[]`, which the predicate cannot narrow in place.
  const candidates: unknown[] = Array.isArray(rows) ? rows : [];
  return candidates.filter(isSpecRow);
}

/** Ten equal buckets over [0, 1]; the last bucket is closed so coverage 1.0 lands in it. */
function histogram(values: readonly number[]): number[] {
  const buckets = new Array(10).fill(0) as number[];
  for (const value of values) {
    const index = Math.min(9, Math.floor(value * 10));
    buckets[index] = (buckets[index] ?? 0) + 1;
  }
  return buckets;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const rows = await fetchSpecRows();
  if (rows.length === 0) {
    fail("the query succeeded but returned no task specs — the query is probably wrong", 2);
  }

  const measured: Measured[] = [];
  const withoutSummary: { id: string; title: string }[] = [];
  const emptySummary: { id: string; title: string }[] = [];

  for (const row of rows) {
    const summary = extractSummary(row.content);
    if (summary === null) {
      // Outside the population, not a zero-scoring member of it — AT4's case.
      withoutSummary.push({ id: row.id, title: row.title });
      continue;
    }
    if (summary.trim() === "") {
      // ALSO outside the population, and this one is easy to get wrong: a present-but-empty
      // Summary scores 0 by construction, so leaving it in manufactures the exact finding this
      // measurement is looking for. Observed in the first run — five of the twenty lowest pairs
      // were empty Summaries, none of them a title/spec disagreement. Counting them would have
      // inflated the candidate rate with a different defect entirely.
      emptySummary.push({ id: row.id, title: row.title });
      continue;
    }
    // The Summary decides MEMBERSHIP either way — a spec with no Summary stays outside the
    // population under both modes, so the two runs are comparable over the same denominator.
    const comparisonText = args.against === "spec" ? row.content : summary;
    measured.push({
      id: row.id,
      title: row.title,
      status: row.status,
      summaryLength: summary.length,
      summaryText: summary,
      ...overlapReport(row.title, comparisonText),
    });
  }

  measured.sort((a, b) => a.coverage - b.coverage);
  const belowThreshold = measured.filter((m) => m.coverage < args.threshold);
  const buckets = histogram(measured.map((m) => m.coverage));

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          task: "mt#5044",
          corpusRows: rows.length,
          measured: measured.length,
          withoutSummary: withoutSummary.length,
          emptySummary: emptySummary.length,
          threshold: args.threshold,
          belowThreshold: belowThreshold.length,
          histogram: buckets,
          lowest: measured.slice(0, args.show),
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const againstLabel = args.against === "spec" ? "the WHOLE spec body" : "`## Summary`";
  process.stdout.write(`mt#5044 SC1 — title vs ${againstLabel} content overlap\n\n`);
  process.stdout.write(`Task specs read:            ${rows.length}\n`);
  process.stdout.write(`  measured:                 ${measured.length}\n`);
  process.stdout.write(
    `  no \`## Summary\` section:  ${withoutSummary.length}   <- excluded: outside the population\n`
  );
  process.stdout.write(
    `  \`## Summary\` present but empty: ${emptySummary.length}   <- excluded: scores 0 by construction, a DIFFERENT defect\n\n`
  );

  process.stdout.write(`Coverage distribution (share of title words the Summary also uses):\n`);
  for (let i = 0; i < buckets.length; i++) {
    const lo = (i / 10).toFixed(1);
    const hi = ((i + 1) / 10).toFixed(1);
    const count = buckets[i] ?? 0;
    const share = measured.length === 0 ? 0 : (count / measured.length) * 100;
    const bar = "#".repeat(Math.round(share / 2));
    process.stdout.write(
      `  ${lo}-${hi}  ${String(count).padStart(5)}  ${share.toFixed(1).padStart(5)}%  ${bar}\n`
    );
  }

  const pct =
    measured.length === 0 ? 0 : ((belowThreshold.length / measured.length) * 100).toFixed(2);
  process.stdout.write(
    `\nBelow ${args.threshold}: ${belowThreshold.length} of ${measured.length} (${pct}%)\n`
  );
  process.stdout.write(
    `\nThese are CANDIDATES requiring hand classification, not defects. ` +
      `A terse title over a long\nSummary scores low legitimately; no lexical measure tells the two apart.\n`
  );

  // The decision this measurement exists to make turns on ONE number: to catch the single known
  // true positive, how many other specs must a threshold also flag? Scoring the known-bad title
  // against the spec it was actually filed over answers it directly, against this corpus, with no
  // threshold chosen in advance.
  const fixtureRow = rows.find((r) => r.id === MT5042_TASK_ID);
  const fixtureSummary = fixtureRow ? extractSummary(fixtureRow.content) : null;
  if (fixtureSummary !== null && fixtureSummary.trim() !== "") {
    const fixture = overlapReport(
      MT5042_WRONG_TITLE,
      args.against === "spec" ? (fixtureRow?.content ?? fixtureSummary) : fixtureSummary
    );
    const atOrBelow = measured.filter((m) => m.coverage <= fixture.coverage).length;
    const share = measured.length === 0 ? 0 : (atOrBelow / measured.length) * 100;
    process.stdout.write(
      `\nKnown true positive (${MT5042_TASK_ID}'s original title over its own spec): ` +
        `coverage ${fixture.coverage.toFixed(3)}\n`
    );
    process.stdout.write(
      `  Specs scoring at or below it: ${atOrBelow} of ${measured.length} (${share.toFixed(2)}%)\n`
    );
    process.stdout.write(
      `  So a threshold set to catch this one case also flags the other ${atOrBelow - 1}.\n` +
        `  Precision ceiling = 1 / ${atOrBelow} unless those are also true positives — which is\n` +
        `  what the hand classification above decides.\n`
    );
  } else {
    process.stdout.write(
      `\nKnown true positive ${MT5042_TASK_ID} not found in the corpus (or has no Summary) — ` +
        `the precision\n  estimate below could not be computed. Do NOT read its absence as a clean result.\n`
    );
  }

  process.stdout.write(`\nLowest ${Math.min(args.show, measured.length)} for labeling:\n\n`);
  for (const m of measured.slice(0, args.show)) {
    process.stdout.write(
      `  ${m.coverage.toFixed(3)}  ${m.id}  [${m.status}]  (summary ${m.summaryLength}c)\n`
    );
    process.stdout.write(`    title:   ${m.title}\n`);
    process.stdout.write(`    missing: ${m.missingTokens.join(", ") || "(none)"}\n`);
    process.stdout.write(`    shared:  ${m.sharedTokens.join(", ") || "(none)"}\n`);
    if (args.summaries) {
      const flattened = m.summaryText.replace(/\s+/g, " ").trim();
      process.stdout.write(`    summary: ${flattened.slice(0, 600)}\n`);
    }
    process.stdout.write("\n");
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
  });
}
