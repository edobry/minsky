#!/usr/bin/env bun
/**
 * Targeted repair of contaminated rows in the committed judge-verdict artifact
 * (mt#4633, authorized by ask#10448).
 *
 * `judgeFinding`'s catch returns `verdict: "VALID"` with
 * `rationale: "(judge call failed)"` and the real cause in `parseError` — and
 * `"VALID"` is a legitimate `FindingVerdict`, so a dead judge is
 * indistinguishable from one that judged VALID (mt#4616 owns that defect).
 * mt#2746 contained it by precomputing `contaminatedIds` into the durable
 * artifact; `score-human-labels.ts` then HOLDS those rows OUT of kappa. Holding
 * out is containment. This script is the repair.
 *
 * Why a sibling script rather than a `--repair` mode on `run-judge-pass.ts`:
 * that file's `main()` selects candidates, judges all of them, and then
 * re-derives the disagreement-weighted subset from the fresh verdicts. A repair
 * must do the opposite of that last step — see the invariant below.
 *
 * ## The invariant: `selectedIds` must not move
 *
 * The 76 selected rows are already pushed to Braintrust as dataset
 * `reviewer-gold-set-v1`, and are what the human labeling pass will label
 * (mt#4627). `findDisagreementWeightedSubset` selects the subset FROM verdicts,
 * so re-running the ordinary pass would re-derive a DIFFERENT 76 and desync the
 * repo from the labeling UI. This script therefore rewrites `judgeVerdicts`,
 * each repaired row's `aggregate`/`agreement`, and `contaminatedIds` — and
 * leaves `selectedIds`, `disagreementCount`, `candidateCount`, `judgedCount`
 * and `corpusVersion` byte-identical.
 *
 * ## What gets re-called
 *
 * Only the per-judge entries carrying a `parseError`. A judge that answered
 * successfully in the original run keeps its verdict and rationale verbatim —
 * re-running the whole panel would discard good data and cost double.
 *
 * Usage:
 *   bun services/reviewer/scripts/repair-judge-verdicts.ts --dry-run
 *   bun services/reviewer/scripts/repair-judge-verdicts.ts
 *   bun services/reviewer/scripts/repair-judge-verdicts.ts --only pr-1942-r3-f0,pr-1940-r1-f0
 *
 * Flags:
 *   --artifact <path>  Durable verdict artifact. Default: the committed v1 artifact.
 *   --corpus <path>    Corpus JSONL (rows are looked up by id). Default: committed v1 corpus.
 *   --only <ids>       Comma-separated row ids. Default: the artifact's own `contaminatedIds`.
 *   --dry-run          Print the repair plan and exit before any network call.
 *
 * Live runs resolve provider keys through `resolveProviderApiKey`, which is
 * env-first with a Minsky-config fallback as of mt#4620. A judge whose provider
 * has no resolvable key is left alone and its row stays contaminated — reported,
 * never silently dropped.
 *
 * @see mt#4633, ask#10448, mt#4616 (the mechanism), mt#4627 (the labeling pass)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCorpusJsonlWithStats, type CorpusRow } from "../src/eval-corpus";
import {
  aggregateVerdicts,
  judgeFinding,
  type JudgeModelConfig,
  type PerJudgeVerdict,
} from "../src/judge";
import type { FindingVerdict } from "../src/eval-metrics";
import { resolveProviderApiKey } from "./paired-eval-runner";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ARTIFACT_PATH = join(SCRIPT_DIR, "..", "eval", "corpus", "judge-verdicts-v1.json");
const DEFAULT_CORPUS_PATH = join(SCRIPT_DIR, "..", "eval", "corpus", "ground-truth-v1.jsonl");

// ---------------------------------------------------------------------------
// Artifact shape (structurally matches extract-judge-verdicts.ts's projection)
// ---------------------------------------------------------------------------

export interface StoredPerJudge {
  provider: string;
  model: string;
  verdict: FindingVerdict;
  rationale: string;
  parseError?: string;
}

export interface StoredRowVerdict {
  aggregate: FindingVerdict;
  agreement: boolean;
  perJudge: StoredPerJudge[];
}

/**
 * Only the fields this script reads or rewrites are named. Everything else on
 * the artifact is carried through by spread, so a field added by a future
 * projection survives a repair untouched rather than being silently dropped.
 */
