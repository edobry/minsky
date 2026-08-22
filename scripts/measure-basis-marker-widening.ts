#!/usr/bin/env bun
/**
 * Measure a candidate `BASIS_PATTERNS` widening against the real dispatch corpus (mt#4385).
 *
 * ## What this answers
 *
 * mt#3861 established the bar any change to this predicate must clear, and it is NOT
 * "does it fix the target fire". `BASIS_PATTERNS` is consumed as a SUPPRESSOR — recognizing
 * a basis makes the detector NOT fire — so widening it always buys fewer fires. mt#3861
 * rejected two candidate widenings on exactly this ground: both flipped 4 of 5 bare windows
 * and marked 96.3% of the whole corpus, which "does not buy recall — it buys silence."
 *
 * So the number that decides a candidate is the **marked fraction over the whole corpus**,
 * reported beside the current patterns' fraction. A candidate that moves it materially toward
 * 100% is rejected however well it does on the target.
 *
 * ## Egress
 *
 * This script makes NO network call and constructs no provider client. It is pure regex over
 * local text, and it prints aggregate counts plus the matched MARKER SUBSTRING only — never a
 * prompt window, never surrounding prose. That is a deliberate difference from its sibling
 * `calibrate-basis-nomination.ts`, which embeds windows and therefore gates its corpus send
 * (PR #3033 R1). Nothing here needs that gate because nothing here leaves the process.
 *
 * ## Usage
 *
 *   bun scripts/measure-basis-marker-widening.ts
 *   bun scripts/measure-basis-marker-widening.ts --transcript-dir <dir> --limit 500
 *
 * Exits 0 when the corpus is readable and the report prints; exits 1 when the candidate fails
 * the nullification bar, so this doubles as a regression floor; exits 0 with a SKIP when no
 * transcript corpus is present (a fresh machine), because an absent corpus is not a failure.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  analyzeNegativeConstraints,
  BASIS_PATTERNS,
  BASIS_WINDOW_CHARS,
} from "@minsky/domain/validation/negative-constraint";

/**
 * The SHIPPED citation marker (mt#4385) — no directory required.
 *
 * This must stay byte-identical to the entry in `BASIS_PATTERNS`; the lookup below fails loudly
 * if it drifts, rather than silently measuring nothing.
 */
const SHIPPED_BARE_FILENAME = /\b[\w-]+\.(?:ts|tsx|js|json|md|mdc|sql|ya?ml)\b/i;

/**
 * The PRE-mt#4385 form, whose leading `\w+\/` made a directory mandatory — so `src/foo.ts` was
 * a citation and a bare `foo.ts` was not, though the docblock credits "a file path" either way.
 *
 * **This is what makes the script a regression floor rather than a tautology.** The obvious
 * shape — measure "current patterns" against "current + candidate" — reports a +0.00pp delta
 * and zero flips the moment the candidate ships, because it is then comparing the shipped set
 * against itself. That is a probe that can no longer fail (mem#704), and it read as a clean
 * PASS on the first post-ship run of this very script. Measuring shipped-vs-baseline instead
 * keeps both directions live: the delta still catches an over-wide future edit, and
 * {@link TARGET_FIRE} still catches a revert.
 */
const BASELINE_CITATION = /\b\w+\/[\w./-]+\.(?:ts|tsx|js|json|md|mdc|sql|ya?ml)\b/i;

/**
 * The 2026-08-19T20:22 calibration fire this widening exists to fix, verbatim from the record's
 * `excerpt`. If the widening is ever reverted, this stops being credited and the script exits
 * non-zero — the revert direction of the floor.
 */
const TARGET_FIRE =
  "DO NOT try to route transcripts through postgres-vector-storage.ts in this task. " +
  'The spec\'s "What use the common infra actually costs" section explains why: that layer ' +
  "is single-table, single-id, equal-dimension.";

/**
 * The nullification bar, stated as a number so the exit code can enforce it.
 *
 * mt#3861 rejected candidates at 96.3% against a 93.9% baseline. The bar here is deliberately
 * expressed as a DELTA rather than an absolute: the baseline moves as the corpus grows, and
 * what mt#3861's rejection actually turned on was a widening that swallowed most of the
 * remaining unmarked population.
 */
