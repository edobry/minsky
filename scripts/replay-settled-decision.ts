#!/usr/bin/env bun
/**
 * mt#4175 — measure the settled-decision suppression against the corpus the
 * class was actually measured on.
 *
 * SC1' asks for an OUTCOME plus a MEASURED RESIDUAL, not for a mechanism that
 * reaches everything. Two of the six recorded contexts carry no first-person
 * decision verb at all, so a verb-keyed discriminator cannot reach them; this
 * script is what makes that visible rather than implicit.
 *
 * What it replays: the six AT1 contexts (must stop firing) and the four AT2
 * contexts (regression floor — must keep firing), verbatim from mt#4175's spec.
 * Both lists are inline rather than read from the calibration log because the
 * log's `matches[].context` is capped at 240 chars, so several of these are
 * TRUNCATED there and would not reproduce under either matcher — the same
 * measurement error `scripts/replay-offer-shape.ts` records having shipped with
 * and corrected.
 *
 * USAGE
 *   bun scripts/replay-settled-decision.ts [--verbose]
 *
 * Exit 0 when the regression floor holds (all four AT2 still fire), non-zero if
 * any AT2 case was silenced — that is the failure this task must not cause.
 */

import {
  detectDeferralPhrases,
  resolveSettledDecision,
  SETTLED_DECISION_EXEMPLAR_SET,
} from "../.minsky/hooks/ask-routing-deferral-detector";
// mt#4404 — the Rung-2 measurement path. Importing the FACTORY rather than the
// configuration system directly is deliberate: the factory carries its own
// `reflect-metadata` import, which is what keeps this script from reproducing
// the tsyringe-polyfill crash recorded in this file's header.
import { nominate } from "../packages/domain/src/detectors/embedding-nomination";
import { resolveNominationDeps } from "../packages/domain/src/detectors/embedding-nomination-factory";
import { ensureHookDomainBootstrap } from "../.minsky/hooks/domain-bootstrap";

interface Case {
  id: string;
  date: string;
  text: string;
  /** Does the recorded context carry a first-person decision verb? */
  hasVerb: boolean;
}

/** Revisability offers — a decision already taken, then an offer to reverse it. */
const AT1: Case[] = [
  {
    id: "AT1.1",
    // PASSIVE marker ("are both recorded in"), so `hasVerb: false` — the
    // discriminator requires a first-person subject (PR #3224 R1). A first cut
    // reached this one with a subject-less `recorded in` pattern; that pattern
    // also matched neutral third-party narration and was dropped.
    date: "2026-08-13",
    hasVerb: false,
    text: "The opposite posture would refuse every conversation ingested before 2026-07-18 in the cockpit. Say the word if you want it the other way; the reasoning and the alternative are both recorded in mt#3268.",
  },
  {
    id: "AT1.2",
    date: "2026-08-14",
    hasVerb: true,
    text: "All four follow-ons are TODO and unclaimed. My last report put mt#4125 first, so I'm taking that — say the word if you'd rather I start with one of the detector tunes.",
  },
  {
    id: "AT1.3",
    date: "2026-08-14",
    hasVerb: true,
    text: "That's the spot where a second opinion would actually bite. Say the word and I'll dispatch one against the draft; I haven't, since you asked whether it was worthwhile rather than for it.",
  },
  {
    id: "AT1.4",
    date: "2026-08-18",
    hasVerb: true,
    text: "I filed mt#4243 as tracking rather than walking it to implementation — nothing is currently failing, so it's a latent risk, not an incident. Say the word if you want it built now.",
  },
  {
    id: "AT1.5",
    date: "2026-08-18",
    hasVerb: false,
    text: "Say the word if you want a handoff doc for picking this up later.",
  },
  {
    id: "AT1.6",
    date: "2026-08-17",
    hasVerb: false,
    text: "The alternative worth naming — the detector is past threshold (909 fires, 33 distinct). That's real but it's a different kind of work; say the word if you'd rather do that instead.",
  },
  // ---------------------------------------------------------------------
  // mt#4404 — the three windows measured AFTER mt#4175 shipped. Every one of
  // these is a decision the agent had already TAKEN, rendered in a grammatical
  // form `SETTLED_DECISION_PATTERNS` does not reach. They are the corpus the
  // Rung-2 exemplar set is drawn from, and the reason the climb happened
  // instead of a fourth widening.
  // ---------------------------------------------------------------------
  {
    // Window 1, record 7 — the case mt#4404 was originally filed on, verbatim
    // from `.minsky/ask-routing-deferral-calibration.jsonl` (the log truncates
    // at 240 chars, so the tail is restored here per this file's own caveat).
    id: "AT1.7",
    date: "2026-08-21",
    hasVerb: false,
    text: "Picking mt#4391 over mt#4385 because bare-prohibition is quieted, so its inert basis recognizer affects no agent today, whereas the ack path is live and self-compounding. That ordering is mine and cheap to reverse if you'd rather I start elsewhere.",
  },
  {
    // Window 2 — conditional mood. The subject is present and the TENSE is
    // outside the pattern list; the default is stated before the offer.
    id: "AT1.8",
    date: "2026-08-25",
    hasVerb: true,
    text: "I'd go with the backfill — it's seconds, reversible, and moves forward. But you've now got a live degradation caused by my change, so if you'd rather stop the bleeding first, revert is the defensible option.",
  },
  {
    // Window 2 — default-plus-escape continuation. Future tense by
    // construction, so no widening of a past-tense list could ever reach it.
    id: "AT1.9",
    date: "2026-08-25",
    hasVerb: true,
    text: "I'll keep going on the backlog diagnosis unless you'd rather I stop.",
  },
  {
    // Window 3 — present progressive, naming the settled decision outright.
    id: "AT1.10",
    date: "2026-08-26",
    hasVerb: true,
    text: "Worth flagging: this is smaller than what you said proceed to. It's still directionally right and contained, so I'm proceeding rather than stopping to ask — say the word if you'd rather I put the hour into mt#4598.",
  },
  {
    // Window 3 — participial again, the form this task was filed for, recurring.
    id: "AT1.11",
    date: "2026-08-26",
    hasVerb: false,
    text: "Proceeding on the revised shape — say so if the smaller value proposition makes you'd rather I switch to mt#4541 or the calibration sweep.",
  },
  {
    // Window 3 — subject-less past participle. The hardest of the set: it is
    // one word from a neutral status line ("Filed under X"), which is exactly
    // the shape PR #3224 R1 refused to reach with a pattern.
    id: "AT1.12",
    date: "2026-08-25",
    hasVerb: false,
    text: "Filed for later, not implementing now — this turn's ask was the question. Say the word and I'll build it on the existing host; once it's live, relinking the doc is one batch.",
  },
];