export interface RepairableArtifact {
  selectedIds: string[];
  judgeVerdicts: Record<string, StoredRowVerdict>;
  contaminatedIds: string[];
  [key: string]: unknown;
}

/** One row to repair, and which of its judges actually need re-calling. */
export interface RepairTarget {
  rowId: string;
  failedJudges: { provider: string; model: string; index: number }[];
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/** A stored per-judge entry is contaminated iff it carries a `parseError`. */
export function isFailedJudge(entry: StoredPerJudge): boolean {
  return typeof entry.parseError === "string" && entry.parseError.length > 0;
}

/**
 * Which rows need repair, and which per-judge slots within each.
 *
 * `onlyIds` restricts the set; the default is the artifact's own
 * `contaminatedIds`. A requested id with no failed judges yields no target —
 * asking to repair a clean row is a no-op, not an error.
 */
export function planRepair(
  artifact: RepairableArtifact,
  onlyIds?: readonly string[]
): RepairTarget[] {
  const candidateIds = onlyIds ?? artifact.contaminatedIds;
  const targets: RepairTarget[] = [];

  for (const rowId of candidateIds) {
    const stored = artifact.judgeVerdicts[rowId];
    if (stored === undefined) continue;

    const failedJudges = stored.perJudge
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => isFailedJudge(entry))
      .map(({ entry, index }) => ({ provider: entry.provider, model: entry.model, index }));

    if (failedJudges.length > 0) targets.push({ rowId, failedJudges });
  }

  return targets;
}

/**
 * Recompute a row's aggregate and agreement from its per-judge set, using the
 * SAME rule `judgeFinding` applies (`aggregateVerdicts` for the verdict;
 * unanimity against the first entry for agreement). Reusing the exported
 * `aggregateVerdicts` rather than reimplementing the plurality-with-median
 * tiebreak is what keeps a repaired row scored identically to a freshly-judged
 * one.
 */
export function recomputeRow(perJudge: readonly StoredPerJudge[]): {
  aggregate: FindingVerdict;
  agreement: boolean;
} {
  const aggregate = aggregateVerdicts(perJudge.map((j) => j.verdict));
  const firstVerdict = perJudge[0]?.verdict;
  const agreement = perJudge.every((j) => j.verdict === firstVerdict);
  return { aggregate, agreement };
}

/** Every row id still carrying at least one failed judge, in artifact order. */
export function recomputeContaminatedIds(
  judgeVerdicts: Record<string, StoredRowVerdict>,
  order: readonly string[]
): string[] {
  return order.filter((id) => {
    const stored = judgeVerdicts[id];
    return stored !== undefined && stored.perJudge.some(isFailedJudge);
  });
}

/**
 * Splice repaired per-judge entries into the artifact and recompute what
 * depends on them. Pure: returns a new artifact, mutates nothing.
 *
 * `repaired` is keyed by row id and holds the FULL per-judge array for that
 * row, already merged by the caller. `contaminatedIds` is recomputed over
 * every row the artifact knows about — not just the repaired ones — so a row
 * that was never in the repair set keeps whatever status it actually has.
 */
export function applyRepairs(
  artifact: RepairableArtifact,
  repaired: ReadonlyMap<string, StoredPerJudge[]>
): RepairableArtifact {
  const judgeVerdicts: Record<string, StoredRowVerdict> = {};
  for (const [rowId, stored] of Object.entries(artifact.judgeVerdicts)) {
    const replacement = repaired.get(rowId);
    if (replacement === undefined) {
      judgeVerdicts[rowId] = stored;
      continue;
    }
    judgeVerdicts[rowId] = { ...recomputeRow(replacement), perJudge: replacement };
  }

  return {
    ...artifact,
    judgeVerdicts,
    contaminatedIds: recomputeContaminatedIds(judgeVerdicts, Object.keys(judgeVerdicts)),
  };
}

/**
 * Merge one re-judged entry into a row's per-judge array by INDEX, not by
 * provider name: a panel may legitimately carry two members from the same
 * provider, and matching on name would overwrite the wrong slot.
 */