const MAX_MARKED_FRACTION_DELTA_PCT = 1.5;

/**
 * An ABSOLUTE ceiling on the marked fraction, checked against the whole shipped set.
 *
 * The delta above is scoped to the citation pattern, which leaves a hole this script was
 * measured to have: add an over-wide pattern ANYWHERE ELSE in `BASIS_PATTERNS` and the baseline
 * and shipped sets both inherit it, so the delta stays at +0.00pp and the run PASSES — while the
 * corpus sits at 100.0% marked and the category is fully nullified. Observed directly by
 * inserting `/\.\s+\S/` (any sentence boundary) during mt#4385's verification.
 *
 * 95% sits below the 96.3% that mt#3861 rejected two candidates at, and well above the 88.7%
 * the shipped set measures — so it fires on nullification without being tripped by ordinary
 * corpus drift.
 */
const MAX_MARKED_FRACTION_ABSOLUTE_PCT = 95;

interface Window {
  text: string;
  rung1HasBasis: boolean;
}

function defaultTranscriptDir(): string {
  // Same derivation as calibrate-basis-nomination.ts: flatten cwd rather than hardcode one
  // operator's path, normalizing the separator first so it holds on Windows too.
  const flattened = process.cwd().replace(/\\/g, "/").replace(/[/.:]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", flattened);
}

function collectDispatchPrompts(transcriptDir: string, limit?: number): string[] {
  let files: string[];
  try {
    files = fs
      .readdirSync(transcriptDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(transcriptDir, f));
  } catch {
    // intentional-swallow: an absent transcript dir means an empty corpus, which the caller
    // reports as a SKIP rather than a failure.
    return [];
  }

  const prompts: string[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      // intentional-swallow: one unreadable transcript must not abort the sweep.
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "" || !line.includes('"prompt"')) continue;
      try {
        const rec = JSON.parse(line) as {
          message?: { content?: { type?: string; name?: string; input?: { prompt?: string } }[] };
        };
        for (const block of rec.message?.content ?? []) {
          if (block.type !== "tool_use") continue;
          if (block.name !== "Task" && block.name !== "Agent") continue;
          const p = block.input?.prompt;
          if (typeof p === "string" && p.trim().length > 0) prompts.push(p);
        }
      } catch {
        // intentional-swallow: a torn line is expected in a live-appended log.
        continue;
      }
      if (limit !== undefined && prompts.length >= limit) return prompts;
    }
  }
  return prompts;
}

/** Every prohibition window in the corpus, labeled by Rung 1's CURRENT verdict. */
function collectWindows(prompts: string[]): Window[] {
  const windows: Window[] = [];
  for (const prompt of prompts) {
    const report = analyzeNegativeConstraints(prompt);
    for (const finding of report.findings) {
      const start = Math.max(0, finding.index - BASIS_WINDOW_CHARS);
      windows.push({
        text: prompt.slice(start, finding.index + BASIS_WINDOW_CHARS),
        rung1HasBasis: finding.hasBasis,
      });
    }
  }
  return windows;
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;
}

