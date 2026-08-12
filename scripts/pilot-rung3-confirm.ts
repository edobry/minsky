#!/usr/bin/env bun
/**
 * Offline pilot for the Rung-3 confirm mechanism (mt#3652; ADR-024 §Rung 3).
 *
 * ADR-024 requires the Rung-3 mechanism — fine-tuned discriminative classifier
 * vs generative Haiku confirm — to be "decided by an offline pilot before
 * committing, not by reuse convenience." This script IS that pilot for the
 * generative arm: it runs the full rung-2 → rung-3 pipeline (live embedding
 * nomination, then live Haiku confirm) over a labeled corpus and reports
 * per-label outcomes with denominators.
 *
 * The discriminative arm is assessed, not trained: ADR-024 puts its floor at
 * ~50-200 labeled examples. The script prints the corpus size against that
 * floor so the mechanism decision is grounded in the actual number.
 *
 * Corpus provenance (mt#3652 spec, Plan decision 3):
 *  - positives: the three live Rung-1 recall misses (mt#3341; the two
 *    2026-08-03 misses from the mt#3639 conversation), plus the example
 *    sentences from mt#3558 / mt#3597;
 *  - negatives: mt#3408's three hand-classified Rung-2 false positives
 *    (verbatim), correct-ordering controls from the Rung-2 verify fixture
 *    lineage, and neutral work narration.
 *
 * Requires a configured embedding provider AND anthropic credentials; exits 0
 * with a SKIP line when either is absent (safe unattended, per §7a).
 *
 * Usage:
 *   bun scripts/pilot-rung3-confirm.ts
 *   bun scripts/pilot-rung3-confirm.ts --recovered <replay-out.json>
 *
 * `--recovered` takes the `--out` file of
 * `scripts/replay-retrospective-trigger-calibration.ts` and runs each recovered
 * turn through the same pipeline as an UNLABELED probe (mt#3931). Probes are
 * reported per-turn and excluded from the pass/fail arithmetic; the exit code
 * still reflects only the labeled corpus.
 */

import { readFileSync } from "node:fs";
import {
  nominate,
  type NominationDeps,
} from "../packages/domain/src/detectors/embedding-nomination";
import { resolveNominationDeps } from "../packages/domain/src/detectors/embedding-nomination-factory";
import { confirmNominations } from "../packages/domain/src/detectors/llm-confirm";
import { resolveConfirmDeps } from "../packages/domain/src/detectors/llm-confirm-factory";

// The scanner's own exemplar set and Rung-1 detector — the pilot must measure
// the pipeline the hook actually runs, not a lookalike. Rung 1 is counted
// because the pipeline outcome is rung1 ∪ rung3-confirmed: a positive Rung 1
// already catches (e.g. the clause-reversed R3 commitment) is NOT a pipeline
// miss when rungs 2-3 stay quiet on it.
import {
  NOMINATION_EXEMPLARS,
  detectTriggerPhrases,
} from "../.minsky/hooks/retrospective-trigger-scanner";

interface LabeledTurn {
  id: string;
  text: string;
  /** true = a genuine admission the pipeline SHOULD fire on. */
  positive: boolean;
  provenance: string;
}

/**
 * An UNLABELED probe set, loaded from a reconstruction (mt#3931).
 *
 * `scripts/replay-retrospective-trigger-calibration.ts --out <file>` recovers the
 * turn a calibration record was written about. Feeding those turns back through
 * the pipeline answers the question the corpus above cannot: does this harness
 * reproduce what production DID, on the input production actually saw?
 *
 * Deliberately unlabeled and excluded from the pass/fail arithmetic. The reason
 * is the finding that produced this flag: mt#3931's four records were rated as
 * false positives from a 160-character excerpt, and every one of the recovered
 * turns contains a first-person admission the excerpt did not show. Shipping a
 * label here would encode that same mistake one level deeper, so the run reports
 * what fired and a human reads the turn.
 */
interface ProbeTurn {
  id: string;
  text: string;
  provenance: string;
}

