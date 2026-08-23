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
} from "../.minsky/hooks/ask-routing-deferral-detector";

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