export function spliceJudge(
  perJudge: readonly StoredPerJudge[],
  index: number,
  replacement: StoredPerJudge
): StoredPerJudge[] {
  return perJudge.map((entry, i) => (i === index ? replacement : entry));
}

/** Project a live `PerJudgeVerdict` into the artifact's stored shape. */
export function toStoredPerJudge(verdict: PerJudgeVerdict): StoredPerJudge {
  return {
    provider: String(verdict.provider),
    model: verdict.model,
    verdict: verdict.verdict,
    rationale: verdict.rationale,
    ...(verdict.parseError ? { parseError: verdict.parseError } : {}),
  };
}

// ---------------------------------------------------------------------------
// Live repair (dependency-injected so the pure path is testable without
// patching a module the code reaches itself — testing-standards.mdc)
// ---------------------------------------------------------------------------

/** Re-run ONE judge against ONE row. Injected so tests supply a fake. */
export type SingleJudgeRunner = (
  row: CorpusRow,
  config: JudgeModelConfig
) => Promise<PerJudgeVerdict>;

/** Resolve a provider's key, or undefined when none is configured. */
export type KeyResolver = (provider: string) => Promise<string | undefined>;

export interface RepairOutcome {
  artifact: RepairableArtifact;
  attempted: number;
  repaired: number;
  stillFailing: number;
  skippedNoKey: { rowId: string; provider: string }[];
  missingCorpusRows: string[];
}

/**
 * Re-judge every failed slot in `targets` and return the repaired artifact.
 *
 * Makes ZERO calls when `targets` is empty — the idempotence property: running
 * the repair against an already-clean artifact must not spend vendor calls.
 */
export async function repairArtifact(
  artifact: RepairableArtifact,
  targets: readonly RepairTarget[],
  corpusById: ReadonlyMap<string, CorpusRow>,
  resolveKey: KeyResolver,
  runJudge: SingleJudgeRunner
): Promise<RepairOutcome> {
  const repaired = new Map<string, StoredPerJudge[]>();
  const skippedNoKey: { rowId: string; provider: string }[] = [];
  const missingCorpusRows: string[] = [];
  let attempted = 0;

  for (const target of targets) {
    const stored = artifact.judgeVerdicts[target.rowId];
    const row = corpusById.get(target.rowId);
    if (stored === undefined) continue;
    if (row === undefined) {
      missingCorpusRows.push(target.rowId);
      continue;
    }

    let perJudge: StoredPerJudge[] = [...stored.perJudge];
    for (const failed of target.failedJudges) {
      const apiKey = await resolveKey(failed.provider);
      if (apiKey === undefined) {
        skippedNoKey.push({ rowId: target.rowId, provider: failed.provider });
        continue;
      }
      attempted++;
      const fresh = await runJudge(row, {
        provider: failed.provider as JudgeModelConfig["provider"],
        model: failed.model,
        apiKey,
      });
      perJudge = spliceJudge(perJudge, failed.index, toStoredPerJudge(fresh));
    }
    repaired.set(target.rowId, perJudge);
  }

  const next = applyRepairs(artifact, repaired);
  const repairedCount = targets.filter((t) => !next.contaminatedIds.includes(t.rowId)).length;

  return {
    artifact: next,
    attempted,
    repaired: repairedCount,
    stillFailing: next.contaminatedIds.length,
    skippedNoKey,
    missingCorpusRows,
  };
}

/**
 * The production `SingleJudgeRunner`: a one-member panel through
 * `judgeFinding`, so the repaired entry is produced by exactly the code path
 * that produced the original.
 */