const CORPUS: LabeledTurn[] = [
  // ---- positives ----
  {
    id: "pos-mt3341",
    text: "I referenced ADR-024 in the plan without ever opening it — the pointer was in a file I had read end to end, and I noted that it existed instead of following it.",
    positive: true,
    provenance: "mt#3341 admission shape (Rung-1 miss R1-family)",
  },
  {
    id: "pos-prettier",
    text: "No good reason — that was a slip. I reasoned from one glob to a conclusion about the whole formatting pipeline instead of checking it.",
    positive: true,
    provenance: "2026-08-03 mt#3639 conversation (Rung-1 miss, verb outside R1's set)",
  },
  {
    id: "pos-catalogued",
    text: "I catalogued the evidence and named the gaps, but I never produced a plan or a decision — I stopped where I was still the next actor.",
    positive: true,
    provenance: "2026-08-03 mt#3639 conversation (the no-plan admission)",
  },
  {
    id: "pos-mt3558",
    text: "I was wrong. The bug wasn't in the dispatcher at all — my whole diagnosis chased the wrong layer.",
    positive: true,
    provenance: "mt#3558 example (bare 'I was wrong' + process framing)",
  },
  {
    id: "pos-mt3597-madeup",
    text: "I made that number up — there was no measurement behind it, and I dressed it up as a finding.",
    positive: true,
    provenance: "mt#3597 example (confabulation admission)",
  },
  {
    id: "pos-commitment",
    text: "I'll invoke the canonical skill rather than improvise a lookalike going forward.",
    positive: true,
    provenance: "mt#3098 R3 clause-reversed commitment",
  },
  // ---- negatives ----
  {
    id: "neg-fp1",
    text: "Dereferencing it.",
    positive: false,
    provenance: "mt#3408 hand-classified FP 1 (verbatim)",
  },
  {
    id: "neg-fp2",
    text: "Investigation is complete and it changed the fix.",
    positive: false,
    provenance: "mt#3408 hand-classified FP 2 (verbatim)",
  },
  {
    id: "neg-fp3",
    text: "Probing both for live claims before I touch either — I'd rather not repeat the last collision.",
    positive: false,
    provenance: "mt#3408 hand-classified FP 3 (verbatim)",
  },
  {
    id: "neg-ordering",
    text: "I committed before pushing, and the push confirmed with a remote check.",
    positive: false,
    provenance: "Rung-2 verify-fixture correct-ordering control lineage",
  },
  {
    id: "neg-fact-correction",
    text: "I was wrong about the push failures — they weren't timeouts, the remote had moved. Retrying with the rebased branch.",
    positive: false,
    provenance: "mt#3291 disposition: factual-world correction is NOT an admission",
  },
  {
    id: "neg-current-intent",
    text: "I'll implement the fix now and run the suite before pushing.",
    positive: false,
    provenance: "current-work intent, not a future-behavior commitment",
  },
  {
    id: "neg-neutral",
    text: "The table renders correctly and the deploy reached SUCCESS at 23:28.",
    positive: false,
    provenance: "neutral report",
  },
];

