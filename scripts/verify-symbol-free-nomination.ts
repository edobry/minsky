#!/usr/bin/env bun
/**
 * Live check for the symbol-free Rung-2 cohort (mt#3726).
 *
 * The unit tests inject a stub nominator, so they answer "does a nominated
 * segment become a symbol-free claim of the right family?" and are structurally
 * silent on the question that actually decides whether this ships usefully:
 * **does the real embedding score these sentences above threshold against these
 * exemplars, and does it leave the negative control alone?** That needs a live
 * provider, which is what this script supplies.
 *
 * Reports per-fixture cosine scores rather than a bare pass/fail, because the
 * threshold itself is unmeasured on this corpus — `DEFAULT_SIMILARITY_THRESHOLD`
 * (0.455) was derived from the retrospective-trigger exemplar band. The scores
 * this prints ARE the measurement the calibration review needs in order to pick
 * one, so a run that "fails" the default threshold is still a useful result.
 *
 * Emits family names, sentences and scores only. The fixtures are checked-in
 * literals from task specs and memories — no operator transcript data is read,
 * and nothing is sent anywhere except the fixture text below, which is embedded
 * by the configured provider in order to be scored.
 *
 * Usage:
 *   bun scripts/verify-symbol-free-nomination.ts
 *
 * Exit codes: 0 = every class fixture nominated and the control stayed quiet,
 * or the provider is absent (SKIP). 1 = a fixture missed or the control fired.
 */

import {
  nominate,
  DEFAULT_SIMILARITY_THRESHOLD,
} from "../packages/domain/src/detectors/embedding-nomination";
import { resolveNominationDeps } from "../packages/domain/src/detectors/embedding-nomination-factory";
import {
  SYMBOL_FREE_EXEMPLAR_SETS,
  INVOCATION_PATH_POSITIVE_FAMILY,
  INVOCATION_PATH_NEGATIVE_FAMILY,
  SUBSYSTEM_PROPERTY_FAMILY,
  EXTERNAL_SYSTEM_FAMILY,
  LOG_ATTRIBUTION_FAMILY,
} from "../.minsky/hooks/code-mechanism-assertion-detector";

/** One real sentence per class, quoted from the incident that produced it. */
const FIXTURES: ReadonlyArray<{ family: string; sentence: string; origin: string }> = [
  {
    family: INVOCATION_PATH_POSITIVE_FAMILY,
    sentence: "The missing rows self-heal on the next scheduled run.",
    origin: "mt#3708 / mem#873",
  },
  {
    family: INVOCATION_PATH_NEGATIVE_FAMILY,
    sentence: "You'll need to run that manually; it won't refresh on its own.",
    origin: "mem#873 R2",
  },
  {
    family: SUBSYSTEM_PROPERTY_FAMILY,
    sentence: "Two of the three cockpit daemons are stale.",
    origin: "mem#1087",
  },
  {
    family: EXTERNAL_SYSTEM_FAMILY,
    sentence: "The repo auto-closes issues after 60 days via a workflow bug.",
    origin: "mt#3726 §Sibling shape",
  },
  {
    family: LOG_ATTRIBUTION_FAMILY,
    sentence: "The log shows an unhandled rejection, so the boot migration failure is unhandled.",
    origin: "mem#1123 R9",
  },
];

/** Naming your own caller is the encouraged shape — it must not be nominated. */
const NEGATIVE_CONTROL = "The `transcripts spawns-extract --all` command runs this.";

async function main(): Promise<void> {
  const deps = await resolveNominationDeps();
  if (deps === null || !deps.semantic) {
    console.log("SKIP: no semantic embedding provider configured — this check needs live Rung 2.");
    process.exit(0);
  }

  console.log(`threshold: ${DEFAULT_SIMILARITY_THRESHOLD}`);
  const sets = SYMBOL_FREE_EXEMPLAR_SETS.map((s) => ({ ...s }));
  let failures = 0;

  for (const { family, sentence, origin } of FIXTURES) {
    const result = await nominate(sentence, sets, deps);
    if (result.degraded) {
      console.log(`DEGRADED ${family}: ${result.degradedReason ?? "unknown"}`);
      failures++;
      continue;
    }
    // Report EVERY family's score, not just the expected one: a fixture that
    // nominates under a sibling family is a real finding about the exemplar
    // sets, and reporting only the expected family would hide it.
    const scores = result.nominations.map((n) => `${n.family}=${n.score.toFixed(3)}`).join(" ");
    const hit = result.nominations.find((n) => n.family === family);
    const ok = hit !== undefined;
    if (!ok) failures++;
    console.log(
      `${ok ? "PASS" : "MISS"} ${family} (${origin}) [${scores || "none above threshold"}]`
    );
  }

  const control = await nominate(NEGATIVE_CONTROL, sets, deps);
  const controlFired = !control.degraded && control.nominations.length > 0;
  if (controlFired) failures++;
  console.log(
    `${controlFired ? "FAIL" : "PASS"} negative-control [${
      control.nominations.map((n) => `${n.family}=${n.score.toFixed(3)}`).join(" ") || "quiet"
    }]`
  );

  console.log(failures === 0 ? "RESULT: pass" : `RESULT: ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
