#!/usr/bin/env bun
/**
 * Live verification for the ADR-024 Rung-2 nomination stage (mt#3408).
 *
 * The unit tests inject fake vectors, so they prove the UNION and DEGRADATION
 * logic but say nothing about the only question that matters for recall:
 * does a real embedding model actually place the mt#3341 admission near a
 * curated exemplar, while keeping ordinary correct-ordering narration away from
 * one? That is a property of the model, not of our code, and it can only be
 * measured against a live provider.
 *
 * Gates on provider availability and SKIPS (exit 0) when none is configured, so
 * it is safe in CI. Exits non-zero only on a real recall/precision failure.
 *
 * Usage:
 *   bun scripts/verify-rung2-nomination.ts
 *   bun scripts/verify-rung2-nomination.ts --threshold 0.55
 *   bun scripts/verify-rung2-nomination.ts --json > results.json
 */

import "reflect-metadata";

import {
  nominate,
  splitCandidateSegments,
  DEFAULT_SIMILARITY_THRESHOLD,
  type ExemplarSet,
  type NominationDeps,
} from "../packages/domain/src/detectors/embedding-nomination";
import { NOMINATION_EXEMPLARS } from "../.minsky/hooks/retrospective-trigger-scanner";
import { elideQuotedAndCodeContexts } from "../.minsky/hooks/elision";

/**
 * The mt#3341 originating admission, verbatim. This is the RECALL fixture: no
 * exemplar copies it, so nominating it demonstrates generalization rather than
 * memorization.
 */
const ORIGINATING_ADMISSION =
  "I wrote a task reference (`mt#3336`) into the docblock before minting it — " +
  "creating it now and correcting the reference to whatever ID actually comes back";

/** Must NOT fire: ordinary correct-ordering narration shares the surface form. */
const NEGATIVE_CONTROLS = [
  "I built the bundle before serving it.",
  "I committed before pushing.",
  "I read the config before starting the server.",
  "I ran the tests before opening the pull request.",
];

/** Neutral prose that should stay far from every family. */
const NEUTRAL_CONTROLS = [
  "The deployment finished and the health check returned 200.",
  "This function converts a task id into its canonical short form.",
];

interface Scored {
  label: string;
  text: string;
  topFamily: string | null;
  topScore: number;
  nominated: boolean;
}

function parseArgs(): { threshold: number; json: boolean } {
  const argv = process.argv.slice(2);
  const jsonIdx = argv.indexOf("--json");
  const tIdx = argv.indexOf("--threshold");
  const threshold =
    tIdx >= 0 && argv[tIdx + 1] !== undefined
      ? Number.parseFloat(argv[tIdx + 1] as string)
      : DEFAULT_SIMILARITY_THRESHOLD;
  return { threshold, json: jsonIdx >= 0 };
}

async function buildDeps(): Promise<NominationDeps | null> {
  const { initializeConfiguration, CustomConfigFactory, getConfiguration } = await import(
    "../packages/domain/src/configuration"
  );
  const { createEmbeddingServiceFromConfig } = await import(
    "../packages/domain/src/ai/embedding-service-factory"
  );

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const config = await getConfiguration();
  const provider = config.embeddings?.provider || config.ai?.defaultProvider || "openai";
  if (provider === "local") {
    process.stderr.write(
      "SKIP: embeddings.provider is 'local' (hash stub, no semantic signal) — " +
        "this check needs a real provider.\n"
    );
    return null;
  }

  return { embeddingService: await createEmbeddingServiceFromConfig(), semantic: true };
}

/**
 * Score one input against every family. Uses a threshold of 0 so the RAW top
 * score is always reported — the point of this script is to show where the
 * separation actually falls, not to confirm a threshold we picked in advance.
 */
async function score(
  label: string,
  text: string,
  sets: ExemplarSet[],
  deps: NominationDeps,
  threshold: number
): Promise<Scored> {
  const scanned = elideQuotedAndCodeContexts(text);
  const result = await nominate(scanned, sets, deps, { threshold: 0 });
  if (result.degraded) {
    throw new Error(`nomination degraded (${result.degradedReason}) while scoring "${label}"`);
  }
  const top = result.nominations[0];
  return {
    label,
    text,
    topFamily: top?.family ?? null,
    topScore: top?.score ?? 0,
    nominated: (top?.score ?? 0) >= threshold,
  };
}

async function main(): Promise<void> {
  const { threshold, json } = parseArgs();

  let deps: NominationDeps | null;
  try {
    deps = await buildDeps();
  } catch (error) {
    process.stderr.write(
      `SKIP: no embedding provider available (${error instanceof Error ? error.message : String(error)})\n`
    );
    process.exit(0);
  }
  if (deps === null) process.exit(0);

  const segments = splitCandidateSegments(elideQuotedAndCodeContexts(ORIGINATING_ADMISSION));
  if (segments.length === 0) {
    process.stderr.write("FAIL: the originating admission produced no scoreable segments.\n");
    process.exit(1);
  }

  const rows: Scored[] = [];
  rows.push(
    await score(
      "RECALL: mt#3341 admission",
      ORIGINATING_ADMISSION,
      NOMINATION_EXEMPLARS,
      deps,
      threshold
    )
  );
  for (const [i, text] of NEGATIVE_CONTROLS.entries()) {
    rows.push(await score(`NEGATIVE ${i + 1}`, text, NOMINATION_EXEMPLARS, deps, threshold));
  }
  for (const [i, text] of NEUTRAL_CONTROLS.entries()) {
    rows.push(await score(`NEUTRAL ${i + 1}`, text, NOMINATION_EXEMPLARS, deps, threshold));
  }

  const recall = rows[0] as Scored;
  const negatives = rows.slice(1, 1 + NEGATIVE_CONTROLS.length);
  const neutrals = rows.slice(1 + NEGATIVE_CONTROLS.length);

  const recallPass = recall.topScore >= threshold;
  const negativesPass = negatives.every((r) => r.topScore < threshold);
  const neutralsPass = neutrals.every((r) => r.topScore < threshold);
  const pass = recallPass && negativesPass && neutralsPass;

  // The separation margin is the real output: it says how much room a threshold
  // has before it starts admitting the negative controls.
  const highestNegative = Math.max(...negatives.map((r) => r.topScore), 0);
  const margin = recall.topScore - highestNegative;

  const summary = {
    threshold,
    recall: { score: recall.topScore, family: recall.topFamily, pass: recallPass },
    highestNegative,
    margin,
    negativesPass,
    neutralsPass,
    pass,
    rows,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`Rung-2 nomination live check (threshold ${threshold.toFixed(3)})\n\n`);
    for (const r of rows) {
      const verdict = r.nominated ? "NOMINATED" : "-        ";
      process.stdout.write(
        `  ${verdict}  ${r.topScore.toFixed(4)}  ${(r.topFamily ?? "none").padEnd(4)}  ${r.label}\n`
      );
    }
    process.stdout.write(
      `\n  recall ${recallPass ? "PASS" : "FAIL"} | negatives ${negativesPass ? "PASS" : "FAIL"} ` +
        `| neutrals ${neutralsPass ? "PASS" : "FAIL"}\n` +
        `  separation margin: ${margin.toFixed(4)} (recall ${recall.topScore.toFixed(4)} - ` +
        `highest negative ${highestNegative.toFixed(4)})\n`
    );
  }

  process.exit(pass ? 0 : 1);
}

await main();
