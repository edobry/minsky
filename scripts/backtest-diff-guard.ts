#!/usr/bin/env bun
/**
 * Backtest a diff-shaped guard over merged commits (mt#4134).
 *
 * Answers the question a calibration ladder needs answered BEFORE any blocking
 * tier: how often would this guard have fired, and on what?
 *
 * Supersedes `scripts/backtest-stale-signal-sweep.ts` (mt#3959), which was
 * welded to one guard — it called `extractChangedOutputLabels` directly and ran
 * label-token corpus queries inline, so the sibling guard mt#3913 shipped with
 * its false-positive posture unmeasured. The commit walking, diff fetching,
 * window accounting and reporting now live in `./lib/diff-guard-backtest`; a
 * guard contributes only its pure core plus whatever corpus half it needs.
 *
 * ## Usage
 *
 *   bun scripts/backtest-diff-guard.ts --guard <name> [--rev-range <a>^..<b>]
 *                                      [--days 60] [--limit 400] [--json]
 *                                      [--include-terminal]
 *
 * Prefer `--rev-range` for any figure you intend to publish: `--days`/`--limit`
 * are relative to the run, so a number taken with them cannot be re-derived once
 * the repo moves on. The report names the ceiling that actually bound the walk.
 *
 * Read-only: runs `git log`/`git show`/`git rev-list` and SELECT queries.
 */

// Must precede any import that reaches tsyringe (the persistence factory does).
import "reflect-metadata";
import { extractChangedOutputLabels } from "../.minsky/hooks/output-label-tokens";
import { escapeLike } from "../.minsky/hooks/stale-signal-sweep";
import {
  findUnrenderedResultFields,
  type UnrenderedField,
} from "../.minsky/hooks/unrendered-result-fields";
import {
  formatReport,
  runDiffGuardBacktest,
  type BacktestDeps,
  type CommitSelection,
  type DiffGuardAdapter,
} from "./lib/diff-guard-backtest";

const DEFAULT_DAYS = 60;
const DEFAULT_LIMIT = 400;
const MAX_ARTIFACTS_PER_LABEL = 6;
const MAX_QUOTES_SHOWN = 4;

interface Args extends CommitSelection {
  readonly guard: string;
  readonly json: boolean;
  readonly includeTerminal: boolean;
}

/**
 * A positive integer, or a thrown error naming the flag (PR #3001 R1).
 *
 * `Number.parseInt("foo")` is `NaN`, which reaches git as `--max-count=NaN` and
 * reaches the report as a `NaN`-valued window description. Both are worse than
 * refusing the input.
 */
function parsePositiveInt(flag: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} expects a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): Args {
  let guard = "";
  let revRange: string | undefined;
  let days = DEFAULT_DAYS;
  let limit = DEFAULT_LIMIT;
  let json = false;
  let includeTerminal = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--guard") guard = argv[++i] ?? "";
    else if (arg === "--rev-range") revRange = argv[++i] ?? undefined;
    else if (arg === "--days") days = parsePositiveInt("--days", argv[++i], DEFAULT_DAYS);
    else if (arg === "--limit") limit = parsePositiveInt("--limit", argv[++i], DEFAULT_LIMIT);
    else if (arg === "--json") json = true;
    else if (arg === "--include-terminal") includeTerminal = true;
  }
  return { guard, revRange, days, limit, json, includeTerminal };
}

