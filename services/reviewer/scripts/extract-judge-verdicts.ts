#!/usr/bin/env bun
/**
 * Project a judge-pass run artifact into the durable, committed form that the
 * kappa join needs (mt#2746).
 *
 * `services/reviewer/eval/results/` is gitignored, on the stated rationale
 * that its contents are "regenerable comparative JSON artifacts". That holds
 * for the diff cache and for a paired-eval run; it does NOT hold for the judge
 * verdicts. Regenerating them means re-running a multi-provider panel over
 * every candidate — real vendor spend, and on 2026-08-25 not even possible,
 * because the Anthropic key ran out of credit partway through the run that
 * produced them.
 *
 * So the verdicts are projected into `eval/corpus/`, beside
 * `ground-truth-v1.jsonl`, and committed. This is the same move the task spec
 * makes for the human labels and for the same reason: the repo is the system
 * of record, and the expensive-to-recreate artifact does not get to live only
 * in an ignored directory.
 *
 * The projection drops `disagreementSubset`'s full rows — finding text and
 * code context are already committed in the corpus, keyed by the same row id,
 * so carrying them again would duplicate ~600KB to no benefit. What is kept:
 * which rows were selected, and what each judge said about every candidate.
 *
 * `score-human-labels.ts --artifact` reads either form: both expose
 * `judgeVerdicts` keyed by row id.
 *
 * @see mt#2746
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

export interface DurableVerdictArtifact {
  corpusVersion: string;
  runStartedAt: string;
  panel: string[];
  candidateCount: number;
  judgedCount: number;
  disagreementCount: number;
  /** Ids selected into the disagreement-weighted subset, in artifact order. */
  selectedIds: string[];
  judgeVerdicts: Record<string, unknown>;
  /**
   * Rows whose aggregate includes at least one FAILED judge call, precomputed
   * so a consumer does not have to rediscover them. A failed judge returns a
   * real-looking verdict (mt#4616), so this is not derivable by eye.
   */
  contaminatedIds: string[];
}

/**
 * The run artifact as this projector reads it.
 *
 * `perJudge` carries an index signature because the projector only INSPECTS
 * `parseError` and passes every other field through verbatim — pinning the
 * full judge shape here would couple this script to `run-judge-pass.ts`'s
 * record layout for no benefit, and would reject a run artifact that gained a
 * field.
 */
export interface RunArtifact {
  corpusVersion?: string;
  runStartedAt?: string;
  panel?: string[];
  candidateCount?: number;
  judgedCount?: number;
  disagreementCount?: number;
  disagreementSubset?: { id: string }[];
  judgeVerdicts?: Record<string, { perJudge?: { parseError?: string; [key: string]: unknown }[] }>;
}

export function projectRunArtifact(run: RunArtifact): DurableVerdictArtifact {
  if (!run.judgeVerdicts || Object.keys(run.judgeVerdicts).length === 0) {
    throw new Error(
      "run artifact has no judgeVerdicts — artifacts written before mt#2746 dropped the " +
        "panel's verdicts at write time and cannot be projected; re-run the judge pass"
    );
  }
  const contaminatedIds = Object.entries(run.judgeVerdicts)
    .filter(([, v]) => (v.perJudge ?? []).some((j) => j.parseError !== undefined))
    .map(([id]) => id);

  return {
    corpusVersion: run.corpusVersion ?? "unknown",
    runStartedAt: run.runStartedAt ?? "unknown",
    panel: run.panel ?? [],
    candidateCount: run.candidateCount ?? 0,
    judgedCount: run.judgedCount ?? 0,
    disagreementCount: run.disagreementCount ?? 0,
    selectedIds: (run.disagreementSubset ?? []).map((r) => r.id),
    judgeVerdicts: run.judgeVerdicts,
    contaminatedIds,
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  let input = "services/reviewer/eval/results/disagreement-subset-v1.json";
  let output: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input") input = argv[++i] ?? input;
    else if (argv[i] === "--output") output = argv[++i];
  }

  const run = JSON.parse(readFileSync(resolve(input), "utf-8")) as RunArtifact;
  const projected = projectRunArtifact(run);
  const outPath =
    output ?? `services/reviewer/eval/corpus/judge-verdicts-${projected.corpusVersion}.json`;

  writeFileSync(resolve(outPath), `${JSON.stringify(projected, null, 2)}\n`, "utf-8");

  console.log(`Projected ${input} -> ${outPath}`);
  console.log(`  panel: ${projected.panel.join(", ")}`);
  console.log(`  judged=${projected.judgedCount} selected=${projected.selectedIds.length}`);
  console.log(
    `  contaminated by a failed judge: ${projected.contaminatedIds.length} ` +
      `(${projected.contaminatedIds.filter((id) => projected.selectedIds.includes(id)).length} of them selected)`
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`FAILED: ${getLoggableErrorSummary(error)}`);
    process.exit(1);
  }
}