export const liveJudgeRunner: SingleJudgeRunner = async (row, config) => {
  const result = await judgeFinding(row.finding, row.codeContextWindow, [config]);
  const only = result.perJudge[0];
  if (only === undefined) {
    throw new Error(`judgeFinding returned no per-judge entry for ${row.id} (${config.model})`);
  }
  return only;
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  artifactPath: string;
  corpusPath: string;
  onlyIds?: string[];
  dryRun: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  let artifactPath = DEFAULT_ARTIFACT_PATH;
  let corpusPath = DEFAULT_CORPUS_PATH;
  let onlyIds: string[] | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--artifact") artifactPath = argv[++i] ?? artifactPath;
    else if (arg === "--corpus") corpusPath = argv[++i] ?? corpusPath;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--only") {
      onlyIds = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
  }

  return { artifactPath, corpusPath, onlyIds, dryRun };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("=== Judge-verdict repair (mt#4633) ===");
  console.log(`Artifact: ${args.artifactPath}`);
  console.log(`Corpus:   ${args.corpusPath}`);

  const artifact = JSON.parse(readFileSync(args.artifactPath, "utf-8")) as RepairableArtifact;
  const targets = planRepair(artifact, args.onlyIds);

  const selectedSet = new Set(artifact.selectedIds);
  const inSelected = targets.filter((t) => selectedSet.has(t.rowId)).length;
  console.log(
    `Contaminated rows: ${artifact.contaminatedIds.length} total; ` +
      `${targets.length} targeted, ${inSelected} of them inside the ${artifact.selectedIds.length}-row selected subset.`
  );
  for (const target of targets) {
    const judges = target.failedJudges.map((j) => `${j.provider}:${j.model}`).join(", ");
    console.log(
      `  ${target.rowId}${selectedSet.has(target.rowId) ? " [selected]" : ""} -> ${judges}`
    );
  }

  if (args.dryRun) {
    console.log("\n[DRY-RUN] Repair plan above. No network calls made, nothing written.");
    process.exit(0);
  }

  if (targets.length === 0) {
    console.log("\nNothing to repair. No network calls made, nothing written.");
    process.exit(0);
  }

  const { rows } = parseCorpusJsonlWithStats(readFileSync(args.corpusPath, "utf-8"));
  const corpusById = new Map(rows.map((row) => [row.id, row]));

  // Wrap the live runner with progress logging. The repair is sequential and
  // each call can take up to the provider's own timeout (120s is what produced
  // half this contamination in the first place), so a run with no per-call
  // output is indistinguishable from a hung one for minutes at a time.
  const totalCalls = targets.reduce((n, t) => n + t.failedJudges.length, 0);
  let callIndex = 0;
  const loggingRunner: SingleJudgeRunner = async (row, config) => {
    callIndex++;
    const started = performance.now();
    process.stdout.write(
      `  [${callIndex}/${totalCalls}] ${row.id} via ${config.provider}:${config.model} ... `
    );
    try {
      const result = await liveJudgeRunner(row, config);
      const elapsed = Math.round(performance.now() - started);
      console.log(
        result.parseError
          ? `STILL FAILING (${elapsed}ms): ${result.parseError.slice(0, 120)}`
          : `${result.verdict} (${elapsed}ms)`
      );
      return result;
    } catch (err: unknown) {
      console.log(`THREW (${Math.round(performance.now() - started)}ms)`);
      throw err;
    }
  };

  console.log(`\nRe-judging ${totalCalls} failed judge call(s) across ${targets.length} row(s)...`);
  const outcome = await repairArtifact(
    artifact,
    targets,
    corpusById,
    (provider) => resolveProviderApiKey(provider as JudgeModelConfig["provider"]),
    loggingRunner
  );

  writeFileSync(args.artifactPath, `${JSON.stringify(outcome.artifact, null, 2)}\n`, "utf-8");

  console.log("\n=== Summary ===");
  console.log(`Judge calls attempted: ${outcome.attempted}`);
  console.log(`Rows fully repaired:   ${outcome.repaired}/${targets.length}`);
  console.log(`Rows still failing:    ${outcome.stillFailing}`);
  const remainingSelected = outcome.artifact.contaminatedIds.filter((id) => selectedSet.has(id));
  console.log(`  of which selected:   ${remainingSelected.length}`);
  if (outcome.skippedNoKey.length > 0) {
    console.log(`Skipped (no API key configured): ${outcome.skippedNoKey.length}`);
    for (const skipped of outcome.skippedNoKey) {
      console.log(`  ${skipped.rowId}: provider "${skipped.provider}"`);
    }
  }
  if (outcome.missingCorpusRows.length > 0) {
    console.log(`Skipped (id absent from corpus): ${outcome.missingCorpusRows.join(", ")}`);
  }
  console.log(`\nWrote ${args.artifactPath}`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
