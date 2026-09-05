#!/usr/bin/env bun
/**
 * mt#5004 SC1 — measure the `principal-reserved` class's RECALL against the
 * delegation-boundary incidents it exists to catch.
 *
 * ## What question this answers
 *
 * ADR-024 assigns the recall/paraphrase axis to Rung 2 **"only if paraphrase
 * misses recur"**, gated on **"a measured recall-miss rate"**. mt#5004 entered
 * planning with exactly ONE measured miss (R10). One miss is an anecdote; this
 * script is what turns it into a rate, and SC2 does not get to pick a mechanism
 * until it has run.
 *
 * ## Why the corpus is inline rather than read from the calibration log
 *
 * The log records what DID fire. A recall measurement needs the population that
 * SHOULD have fired, and the misses are by construction absent from it — the
 * originating incident (R10) has no record at all. So the corpus is the
 * delegation-boundary family's own recurrence table (mem#367 `## Recurrences`),
 * which is the only place the missed texts survive.
 *
 * Same reasoning as `scripts/replay-settled-decision.ts`'s inline corpus, with
 * one difference worth naming: that script's cases were truncated in the log,
 * these ones were never in it.
 *
 * ## The control set is what makes a miss evidence (mem#704)
 *
 * A replay that reports "0 of N fired" is indistinguishable from a broken
 * import, a stale export, or a mis-called matcher. So the corpus carries three
 * CONTROLS drawn verbatim from the live calibration log — records that are on
 * disk as having fired. If any control fails to fire, this script exits non-zero
 * and its recall counts mean nothing: the probe is broken, not the detector.
 *
 * ## Bound on the corpus, stated rather than implied
 *
 * These texts are quotations held in a memory record, not raw transcript. Two
 * consequences a reader should carry:
 *
 * - **Elision.** Where mem#367 itself elided mid-quote, the case is marked
 *   `elided: true`. The patterns are all sentence-local, so an ellipsis BETWEEN
 *   sentences cannot change a verdict; one INSIDE the matched clause could, and
 *   no case in this corpus has that shape (checked by hand against each quote).
 * - **R6 is not testable.** mem#367 records R6's principal reply and the
 *   agent's option-preview text, but no verbatim deferral SENTENCE. It is
 *   listed as `unquotable` and excluded from the denominator rather than
 *   silently counted either way.
 *
 * USAGE
 *   bun scripts/replay-principal-reserved-recall.ts [--verbose]
 *
 * Exit 0 = the control floor held and the measurement is trustworthy.
 * Exit 1 = a control was silenced; the measurement is void, fix the probe.
 */

import { detectDeferralPhrases } from "../.minsky/hooks/ask-routing-deferral-detector";

interface Case {
  /** Family recurrence id, or a control label. */
  readonly id: string;
  readonly date: string;
  /** Where the text comes from, so a reader can re-derive it. */
  readonly provenance: string;
  readonly text: string;
  /**
   * True when mem#367 elided mid-quote.
   *
   * **The invariant this flag asserts, stated where the flag lives (PR #3654 R1).**
   * Every pattern in `PRINCIPAL_RESERVED_PATTERNS` is sentence-local — the widest
   * spans a bounded phrase like `your call to make`, none crosses a sentence
   * boundary — so an ellipsis BETWEEN sentences or clauses cannot change a
   * verdict. One INSIDE a matched clause could, by removing the very words a
   * pattern needs or by joining two fragments into a phrase neither contained.
   *
   * No case in this corpus has that shape, checked by hand against each quote
   * rather than assumed: R8.halt's ellipsis sits between two clauses of the
   * citation, and R10's between two complete sentences. **A new case with an
   * intra-clause ellipsis must not be added without re-deriving its text from
   * the transcript** — the flag would be true and the verdict would be junk.
   */
  readonly elided?: boolean;
}

/**
 * The delegation-boundary recurrences, verbatim from mem#367 `## Recurrences`.
 *
 * Every one of these is a turn-end deferral the family recorded as a FAILURE —
 * the agent handed the principal a decision with no nameable reserved category,
 * and the principal replied asking what the decision was. That is precisely the
 * population `principal-reserved` exists to catch, which is what makes a miss
 * here a recall defect rather than a matter of taste.
 */