function main(): number {
  const argv = process.argv.slice(2);
  const dirFlag = argv.indexOf("--transcript-dir");
  const limitFlag = argv.indexOf("--limit");
  const transcriptDir = dirFlag >= 0 ? (argv[dirFlag + 1] as string) : defaultTranscriptDir();
  const limit = limitFlag >= 0 ? Number(argv[limitFlag + 1]) : undefined;

  const prompts = collectDispatchPrompts(transcriptDir, limit);
  if (prompts.length === 0) {
    console.log(`SKIP: no dispatch prompts found under ${transcriptDir}`);
    return 0;
  }

  // Fail loudly if the shipped pattern drifted from this script's copy of it — otherwise the
  // baseline below would be identical to the shipped set and every run would report +0.00pp.
  if (!BASIS_PATTERNS.some((p) => p.source === SHIPPED_BARE_FILENAME.source)) {
    console.log(
      "FAIL: BASIS_PATTERNS no longer contains this script's copy of the mt#4385 citation " +
        "pattern. Re-sync SHIPPED_BARE_FILENAME before trusting any number below."
    );
    return 1;
  }
  const baseline = BASIS_PATTERNS.map((p) =>
    p.source === SHIPPED_BARE_FILENAME.source ? BASELINE_CITATION : p
  );

  const windows = collectWindows(prompts);
  const bare = windows.filter((w) => !baseline.some((p) => p.test(w.text)));

  const markedNow = windows.length - bare.length;
  // The widening is ADDITIVE: a window the baseline marks stays marked, so every flip is a
  // bare window gaining a basis and none can go the other way.
  const flipped = bare.filter((w) => BASIS_PATTERNS.some((p) => p.test(w.text)));
  const markedAfter = markedNow + flipped.length;

  const beforePct = (markedNow / windows.length) * 100;
  const afterPct = (markedAfter / windows.length) * 100;
  const delta = afterPct - beforePct;

  console.log(`corpus: ${prompts.length} dispatch prompts, ${windows.length} prohibition windows`);
  console.log("");
  console.log("| Predicate | Marks basis-bearing | Of the currently-bare, flips |");
  console.log("| --- | --- | --- |");
  console.log(
    `| Baseline: pre-mt#4385 (directory required) | ${markedNow} / ${windows.length} (${pct(markedNow, windows.length)}) | — (${bare.length} remain bare) |`
  );
  console.log(
    `| Shipped: bare filename counts (${BASIS_PATTERNS.length} patterns) | ${markedAfter} / ${windows.length} (${pct(markedAfter, windows.length)}) | ${flipped.length} of ${bare.length} (${pct(flipped.length, bare.length)}) |`
  );
  console.log("");
  console.log(
    `marked-fraction delta: +${delta.toFixed(2)} pp (bar: <= ${MAX_MARKED_FRACTION_DELTA_PCT} pp)`
  );

  // Print the MARKER each flip matched — not the window. Enough to audit what the pattern is
  // actually crediting as a citation, without emitting dispatch prose.
  const markers = new Map<string, number>();
  for (const w of flipped) {
    const m = w.text.match(SHIPPED_BARE_FILENAME);
    if (m) markers.set(m[0], (markers.get(m[0]) ?? 0) + 1);
  }
  if (markers.size > 0) {
    console.log("");
    console.log("markers credited (substring only):");
    for (const [marker, count] of [...markers].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count}x  ${marker}`);
    }
  }

  // The REVERT direction of the floor: the fire this widening exists to fix must still read
  // basis-bearing. A corpus-level delta alone cannot catch a revert, because removing the
  // widening also removes the flips it is measured by — the delta simply goes to 0.00pp, which
  // is indistinguishable from "no change needed".
  const targetStillFixed = analyzeNegativeConstraints(TARGET_FIRE).bare.length === 0;
  console.log("");
  console.log(
    `target fire (2026-08-19T20:22) reads basis-bearing: ${targetStillFixed ? "yes" : "NO"}`
  );

  if (!targetStillFixed) {
    console.log("");
    console.log(
      "FAIL: the 2026-08-19 fire is bare again — the mt#4385 citation widening has been " +
        "reverted or narrowed. See packages/domain/src/validation/negative-constraint.ts."
    );
    return 1;
  }

  if (afterPct > MAX_MARKED_FRACTION_ABSOLUTE_PCT) {
    console.log("");
    console.log(
      `FAIL: the shipped patterns mark ${afterPct.toFixed(1)}% of the corpus as basis-bearing, ` +
        `past the ${MAX_MARKED_FRACTION_ABSOLUTE_PCT}% ceiling. The category is nullified — it ` +
        "suppresses nearly every prohibition it sees. Note the delta check above cannot catch " +
        "this when the over-wide pattern is not the citation one."
    );
    return 1;
  }

  if (delta > MAX_MARKED_FRACTION_DELTA_PCT) {
    console.log("");
    console.log(
      `FAIL: the shipped patterns move the marked fraction by ${delta.toFixed(2)} pp over the ` +
        `pre-mt#4385 baseline, past the ${MAX_MARKED_FRACTION_DELTA_PCT} pp bar. This is the ` +
        "nullification mt#3861 rejected two candidates for."
    );
    return 1;
  }

  console.log("");
  console.log("PASS: the shipped patterns clear the nullification bar and fix the target fire.");
  return 0;
}

process.exit(main());