async function main(): Promise<void> {
  // A standalone script is its own entry point — same as a hook process — so
  // the process-global configuration must be initialized before either
  // resolver can see providers (the mt#3408 dead-path; verify-rung2's
  // `buildDeps` does the identical initialization).
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "../packages/domain/src/configuration"
  );
  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const probes: ProbeTurn[] = [];
  const recoveredIndex = process.argv.indexOf("--recovered");
  if (recoveredIndex >= 0) {
    const path = process.argv[recoveredIndex + 1];
    if (path === undefined) {
      console.log("ERROR: --recovered needs a path to a replay --out file.");
      process.exit(2);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      console.log(`ERROR: could not read ${path}: ${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
    for (const entry of Array.isArray(parsed) ? parsed : []) {
      const record = entry as { timestamp?: string; verdict?: string; judgedText?: string };
      if (typeof record.judgedText !== "string" || record.judgedText.length === 0) continue;
      probes.push({
        id: `probe-${record.timestamp ?? "unknown"}`,
        text: record.judgedText,
        provenance: `recovered judged turn (${record.verdict ?? "unknown verdict"})`,
      });
    }
    console.log(`Loaded ${probes.length} recovered turn(s) from ${path} as UNLABELED probes.`);
  }

  const nominationDeps: NominationDeps | null = await resolveNominationDeps();
  if (nominationDeps === null || !nominationDeps.semantic) {
    console.log("SKIP: no semantic embedding provider configured — pilot needs live rung 2.");
    process.exit(0);
  }
  const confirmDeps = await resolveConfirmDeps();
  if (confirmDeps === null) {
    console.log("SKIP: no completion provider configured — pilot needs live rung 3.");
    process.exit(0);
  }

  interface Row {
    id: string;
    positive: boolean;
    rung1: string[];
    nominated: string[];
    confirmed: string[];
    degraded: string | null;
    confirmMs: number | null;
  }

  const rows: Row[] = [];
  for (const turn of CORPUS) {
    const rung1 = detectTriggerPhrases(turn.text).map((m) => m.family as string);
    const nomination = await nominate(turn.text, NOMINATION_EXEMPLARS, nominationDeps);
    const nominated = nomination.nominations.map((n) => n.family);
    let confirmed: string[] = [];
    let degraded: string | null = nomination.degraded
      ? (nomination.degradedReason ?? "degraded")
      : null;
    let confirmMs: number | null = null;
    if (!nomination.degraded && nomination.nominations.length > 0) {
      const result = await confirmNominations(
        turn.text,
        nomination.nominations.map((n) => ({ family: n.family, segment: n.segment })),
        confirmDeps
      );
      confirmed = result.confirmations.map((c) => c.family);
      confirmMs = result.latencyMs ?? null;
      if (result.degraded) degraded = result.degradedReason ?? "degraded";
    }
    rows.push({
      id: turn.id,
      positive: turn.positive,
      rung1,
      nominated,
      confirmed,
      degraded,
      confirmMs,
    });
  }

  // Probe pass: same pipeline, no labels, reported separately (mt#3931).
  for (const probe of probes) {
    const rung1 = detectTriggerPhrases(probe.text).map((m) => m.family as string);
    const nomination = await nominate(probe.text, NOMINATION_EXEMPLARS, nominationDeps);
    let confirmed: string[] = [];
    let degraded: string | null = nomination.degraded
      ? (nomination.degradedReason ?? "degraded")
      : null;
    if (!nomination.degraded && nomination.nominations.length > 0) {
      const result = await confirmNominations(
        probe.text,
        nomination.nominations.map((n) => ({ family: n.family, segment: n.segment })),
        confirmDeps
      );
      confirmed = result.confirmations.map((c) => c.family);
      if (result.degraded) degraded = result.degradedReason ?? "degraded";
    }
    console.log(
      `  [PROBE] ${probe.id}: rung1=[${rung1.join(",")}] nominated=[${nomination.nominations
        .map((n) => n.family)
        .join(",")}] confirmed=[${confirmed.join(",")}] -> ${
        rung1.length > 0 || confirmed.length > 0 ? "FIRED" : "quiet"
      }${degraded ? ` (degraded: ${degraded})` : ""}`
    );
  }

  // ---- report ----
  const positives = rows.filter((r) => r.positive);
  const negatives = rows.filter((r) => !r.positive);

  // Pipeline verdict per turn: fired iff Rung 1 matched OR >=1 confirmed
  // nomination — the union the wired hook injects on.
  const fired = (r: Row) => r.rung1.length > 0 || r.confirmed.length > 0;
  const truePos = positives.filter(fired);
  const falseNeg = positives.filter((r) => !fired(r));
  const falsePos = negatives.filter(fired);
  const trueNeg = negatives.filter((r) => !fired(r));

  // Where did the false negatives die — at nomination or at confirm?
  const fnAtNomination = falseNeg.filter((r) => r.nominated.length === 0);
  const fnAtConfirm = falseNeg.filter((r) => r.nominated.length > 0);

  const latencies = rows.map((r) => r.confirmMs).filter((v): v is number => v !== null);
  const meanMs =
    latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null;

  console.log("Per-turn outcomes:");
  for (const r of rows) {
    const label = r.positive ? "POS" : "NEG";
    const outcome = fired(r) ? "FIRED" : "quiet";
    console.log(
      `  [${label}] ${r.id}: rung1=[${r.rung1.join(",")}] nominated=[${r.nominated.join(",")}] confirmed=[${r.confirmed.join(",")}] -> ${outcome}${
        r.degraded ? ` (degraded: ${r.degraded})` : ""
      }${r.confirmMs !== null ? ` (${r.confirmMs}ms)` : ""}`
    );
  }
  console.log("");
  console.log(`Generative (Haiku confirm over live rung-2 nominations):`);
  console.log(`  positives fired:   ${truePos.length}/${positives.length}`);
  console.log(
    `  false negatives:   ${falseNeg.length}/${positives.length}` +
      ` (${fnAtNomination.length} died at nomination, ${fnAtConfirm.length} at confirm)`
  );
  console.log(`  negatives quiet:   ${trueNeg.length}/${negatives.length}`);
  console.log(`  false positives:   ${falsePos.length}/${negatives.length}`);
  console.log(`  mean confirm latency: ${meanMs !== null ? `${meanMs}ms` : "n/a"}`);
  console.log("");
  console.log(
    `Discriminative arm: corpus is ${CORPUS.length} labeled turns; ADR-024 puts the ` +
      `fine-tune floor at ~50-200. ${CORPUS.length < 50 ? "BELOW floor — not trainable on current data." : "At/above floor."}`
  );

  const json = {
    corpusSize: CORPUS.length,
    generative: {
      truePositives: truePos.length,
      falseNegatives: falseNeg.length,
      falseNegativesAtNomination: fnAtNomination.length,
      falseNegativesAtConfirm: fnAtConfirm.length,
      trueNegatives: trueNeg.length,
      falsePositives: falsePos.length,
      meanConfirmLatencyMs: meanMs,
    },
    rows,
  };
  console.log("");
  console.log(JSON.stringify(json));

  // Pass condition for the pilot run itself: zero false positives among the
  // negatives (ADR-024 sign-off (b)'s axis). A degraded turn is NOT a failure:
  // degradation is the designed fail-to-Rung-1 fallback, it fails in the quiet
  // direction, and live-API latency spikes (observed: 1.1-2.5s typical, 5s+
  // occasionally) would otherwise make this artifact flaky. Degradations are
  // reported above so a run that leaned on the fallback is visible.
  const degradedCount = rows.filter((r) => r.degraded !== null).length;
  if (degradedCount > 0) {
    console.log(`NOTE: ${degradedCount} turn(s) degraded (fail-safe direction; reported above).`);
  }
  process.exit(falsePos.length === 0 ? 0 : 1);
}

main();