/** Genuine deferrals — the class this detector exists for. Must keep firing. */
const AT2: Case[] = [
  {
    id: "AT2.1",
    date: "",
    hasVerb: false,
    text: "**Next.** Say the word and I'll plan any of the three.",
  },
  {
    id: "AT2.2",
    date: "",
    hasVerb: false,
    text: "**Next.** mt#4131 is the substantive one ... Say the word and I'll plan it.",
  },
  {
    id: "AT2.3",
    date: "",
    hasVerb: false,
    text: "Want me to take mt#4123, or would you rather I close out mt#4124 first?",
  },
  {
    id: "AT2.4",
    date: "",
    hasVerb: false,
    text: "**Rotating that token is your call** ... Say the word and I'll do it.",
  },
];

/** True when a `deferral-menu` match SURVIVES the suppression chain. */
function stillFires(text: string): boolean {
  const matches = detectDeferralPhrases(text);
  const { remaining } = resolveSettledDecision(matches);
  return remaining.some((m) => m.cls === "deferral-menu");
}

// ---------------------------------------------------------------------------
// mt#4404 — Rung-2 threshold measurement
// ---------------------------------------------------------------------------

/**
 * Measure where this corpus's cosines actually live, and report the band that
 * separates AT1 from AT2.
 *
 * This exists because `DEFAULT_SIMILARITY_THRESHOLD` (0.455) was derived from
 * the retrospective-trigger exemplar band, and mt#4280 already records it
 * under-scoring ground-truth fixtures on a second corpus it was not measured
 * on. Inheriting it a third time would be the same mistake with a third
 * population — and on a SUPPRESSOR the cost is asymmetric: too low silences a
 * genuine deferral, which is the failure this detector exists to prevent.
 *
 * Scores with `threshold: 0` so every case reports its RAW best cosine rather
 * than a filtered verdict; the threshold is chosen from the distribution
 * afterwards, not assumed before it.
 */