const RECURRENCES: Case[] = [
  {
    id: "R5",
    date: "2026-08-03",
    provenance: "mem#367 §Recurrences R5 (mt#3592 halt); complete sentence, no elision",
    text: "blocked on a principal decision: re-attempting the change that took production down is your call.",
  },
  {
    id: "R7",
    date: "2026-08-14",
    provenance: "mem#367 §Recurrences R7 (MCP-restart turn-end deferral); complete sentence",
    text: "**If you restart the MCP server you'll destroy the repro**, so that's your call to make before I dig further — I stopped rather than walk it forward.",
  },
  {
    id: "R8.offer",
    date: "2026-08-16",
    provenance: "mem#367 §Recurrences R8, the turn-closing offer; complete fragment",
    text: "say the word and I'll continue, or redirect",
  },
  {
    id: "R8.halt",
    date: "2026-08-16",
    provenance: "mem#367 §Recurrences R8, the halt that followed; elided BETWEEN clauses",
    elided: true,
    text: "Holding here, under the first legitimate halt: you interrupted the running turn with 'hold on' — that's an explicit pause on implementation.",
  },
  {
    id: "R10",
    date: "2026-09-04",
    provenance: "mem#367 §Recurrences R10 (mt#1897 closeout); elided BETWEEN sentences",
    elided: true,
    text: "**Your call:** mt#4996's cheapest option is 'accept the cadence'. Worth doing before you spend engineering on stall detection.",
  },
];

/**
 * R6 has no verbatim deferral sentence in the family record.
 *
 * Counted here so the denominator is honest about what it could not test,
 * rather than the corpus quietly being "the four I had quotes for".
 */
const UNQUOTABLE: ReadonlyArray<{ id: string; date: string; why: string }> = [
  {
    id: "R6",
    date: "2026-08-08",
    why: "mem#367 records the principal's reply and the agent's option-preview text, but no verbatim deferral sentence from the halting turn",
  },
];

/**
 * Controls — verbatim `matches[].context` values from the live calibration log
 * (`ask-routing-deferral-calibration.jsonl`, 2026-08-30 → 2026-09-05), each
 * recorded there as a `principal-reserved` match.
 *
 * These must fire. They are not a claim that the fires were CORRECT — every one
 * of them was classified a false positive in mt#5004's gap report — only that
 * the matcher reaches them, which is what licenses reading a non-match above as
 * a property of the detector rather than of this script.
 */
const CONTROLS: Case[] = [
  {
    id: "CTL.needs-your-call",
    date: "2026-09-02",
    provenance: "calibration log 2026-09-02T21:06:56.021Z",
    text: "- **[mt#4682](minsky://task/mt%234682)** needs your call on what the Workspace panel should say when a workspace has been cleaned up — customer-facing copy.",
  },
  {
    id: "CTL.until-you-decide",
    date: "2026-08-31",
    provenance: "calibration log 2026-08-31T22:41:15.976Z",
    text: "Open on your side: whether the drive gets its own noun or composite treatment, and the interior-depth question from earlier. Both are on the specs; neither is blocking anything until you decide.",
  },
  {
    id: "CTL.before-you-decide",
    date: "2026-08-31",
    provenance: "calibration log 2026-08-31T21:45:55.510Z",
    text: "Worth me checking that RFC's actual status and whether its phases landed before you decide?",
  },
];

/**
 * Three outcomes, not two — and the middle one is why this script was corrected.
 *
 * A first cut filtered to `principal-reserved` and reported everything else as a
 * miss. That OVERSTATED the finding: R8's turn-closing offer matches
 * `deferral-menu:"say the word"`, so the detector DID see that turn and DID emit
 * an advisory — the sibling class's one. Counting it as a recall miss counts a
 * turn the detector reached.
 *
 * The distinction decides what a remedy would buy. `invisible` is a turn no
 * advisory reached at all; `wrong-class` is a turn that got one aimed at a
 * different behaviour. Only the first is evidence for recall-widening, and
 * ADR-024's climb gate should be read against that count alone.
 */
type Verdict = "principal-reserved" | "wrong-class" | "invisible";

interface Outcome {
  readonly c: Case;
  readonly verdict: Verdict;
  /** Every match, any class — so a wrong-class hit is visible rather than dropped. */
  readonly matches: string[];
}

/** Run one case through the shipped matcher, keeping ALL classes. */
function run(c: Case): Outcome {
  const all = detectDeferralPhrases(c.text);
  const verdict: Verdict = all.some((m) => m.cls === "principal-reserved")
    ? "principal-reserved"
    : all.length > 0
      ? "wrong-class"
      : "invisible";
  return { c, verdict, matches: all.map((m) => `${m.cls}:${JSON.stringify(m.matchedPhrase)}`) };
}

const MARK: Record<Verdict, string> = {
  "principal-reserved": "FIRED      ",
  "wrong-class": "WRONG-CLASS",
  invisible: "INVISIBLE  ",
};

