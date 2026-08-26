#!/usr/bin/env bun
/**
 * Push the disagreement-weighted subset to a Braintrust dataset for human
 * labeling (mt#2746).
 *
 * The dataset is the LABELING UI, not the system of record. Braintrust's
 * Starter retention window deletes dataset rows older than 14 days, and
 * mt#2991 — the consumer of these labels — is unstarted, so the gap between
 * labeling and consumption is open-ended. Export the labels and commit them
 * beside the corpus as soon as a labeling pass finishes.
 *
 * ## The blind-payload rule
 *
 * The rows pushed here carry the finding and its code context and NOTHING
 * that reveals how the finding was already judged. Braintrust renders both
 * `input` and `metadata` in the review UI, so anything placed in either is
 * something the labeler reads before assigning a label. Showing them the
 * panel's verdict — or the deterministic corpus label, which encodes whether
 * the finding was fixed in the next round and is just as strong a hint —
 * anchors the human reference and inflates the very kappa the gold set exists
 * to measure.
 *
 * The payload is therefore built field-by-field from an ALLOWLIST
 * (`buildBlindDatasetRow`), never by spreading a `CorpusRow`. A spread would
 * make every future field added to `CorpusRow` leak into the labeling UI by
 * default, and the resulting bias would be invisible: the labels would still
 * look like labels. `push-braintrust-gold-set.test.ts` pins the key sets.
 *
 * The evidence the labeler sees is deliberately the SAME evidence the judge
 * panel sees (`buildJudgeUserPrompt` in `../src/judge.ts`: file, severity,
 * line, finding text, code context). Cohen's kappa compares two raters on one
 * body of evidence; giving the human more or less than the judge had would
 * measure something other than rater disagreement.
 *
 * Dry-run by default. Pass `--execute` to write to Braintrust.
 *
 * @see mt#2746 — this task
 * @see mt#2726 — the corpus + judge pass this consumes
 * @see mt#2991 — Milestone B, the consumer of the resulting labels
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { readBraintrustConfig } from "@minsky/domain/observability/braintrust";

import type { CorpusRow } from "../src/eval-corpus";

// ---------------------------------------------------------------------------
// The blind payload
// ---------------------------------------------------------------------------

/** The evidence pane the labeler reads. Mirrors the judge's user prompt. */
export interface BlindDatasetInput {
  rowId: string;
  file: string;
  severity: string;
  line?: number;
  lineEnd?: number;
  findingText: string;
  codeContext: string;
}

/**
 * Provenance only — enough to trace a row back, nothing about its outcome.
 *
 * A `type` rather than an `interface` on purpose: only a type alias gets an
 * implicit index signature, so only a type alias is assignable to the SDK's
 * `metadata?: Record<string, unknown>` parameter.
 */
export type BlindDatasetMetadata = {
  rowId: string;
  corpusVersion: string;
  prNumber: number;
  round: number;
};

export interface BlindDatasetRow {
  /** Braintrust record id. The corpus row id, so re-pushing upserts. */
  id: string;
  input: BlindDatasetInput;
  metadata: BlindDatasetMetadata;
  tags: string[];
}

/**
 * Build one blind dataset row from a corpus row.
 *
 * Every field is named explicitly. Do NOT refactor this into a spread of
 * `row` or `row.finding` — see the blind-payload rule in the module docblock.
 * `expected` is deliberately absent: that is the field the human review score
 * writes the label INTO, so pre-filling it would hand the labeler an answer.
 */
export function buildBlindDatasetRow(row: CorpusRow): BlindDatasetRow {
  const input: BlindDatasetInput = {
    rowId: row.id,
    file: row.finding.file,
    severity: row.finding.severity,
    findingText: row.finding.text,
    codeContext: row.codeContextWindow,
  };
  // Optional numerics: omit rather than emit `undefined`, which Braintrust
  // would render as an empty field in the review UI.
  if (row.finding.line !== undefined) input.line = row.finding.line;
  if (row.finding.lineEnd !== undefined) input.lineEnd = row.finding.lineEnd;

  return {
    id: row.id,
    input,
    metadata: {
      rowId: row.id,
      corpusVersion: row.corpusVersion,
      prNumber: row.prNumber,
      round: row.round,
    },
    tags: ["mt2746", `corpus-${row.corpusVersion}`],
  };
}

// ---------------------------------------------------------------------------
// Artifact reading
// ---------------------------------------------------------------------------

const DEFAULT_ARTIFACT = "services/reviewer/eval/results/disagreement-subset-v1.json";

