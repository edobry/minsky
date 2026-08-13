#!/usr/bin/env bun
/**
 * Backtest the mt#3959 stale-signal sweep over recently-merged PRs (SC4).
 *
 * Answers the question a calibration ladder needs answered BEFORE any blocking
 * tier: how often would this guard have fired, and on what?
 *
 * ## What this measures, and what it cannot
 *
 * It replays the LABEL EXTRACTION over historical merge commits exactly as the
 * guard would have seen them — that half is faithful, because the diff is
 * immutable.
 *
 * The CORPUS half is not. The sweep greps the corpus as it stands TODAY, not as
 * it stood when each PR merged: specs have since been written, closed, and
 * edited. So a match here is evidence that the label is quoted SOMEWHERE
 * durable, not proof the guard would have reported that same artifact at the
 * time. This is the same contamination shape mem#874 records for live-index
 * evaluation, and it is why the output labels itself `indicative` rather than
 * `measured`. Read the fire COUNT as sound and the per-match attribution as
 * approximate.
 *
 * ## Usage
 *
 *   bun scripts/backtest-stale-signal-sweep.ts [--days 60] [--limit 400] [--json]
 *
 * Read-only: runs `git log`/`git show` and SELECT queries. Mutates nothing.
 */

// Must precede any import that reaches tsyringe (the persistence factory does).
import "reflect-metadata";
import { extractChangedOutputLabels } from "../.minsky/hooks/output-label-tokens";

interface Args {
  days: number;
  limit: number;
  json: boolean;
  includeTerminal: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { days: 60, limit: 400, json: false, includeTerminal: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") out.days = Number.parseInt(argv[++i] ?? "60", 10);
    else if (a === "--limit") out.limit = Number.parseInt(argv[++i] ?? "400", 10);
    else if (a === "--json") out.json = true;
    else if (a === "--include-terminal") out.includeTerminal = true;
  }
  return out;
}

async function sh(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

interface Fire {
  readonly commit: string;
  readonly subject: string;
  readonly labels: string[];
  readonly quotedBy: string[];
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));

  // Merge commits carry the PR boundary; `--first-parent` keeps one entry per
  // merged PR rather than every commit inside it.
  const log = await sh([
    "git",
    "log",
    "--first-parent",
    `--since=${args.days} days ago`,
    `--max-count=${args.limit}`,
    "--format=%H%x1f%s",
  ]);

  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash, subject] = l.split("\x1f");
      return { hash: hash ?? "", subject: subject ?? "" };
    })
    .filter((c) => c.hash);

  if (commits.length === 0) {
    console.error("No commits in range — nothing to backtest.");
    process.exit(2);
  }

  const { initializeConfiguration, CustomConfigFactory } = await import(
    "../packages/domain/src/configuration/index"
  );
  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

  const { resolvePersistenceProviderOrError } = await import(
    "../packages/domain/src/persistence/factory"
  );
  const resolution = await resolvePersistenceProviderOrError();
  if (!resolution.ok) {
    console.error("Persistence unavailable — cannot run the corpus half.");
    process.exit(2);
  }
  const provider = resolution.provider;
  if (!provider.capabilities.sql || typeof provider.getDatabaseConnection !== "function") {
    console.error(`Provider ${provider.constructor.name} is not SQL-capable.`);
    process.exit(2);
  }
  const db = (await provider.getDatabaseConnection()) as {
    execute: (q: unknown) => Promise<unknown>;
  };
  const { sql } = await import("drizzle-orm");
  const { TERMINAL_TASK_STATUSES } = await import("../.minsky/hooks/task-statuses");
  const terminal = [...TERMINAL_TASK_STATUSES];

  const fires: Fire[] = [];
  let evaluated = 0;
  let withLabels = 0;

  for (const c of commits) {
    evaluated++;
    const diff = await sh(["git", "show", "--first-parent", "--unified=3", c.hash]);
    const labels = extractChangedOutputLabels(diff);
    if (labels.length === 0) continue;
    withLabels++;

    const quotedBy: string[] = [];
    for (const label of [...new Set(labels.map((l) => l.text))]) {
      const pattern = `%${label.replace(/([\\%_])/g, "\\$1")}%`;
      // ACTIVE tasks only — the same scope the guard applies (PR #2974 R1).
      // Scanning every spec including terminal ones measures a different
      // surface than the mechanism being calibrated, so the resulting fire rate
      // would not be the guard's fire rate. Terminal set imported from the same
      // domain registry the guard reads, rather than hardcoded here.
      //
      // `--include-terminal` relaxes it for ONE purpose: replaying a historical
      // case whose artifacts have since been closed. mt#3911's PR would have
      // surfaced mt#3902 — active on 2026-08-10, DONE now — so an active-only
      // replay today cannot reproduce that fire. The flag makes the historical
      // view reachable without pretending it is the guard's live scope.
      const statusClause = args.includeTerminal
        ? sql``
        : sql`and t.status::text not in ${terminal}`;
      const rows = await db.execute(sql`
        select t.id as id from tasks t
        join task_specs s on s.task_id = t.id
        where s.content like ${pattern} escape '\\'
        ${statusClause}
        limit 6
      `);
      for (const r of Array.isArray(rows) ? rows : []) {
        const id = (r as Record<string, unknown>)["id"];
        // Self-matches are KEPT — see the sweep module's note. mt#3911's own
        // spec carried the originating mystery, and SC3 names it explicitly.
        if (typeof id === "string") quotedBy.push(`${label} -> ${id}`);
      }
    }
    if (quotedBy.length > 0) {
      fires.push({
        commit: c.hash.slice(0, 9),
        subject: c.subject.slice(0, 90),
        labels: [...new Set(labels.map((l) => l.text))],
        quotedBy,
      });
    }
  }

  const summary = {
    windowDays: args.days,
    commitsEvaluated: evaluated,
    commitsDroppingALabel: withLabels,
    commitsThatWouldFire: fires.length,
    fireRatePercent: evaluated === 0 ? 0 : Math.round((fires.length / evaluated) * 1000) / 10,
    confidence: "indicative — corpus is read as of today, not as of each merge (see header)",
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, fires }, null, 2));
    return;
  }

  console.log(`\nStale-signal sweep backtest — last ${args.days} days\n`);
  console.log(`  commits evaluated:        ${summary.commitsEvaluated}`);
  console.log(`  dropped an output label:  ${summary.commitsDroppingALabel}`);
  console.log(`  would have FIRED:         ${summary.commitsThatWouldFire}`);
  console.log(`  fire rate:                ${summary.fireRatePercent}%`);
  console.log(`  confidence:               ${summary.confidence}\n`);
  if (fires.length > 0) {
    console.log("Sample (hand-classify these):\n");
    for (const f of fires.slice(0, 15)) {
      console.log(`  ${f.commit}  ${f.subject}`);
      console.log(`      labels: ${f.labels.join(", ")}`);
      for (const q of f.quotedBy.slice(0, 4)) console.log(`      ${q}`);
      console.log("");
    }
    if (fires.length > 15) console.log(`  ... and ${fires.length - 15} more (use --json)\n`);
  }
}

await main();