function report(label: string, outcomes: Outcome[], verbose: boolean): void {
  console.log(`\n${label}`);
  for (const o of outcomes) {
    const detail = o.matches.length > 0 ? ` -> ${o.matches.join(", ")}` : "";
    console.log(`  ${MARK[o.verdict]}  ${o.c.id.padEnd(22)} ${o.c.date}${detail}`);
    if (verbose) {
      console.log(`          provenance: ${o.c.provenance}${o.c.elided ? " [elided]" : ""}`);
      console.log(`          text: ${o.c.text}`);
    }
  }
}

function main(): void {
  const verbose = process.argv.includes("--verbose");

  const controls = CONTROLS.map(run);
  const recurrences = RECURRENCES.map(run);

  report("CONTROLS (must all fire — otherwise the measurement below is void):", controls, verbose);
  report("RECURRENCES (the population the class exists to catch):", recurrences, verbose);

  const silencedControls = controls.filter((o) => o.verdict !== "principal-reserved");
  if (silencedControls.length > 0) {
    console.error(
      `\nPROBE BROKEN: ${silencedControls.length} of ${controls.length} controls did not fire ` +
        `principal-reserved (${silencedControls.map((o) => o.c.id).join(", ")}). ` +
        "The recall figures above mean nothing until this is fixed."
    );
    process.exit(1);
  }

  const invisible = recurrences.filter((o) => o.verdict === "invisible");
  const wrongClass = recurrences.filter((o) => o.verdict === "wrong-class");
  const correct = recurrences.filter((o) => o.verdict === "principal-reserved");

  // Distinct INCIDENTS, not cases: R8 contributes two texts from one incident,
  // and a rate over cases would overstate recurrence by counting it twice.
  //
  // PR #3654 R1 flagged this as fragile "if ids adopt deeper dot-separated
  // forms". Checked rather than adopted: `split(".")[0]` takes the FIRST
  // segment at any depth — `"R8.a.b"` yields `"R8"` exactly as `"R8.offer"`
  // does — so the stated mechanism does not hold and no fix is made for it.
  //
  // The real coupling, which the finding is right to point at even though its
  // mechanism is wrong: this derivation assumes `<incidentId>.<variant>`, so a
  // corpus that switched separators (`R8-offer`) or nested a dot INSIDE an
  // incident id would silently split incidents apart and inflate the headline
  // count. That invariant is now stated here; the ids are a closed set defined
  // twenty lines up, so a test would only restate the constant.
  const incident = (o: Outcome): string => o.c.id.split(".")[0] ?? o.c.id;
  const invisibleIncidents = new Set(invisible.map(incident));
  const reachedIncidents = new Set([...correct, ...wrongClass].map(incident));
  for (const id of reachedIncidents) invisibleIncidents.delete(id);

  // PR #3654 R1: report the COMPUTED count, not `controls.length` twice. The
  // early exit above means the two are equal whenever this line is reached, so
  // the old form could never print anything but "N of N" — a metric that cannot
  // disagree with itself carries no information (mem#704), and it would go on
  // reading correct if the exit above were ever relaxed to a warning.
  const firingControls = controls.filter((o) => o.verdict === "principal-reserved").length;

  console.log("\n--- Recall measurement ---");
  console.log(`  controls firing principal-reserved: ${firingControls} of ${controls.length}`);
  console.log(`  recurrence texts tested:            ${recurrences.length}`);
  console.log(
    `    matched principal-reserved:       ${correct.length}  (${correct.map((o) => o.c.id).join(", ") || "-"})`
  );
  console.log(
    `    matched only a SIBLING class:     ${wrongClass.length}  (${wrongClass.map((o) => o.c.id).join(", ") || "-"})`
  );
  console.log(
    `    matched NOTHING, any class:       ${invisible.length}  (${invisible.map((o) => o.c.id).join(", ") || "-"})`
  );
  console.log(
    `  untestable:                         ${UNQUOTABLE.length}  (${UNQUOTABLE.map((u) => u.id).join(", ")})`
  );
  for (const u of UNQUOTABLE) console.log(`      ${u.id} (${u.date}): ${u.why}`);

  console.log(
    `\n  DISTINCT INCIDENTS no advisory reached at all: ${invisibleIncidents.size}` +
      ` (${[...invisibleIncidents].join(", ") || "-"})`
  );
  console.log(
    '  Read ADR-024\'s climb gate — "only if paraphrase misses recur" — against THAT count.\n' +
      "  An incident reached by a sibling class got an advisory, just the wrong one; that is a\n" +
      "  routing question, not a recall one, and it is deliberately not counted here."
  );
}

if (import.meta.main) main();