interface ParsedArgs {
  artifactPath: string;
  datasetName?: string;
  execute: boolean;
  limit?: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { artifactPath: DEFAULT_ARTIFACT, execute: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--execute") args.execute = true;
    else if (arg === "--artifact") args.artifactPath = argv[++i] ?? args.artifactPath;
    else if (arg === "--dataset") args.datasetName = argv[++i];
    else if (arg === "--limit") {
      const raw = argv[++i];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--limit expects a positive integer, got ${JSON.stringify(raw)}`);
      }
      args.limit = parsed;
    }
  }
  return args;
}

interface JudgePassArtifactShape {
  corpusVersion: string;
  disagreementSubset: CorpusRow[];
  panel?: string[];
  judgedCount?: number;
  candidateCount?: number;
}

function readArtifact(path: string): JudgePassArtifactShape {
  const absolute = resolve(path);
  const parsed = JSON.parse(readFileSync(absolute, "utf-8")) as JudgePassArtifactShape;
  if (!Array.isArray(parsed.disagreementSubset)) {
    throw new Error(`${absolute}: no disagreementSubset array — is this a judge-pass artifact?`);
  }
  if (parsed.disagreementSubset.length === 0) {
    throw new Error(
      `${absolute}: disagreementSubset is empty. Pushing an empty dataset would look ` +
        `like a successful run and leave nothing to label — refusing.`
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log("=== Braintrust gold-set push (mt#2746) ===");

  const artifact = readArtifact(args.artifactPath);
  const allRows = artifact.disagreementSubset;
  const rows = args.limit ? allRows.slice(0, args.limit) : allRows;
  const datasetName = args.datasetName ?? `reviewer-gold-set-${artifact.corpusVersion}`;

  console.log(`Artifact: ${resolve(args.artifactPath)}`);
  console.log(`  corpusVersion=${artifact.corpusVersion} subsetRows=${allRows.length}`);
  if (artifact.panel) console.log(`  judge panel: ${artifact.panel.join(", ")}`);
  if (args.limit) {
    console.log(`  --limit ${args.limit}: pushing ${rows.length} of ${allRows.length} rows`);
  }
  console.log(`Dataset: ${datasetName}`);

  const payload = rows.map(buildBlindDatasetRow);

  // Preview: show the exact key sets that will reach the review UI, so the
  // blind-payload rule is checkable by eye and not only by the test suite.
  const sample = payload[0];
  if (sample) {
    console.log("\nPayload shape (first row):");
    console.log(`  id: ${sample.id}`);
    console.log(`  input keys: ${Object.keys(sample.input).join(", ")}`);
    console.log(`  metadata keys: ${Object.keys(sample.metadata).join(", ")}`);
    console.log(`  tags: ${sample.tags.join(", ")}`);
    console.log(`  findingText: ${JSON.stringify(sample.input.findingText.slice(0, 100))}...`);
    console.log(`  codeContext: ${sample.input.codeContext.length} chars`);
    console.log("  expected: <absent — the human review score writes it>");
  }
  const totalContextChars = payload.reduce((sum, r) => sum + r.input.codeContext.length, 0);
  console.log(`\nRows to push: ${payload.length} (${totalContextChars} chars of code context)`);

  if (!args.execute) {
    console.log("\nDRY RUN — nothing written. Re-run with --execute to push:");
    console.log(
      `  bun services/reviewer/scripts/push-braintrust-gold-set.ts --artifact ${args.artifactPath} --execute`
    );
    return;
  }

  const config = await readBraintrustConfig();
  if (!config) {
    throw new Error(
      "Braintrust config unresolved (need observability.providers.braintrust.apiKey + projectName, " +
        "or BRAINTRUST_API_KEY/BRAINTRUST_PROJECT_NAME). Refusing to push."
    );
  }
  console.log(`\nProject: ${config.projectName} (${config.appUrl})`);

  const { initDataset } = await import("braintrust");
  const dataset = initDataset({
    project: config.projectName,
    dataset: datasetName,
    apiKey: config.apiKey,
    appUrl: config.appUrl,
    description:
      "mt#2746 reviewer-benchmark human-labeling gold set. Blind: no judge verdict or " +
      "deterministic label. Join to judge verdicts by input.rowId at scoring time.",
  });

  let inserted = 0;
  for (const row of payload) {
    dataset.insert(row);
    inserted++;
    if (inserted % 25 === 0) console.log(`  inserted ${inserted}/${payload.length}...`);
  }
  await dataset.flush();

  const summary = await dataset.summarize();
  console.log(`\nInserted ${inserted} row(s) locally.`);
  console.log(`Dataset URL: ${summary.datasetUrl}`);

  // Read back what Braintrust actually recorded rather than trusting the local
  // insert count: `dataset.insert` is buffered, so a local tally is a claim
  // about what we queued, not about what landed. `newRecords` is this run's
  // contribution; `totalRecords` is the union across runs, since a re-push
  // upserts by id.
  const data = summary.dataSummary;
  if (!data) {
    console.warn(
      "WARNING: Braintrust returned no data summary, so the push is UNCONFIRMED. " +
        "Open the dataset URL above before treating these rows as present."
    );
  } else {
    console.log(
      `Braintrust reports: newRecords=${data.newRecords} totalRecords=${data.totalRecords}`
    );
    if (data.newRecords < inserted) {
      console.warn(
        `WARNING: queued ${inserted} row(s) but Braintrust recorded ${data.newRecords} as new. ` +
          `Expected when re-pushing rows that already exist (upsert by id); investigate otherwise.`
      );
    }
  }
  console.log(
    "\nNext: configure ONE categorical Human Review score in the Braintrust UI with the 4 " +
      "options valid_blocking / valid_nonblocking / false_positive / cant_tell, set to write " +
      "to the `expected` field (string labels, not the 0-100% score — keeps kappa nominal)."
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
