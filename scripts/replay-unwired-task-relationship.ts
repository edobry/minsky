#!/usr/bin/env bun
/**
 * Measure `warn-unwired-task-relationship`'s RECOGNITION half against the real
 * task-spec corpus, before deciding whether it may inject (mt#2264).
 *
 * ## Why this exists
 *
 * The guard's discharge half is exact — a field on the call at `tasks_create`, a
 * row in `task_relationships` at the edit seams — so its precision is bounded
 * entirely by whether the phrase matcher recognizes an ASSERTION rather than a
 * mention. That is an empirical question about prose, and ADR-024 sign-off (b)
 * sets the bar it has to clear (0 known false positives) before the advisory is
 * enabled. `INJECTION_ENABLED` stays `false` until this script's sample is
 * hand-classified against that bar.
 *
 * Running the recognizer over specs that already exist is strictly better than
 * shipping it log-only and waiting for fires: the corpus is on disk today, so
 * "what would this have fired on" is a measurement rather than a forecast
 * (mem#1236 — replay a guard's own corpus before designing its fix).
 *
 * ## What it measures, and what it deliberately does not
 *
 * This replays the RECOGNITION half ONLY, against spec TEXT. It does not consult
 * the graph, so a reported fire is "this spec states a relationship", NOT "this
 * spec states one that is unwired". That is the honest scope: recognition is the
 * half whose precision is unknown, and joining it against live edges here would
 * conflate two questions with very different error costs. The discharge half is
 * exercised by the guard's unit tests and by a live dispatcher run.
 *
 * ## Data flow — every egress channel, enumerated
 *
 * Reads task specs from the local database. Writes to **stdout only**: aggregate
 * counts, plus spec EXCERPTS in the sample when `--sample N` asks for them, so a
 * human can classify each fire. Nothing is written to a file, sent over the
 * network, passed to a subprocess, or handed to any third-party SDK — there is
 * no embedding call, no model call, and no upload on any path. The excerpts are
 * operator data, so redirect stdout deliberately if you keep the output
 * (`claim-confidence.mdc §The same bound runs in the POSITIVE direction`, whose
 * incident was a script whose docblock was true of stdout and false of the
 * network).
 *
 * ## Usage
 *
 *   bun scripts/replay-unwired-task-relationship.ts             # counts only
 *   bun scripts/replay-unwired-task-relationship.ts --sample 20 # + 20 fires to classify
 *   bun scripts/replay-unwired-task-relationship.ts --limit 500 # cap specs scanned
 *
 * Read-only: it opens no write path at all.
 *
 * @see mt#2264 · mem#530 (family root) · mem#1236 (the replay technique)
 * @see docs/architecture/hooks/warn-unwired-task-relationship.md
 */

import {
  findRelationshipAssertions,
  type RelationshipAssertion,
} from "../.minsky/hooks/warn-unwired-task-relationship";

interface SpecRow {
  readonly taskId: string;
  readonly content: string;
}