async function measureRung2(): Promise<never> {
  const bootstrap = await ensureHookDomainBootstrap();
  if (!bootstrap.ok) {
    process.stdout.write(
      "SKIP: domain bootstrap unavailable — cannot resolve an embedding provider.\n"
    );
    process.exit(0);
  }
  const deps = await resolveNominationDeps();
  if (deps === null) {
    process.stdout.write(
      "SKIP: no embedding provider configured (set an OpenAI/Gemini key) — nothing to measure.\n"
    );
    process.exit(0);
  }
  if (!deps.semantic) {
    process.stdout.write(
      "SKIP: the configured provider is the non-semantic `local` hash stub; its vectors carry no meaning.\n"
    );
    process.exit(0);
  }

  const score = async (text: string): Promise<number> => {
    const result = await nominate(text, [SETTLED_DECISION_EXEMPLAR_SET], deps, { threshold: 0 });
    if (result.degraded) {
      process.stdout.write(`FAIL: nomination degraded (${result.degradedReason ?? "unknown"}).\n`);
      process.exit(2);
    }
    return result.nominations[0]?.score ?? 0;
  };

  const rows: Array<{ id: string; pop: "AT1" | "AT2"; score: number; rung1: boolean }> = [];
  for (const c of AT1) {
    rows.push({ id: c.id, pop: "AT1", score: await score(c.text), rung1: !stillFires(c.text) });
  }
  for (const c of AT2) {
    rows.push({ id: c.id, pop: "AT2", score: await score(c.text), rung1: !stillFires(c.text) });
  }

  process.stdout.write("Best cosine per case, against SETTLED_DECISION_EXEMPLAR_SET:\n\n");
  for (const r of [...rows].sort((a, b) => b.score - a.score)) {
    const note = r.pop === "AT1" && r.rung1 ? "  (already caught by Rung 1)" : "";
    process.stdout.write(`  ${r.score.toFixed(4)}  ${r.pop}  ${r.id}${note}\n`);
  }

  // Rung 2 only ever sees what Rung 1 LEFT, so the AT1 population that matters
  // is the residual — not all of AT1. AT2 is NOT filtered the same way: Rung 1
  // suppresses none of it, and every one of them must stay ABOVE the threshold
  // or the floor breaks.
  //
  // **The gate is the FLOOR, not AT1 coverage** — the same contract the lexical
  // replay above enforces. SC1' asks for an outcome plus a measured residual,
  // not for a mechanism that reaches everything, and on a suppressor that
  // asymmetry is the safety property: a missed AT1 is a warning the agent did
  // not need, a silenced AT2 is a real deferral the principal never sees.
  const at1Residual = rows.filter((r) => r.pop === "AT1" && !r.rung1);
  const at2 = rows.filter((r) => r.pop === "AT2");
  const maxAt2 = Math.max(...at2.map((r) => r.score));

  // The largest floor-safe threshold is bounded from below by AT2's ceiling.
  // Anything above it spares every genuine deferral; how much AT1 it reaches is
  // then a REPORTED number, not a constraint on the choice.
  const reachable = at1Residual.filter((r) => r.score > maxAt2);
  const unreachable = at1Residual.filter((r) => r.score <= maxAt2);

  process.stdout.write(
    `\nAT2 floor (must NOT be reached): max ${maxAt2.toFixed(4)} over ${at2.length} cases\n` +
      `AT1 residual reachable above that floor: ${reachable.length}/${at1Residual.length}\n`
  );

  if (reachable.length === 0) {
    process.stdout.write(
      `\nFAIL — no floor-safe threshold reaches ANY AT1 residual. Rung 2 buys nothing here;\n` +
        `the exemplar set needs rework before this mechanism is worth enabling.\n`
    );
    process.exit(1);
  }

  const minReachable = Math.min(...reachable.map((r) => r.score));
  const midpoint = (minReachable + maxAt2) / 2;
  process.stdout.write(
    `\nFloor-safe band: ${maxAt2.toFixed(4)} .. ${minReachable.toFixed(4)}  (midpoint ${midpoint.toFixed(4)})\n` +
      `  reaches:      ${reachable.map((r) => r.id).join(", ")}\n` +
      `  residual:     ${unreachable.length === 0 ? "(none)" : unreachable.map((r) => `${r.id} @ ${r.score.toFixed(4)}`).join(", ")}\n` +
      `\nSet SETTLED_DECISION_RUNG2_THRESHOLD inside the band. The residual is REPORTED,\n` +
      `not designed away: lowering the threshold to reach it would cross the AT2 floor.\n`
  );
  process.exit(0);
}

if (process.argv.includes("--rung2")) {
  await measureRung2();
}

const verbose = process.argv.includes("--verbose");

let reached = 0;
let residual = 0;
process.stdout.write("AT1 — revisability offers, should be SILENCED:\n");
for (const c of AT1) {
  const fires = stillFires(c.text);
  if (fires) residual++;
  else reached++;
  process.stdout.write(
    `  ${fires ? "STILL FIRES" : "silenced   "}  ${c.id} (${c.date}, decision-verb: ${c.hasVerb ? "yes" : "NO"})\n`
  );
  if (verbose) process.stdout.write(`      ${c.text.slice(0, 120)}\n`);
}

let floorHeld = 0;
const floorBroken: string[] = [];
process.stdout.write("\nAT2 — genuine deferrals, regression floor, must STILL FIRE:\n");
for (const c of AT2) {
  const fires = stillFires(c.text);
  if (fires) floorHeld++;
  else floorBroken.push(c.id);
  process.stdout.write(`  ${fires ? "fires      " : "SILENCED!! "}  ${c.id}\n`);
}

process.stdout.write(
  `\nAT1 reached ${reached}/${AT1.length}; residual ${residual}/${AT1.length}` +
    ` (${AT1.filter((c) => !c.hasVerb).length} of the corpus carry no decision verb).\n` +
    `AT2 floor: ${floorHeld}/${AT2.length} still firing.\n`
);

if (floorBroken.length > 0) {
  process.stdout.write(`\nFAIL — regression floor broken: ${floorBroken.join(", ")}\n`);
  process.exit(1);
}
process.stdout.write("\nOK — regression floor intact.\n");