const gitDeps: BacktestDeps = {
  // Fails loudly on a non-zero exit (PR #3001 R1). Returning stdout regardless
  // turns a bad `--rev-range`, a missing git, or a repo misconfiguration into an
  // EMPTY walk, which the harness then reports as "No commits in range" — an
  // error rendered as a finding about the repo. Every number this tool prints
  // comes through here, so a swallowed failure is not a local defect.
  runGit: async (args) => {
    const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
    const [text, errText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} exited ${exitCode}: ${errText.trim() || "(no stderr)"}`
      );
    }
    return text;
  },
};

/** A `<label> -> <artifact>` pair: the label, and what still quotes it. */
interface StaleSignalHit {
  readonly label: string;
  readonly artifact: string;
}

/**
 * `stale-signal-sweep` — a branch stopped emitting an operator-facing `<label>=`
 * while durable artifacts still quote it.
 *
 * The corpus half queries ACTIVE task specs only, the same scope the guard
 * applies (PR #2974 R1): scanning terminal specs measures a different surface
 * than the mechanism being calibrated, so the resulting fire rate would not be
 * the guard's fire rate. `--include-terminal` relaxes it for ONE purpose —
 * replaying a historical case whose artifacts have since closed.
 */
function createStaleSignalAdapter(includeTerminal: boolean): DiffGuardAdapter<StaleSignalHit> {
  let db: { execute: (q: unknown) => Promise<unknown> } | null = null;
  let sql: typeof import("drizzle-orm").sql | null = null;
  let terminal: string[] = [];

  return {
    name: "stale-signal-sweep",
    candidateLabel: "dropped an output label:",
    confidence: "indicative — the corpus is read as of today, not as of each merge",

    async setup() {
      const { initializeConfiguration, CustomConfigFactory } = await import(
        "../packages/domain/src/configuration/index"
      );
      await initializeConfiguration(new CustomConfigFactory(), {
        workingDirectory: process.cwd(),
      });

      const { resolvePersistenceProviderOrError } = await import(
        "../packages/domain/src/persistence/factory"
      );
      const resolution = await resolvePersistenceProviderOrError();
      if (!resolution.ok) throw new Error("Persistence unavailable — cannot run the corpus half.");
      const provider = resolution.provider;
      if (!provider.capabilities.sql || typeof provider.getDatabaseConnection !== "function") {
        throw new Error(`Provider ${provider.constructor.name} is not SQL-capable.`);
      }
      db = (await provider.getDatabaseConnection()) as {
        execute: (q: unknown) => Promise<unknown>;
      };
      ({ sql } = await import("drizzle-orm"));
      const { TERMINAL_TASK_STATUSES } = await import("../.minsky/hooks/task-statuses");
      terminal = [...TERMINAL_TASK_STATUSES];
    },

    async evaluate(diff) {
      const labels = extractChangedOutputLabels(diff);
      if (labels.length === 0) return { findings: [], candidate: false };
      if (!db || !sql) throw new Error("setup() did not run");

      const hits: StaleSignalHit[] = [];
      for (const label of [...new Set(labels.map((l) => l.text))]) {
        const pattern = `%${escapeLike(label)}%`;
        // Built conditionally on BOTH conditions: `not in ()` is itself a
        // Postgres syntax error, and the terminal set comes from the domain
        // registry — a future edit emptying it must not turn every replay into a
        // failed query. Carried over from the guard module (PR #3001 R1 caught
        // its loss here); `stale-signal-sweep.ts` states the same reasoning.
        const statusClause =
          includeTerminal || terminal.length === 0
            ? sql``
            : sql`and t.status::text not in ${terminal}`;
        const rows = await db.execute(sql`
          select t.id as id from tasks t
          join task_specs s on s.task_id = t.id
          where s.content like ${pattern} escape '\\'
          ${statusClause}
          limit ${MAX_ARTIFACTS_PER_LABEL}
        `);
        for (const row of Array.isArray(rows) ? rows : []) {
          // Self-matches are KEPT — see the sweep module's note. mt#3911's own
          // spec carried the originating mystery, and SC3 names it explicitly.
          const id = (row as Record<string, unknown>)["id"];
          if (typeof id === "string") hits.push({ label, artifact: id });
        }
      }
      return { findings: hits, candidate: true };
    },

    describe(findings) {
      const labels = [...new Set(findings.map((f) => f.label))];
      const quotes = findings.slice(0, MAX_QUOTES_SHOWN).map((f) => `${f.label} -> ${f.artifact}`);
      return [`labels: ${labels.join(", ")}`, ...quotes];
    },
  };
}

/**
 * `unrendered-result-field-scan` — a counter or flag added to a `*Result` type
 * that no operator-facing output site renders.
 *
 * Diff-only: no corpus half, so its replay carries no as-of-today caveat.
 */
function createUnrenderedFieldAdapter(): DiffGuardAdapter<UnrenderedField> {
  return {
    name: "unrendered-result-field-scan",
    confidence: "faithful — diff-only, no corpus half is read",
    evaluate(diff) {
      return { findings: findUnrenderedResultFields(diff) };
    },
    describe(findings) {
      return findings.map((f) => `${f.owner}.${f.name}  (${f.file})`);
    },
  };
}

const GUARD_NAMES = ["stale-signal-sweep", "unrendered-result-field-scan"] as const;

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  if (!GUARD_NAMES.includes(args.guard as (typeof GUARD_NAMES)[number])) {
    console.error(`Unknown --guard ${args.guard || "(missing)"}. Known: ${GUARD_NAMES.join(", ")}`);
    process.exit(2);
  }

  const report =
    args.guard === "stale-signal-sweep"
      ? await runDiffGuardBacktest(createStaleSignalAdapter(args.includeTerminal), args, gitDeps)
      : await runDiffGuardBacktest(createUnrenderedFieldAdapter(), args, gitDeps);

  if (report.commitsEvaluated === 0) {
    console.error("No commits in range — nothing to backtest.");
    process.exit(2);
  }

  console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
}

if (import.meta.main) {
  // A thrown git failure or a rejected flag is an operator-facing error, not a
  // stack trace: exit 2 with the message, the same code the other refusals use.
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