/** Parse `--flag N` without pulling in an arg library for three options. */
function numericFlag(argv: readonly string[], name: string): number | null {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const raw = argv[i + 1];
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function loadSpecs(limit: number | null): Promise<SpecRow[]> {
  const { ensureHookDomainBootstrap, describeProviderResolutionFailure } = await import(
    "../.minsky/hooks/domain-bootstrap"
  );
  const bootstrap = await ensureHookDomainBootstrap();
  if (!bootstrap.ok) throw new Error(`domain bootstrap failed: ${bootstrap.error}`);

  const { resolvePersistenceProviderOrError } = await import(
    "../packages/domain/src/persistence/factory"
  );
  const resolution = await resolvePersistenceProviderOrError();
  if (!resolution.ok) throw new Error(describeProviderResolutionFailure(resolution));

  const provider = resolution.provider;
  if (!provider.capabilities.sql || typeof provider.getDatabaseConnection !== "function") {
    throw new Error(`provider ${provider.constructor.name} is not SQL-capable`);
  }
  const db = (await provider.getDatabaseConnection()) as {
    execute: (q: unknown) => Promise<unknown>;
  } | null;
  if (!db) throw new Error("no database connection");

  const { sql } = await import("drizzle-orm");
  const query =
    limit === null
      ? sql`SELECT task_id, content FROM task_specs`
      : sql`SELECT task_id, content FROM task_specs LIMIT ${limit}`;
  const rows = await db.execute(query);

  const list: Array<Record<string, unknown>> = Array.isArray(rows)
    ? (rows as Array<Record<string, unknown>>)
    : Array.isArray((rows as { rows?: unknown }).rows)
      ? (rows as { rows: Array<Record<string, unknown>> }).rows
      : [];

  const specs: SpecRow[] = [];
  for (const row of list) {
    const taskId = row["task_id"];
    const content = row["content"];
    if (typeof taskId === "string" && typeof content === "string") specs.push({ taskId, content });
  }
  return specs;
}

/**
 * One line of context around an assertion, so a classifier can read it in situ.
 *
 * Windows by CODE POINT, not by UTF-16 unit. Spec prose is not known-ASCII — em
 * dashes and the occasional emoji are routine — and a bare `.slice` can cut a
 * surrogate pair in half, printing a replacement character exactly where the
 * classifier is trying to read (`custom/no-unsafe-string-truncation`). The
 * shared `safeTruncate` helper handles head/tail truncation; this needs a
 * two-ended window around an offset, which it does not cover.
 */
function excerptAround(text: string, assertion: RelationshipAssertion): string {
  const points = Array.from(text);
  const idx = text.indexOf(assertion.phrase);
  // Convert the UTF-16 offset to a code-point index so the window is aligned to
  // the same units it slices in.
  //
  // The slice below is COUNTED, never rendered: its only use is
  // `Array.from(...).length`. `idx` is an `indexOf` hit on a phrase drawn from
  // `RELATIONSHIP_PHRASES`, all of which are ASCII, so the boundary cannot fall
  // inside a surrogate pair — and even if it did, a lone surrogate and a full
  // pair both count as one element, so the index is unchanged either way.
  // eslint-disable-next-line custom/no-unsafe-string-truncation -- counted, not rendered; see above
  const at = idx === -1 ? 0 : Array.from(text.slice(0, idx)).length;
  const start = Math.max(0, at - 90);
  return points
    .slice(start, at + 110)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const limit = numericFlag(argv, "--limit");
  const sampleSize = numericFlag(argv, "--sample") ?? 0;

  const specs = await loadSpecs(limit);

  let firedSpecs = 0;
  let totalAssertions = 0;
  const byAxis = new Map<string, number>();
  const byPhrase = new Map<string, number>();
  const fires: Array<{ taskId: string; a: RelationshipAssertion; excerpt: string }> = [];

  for (const spec of specs) {
    // `null` owner: the replay measures the recognizer as a create would see
    // it. Passing the spec's own id would ALSO exercise self-exclusion, which
    // is exact and separately tested — including it here would suppress fires
    // for a reason unrelated to the half being measured.
    const found = findRelationshipAssertions(spec.content, null);
    if (found.length === 0) continue;
    firedSpecs += 1;
    totalAssertions += found.length;
    for (const a of found) {
      byAxis.set(a.axis, (byAxis.get(a.axis) ?? 0) + 1);
      const key = a.phrase.toLowerCase().replace(/\s+/g, " ");
      byPhrase.set(key, (byPhrase.get(key) ?? 0) + 1);
      if (fires.length < sampleSize) {
        fires.push({ taskId: spec.taskId, a, excerpt: excerptAround(spec.content, a) });
      }
    }
  }

  const pct = specs.length === 0 ? 0 : (firedSpecs / specs.length) * 100;
  console.log(`specs scanned:      ${specs.length}`);
  console.log(`specs with a fire:  ${firedSpecs} (${pct.toFixed(1)}%)`);
  console.log(`assertions found:   ${totalAssertions}`);
  console.log("");
  console.log("by axis:");
  for (const [axis, n] of [...byAxis].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${axis.padEnd(14)} ${n}`);
  }
  console.log("");
  console.log("by phrase:");
  for (const [phrase, n] of [...byPhrase].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${phrase.padEnd(24)} ${n}`);
  }

  if (fires.length > 0) {
    console.log("");
    console.log(`sample (${fires.length}) — classify each as ASSERTION or MENTION:`);
    for (const f of fires) {
      console.log("");
      console.log(`  ${f.taskId}  [${f.a.axis}] "${f.a.phrase}" -> ${f.a.taskId}`);
      console.log(`    ...${f.excerpt}...`);
    }
  }
}

await main();
