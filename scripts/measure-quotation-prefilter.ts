#!/usr/bin/env bun
/**
 * Measure mt#4386's quotation prefilter (ADR-024 Rung 1) against the real dispatch corpus.
 *
 * Sibling of `measure-basis-marker-widening.ts`, which does the same job for mt#4385's BASIS
 * widening. Both answer the question mt#4386 criterion 2 asks: what does this change do across
 * the WHOLE corpus, **in both directions** — not just to the two records that motivated it.
 *
 * ## How BEFORE is reconstructed, and why it is not the shipped function
 *
 * mem#1208 records the trap this script is built to avoid: mt#4454's first delta probe called the
 * same patched function on both sides and reported "0 changed" — a clean, plausible, meaningless
 * zero. The shipped `analyzeNegativeConstraints` now elides INTERNALLY, so it cannot be its own
 * baseline.
 *
 * BEFORE is reconstructed here from the module's own exported `PROHIBITION_PATTERNS` /
 * `BASIS_PATTERNS` / `BASIS_WINDOW_CHARS`, matching on RAW text. That is a faithful pre-fix
 * replica because the fix changed exactly one thing — which string the prohibition matcher reads.
 * The basis window read raw text before the change and still does, so `hasBasis` needs no
 * reconstruction.
 *
 * **The reconstruction is not trusted on faith.** `assertCanaries()` runs first and exits non-zero
 * unless BEFORE and AFTER actually disagree on a known quoted case and actually agree on a known
 * bare one. A baseline that silently equals the shipped path would fail there rather than quietly
 * reporting a zero delta.
 *
 * ## Usage
 *
 *   bun scripts/measure-quotation-prefilter.ts [--limit N] [--dir <transcriptDir>] [--verbose]
 *
 * Exits 0 on a completed measurement (whatever the delta), 1 if a canary fails, and prints
 * `SKIP` + exits 0 when no transcripts are present, so CI without a local corpus is not a failure.
 */

import fs from "fs";
import path from "path";
import os from "os";
import {
  analyzeNegativeConstraints,
  PROHIBITION_PATTERNS,
  BASIS_PATTERNS,
  BASIS_WINDOW_CHARS,
} from "../packages/domain/src/validation/negative-constraint";

interface Finding {
  phrase: string;
  index: number;
  hasBasis: boolean;
}

/**
 * Pre-mt#4386 behaviour: match PROHIBITION_PATTERNS against RAW text.
 *
 * Mirrors the shipped loop exactly, including `matchesAny`'s non-resetting `.some(p.test(...))`
 * over BASIS_PATTERNS — a faithful replica must reproduce quirks, not correct them.
 */
function analyzeUnelided(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const pattern of PROHIBITION_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match !== null) {
      const windowStart = Math.max(0, match.index - BASIS_WINDOW_CHARS);
      const window = text.slice(windowStart, match.index + BASIS_WINDOW_CHARS);
      findings.push({
        phrase: match[0],
        index: match.index,
        hasBasis: BASIS_PATTERNS.some((p) => p.test(window)),
      });
      match = pattern.exec(text);
    }
  }
  return findings;
}

/** The default Claude Code transcript directory for this project. */
function defaultTranscriptDir(): string {
  const flattened = process.cwd().replace(/\\/g, "/").replace(/[/.:]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", flattened);
}

/** Extract every dispatch prompt from the local transcripts. */
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

/**
 * Prove the two sides can disagree AND can agree, before any count is believed.
 *
 * Without this the script is a can't-fail probe (mem#704): if the baseline silently equalled the
 * shipped path, every delta would read as a legitimate zero.
 */
function assertCanaries(): void {
  const quoted =
    'Read **"Don\'t Build Multi-Agents" (Walden Yan, 2025)** before dispatching this wave.';
  const bare = "The approach is blocked. Do not attempt it.";

  const quotedBefore = analyzeUnelided(quoted).length;
  const quotedAfter = analyzeNegativeConstraints(quoted).findings.length;
  const bareBefore = analyzeUnelided(bare).length;
  const bareAfter = analyzeNegativeConstraints(bare).findings.length;

  const failures: string[] = [];
  if (!(quotedBefore > 0 && quotedAfter === 0)) {
    failures.push(
      `quoted-title canary: expected BEFORE>0 and AFTER==0, got ${quotedBefore}/${quotedAfter}`
    );
  }
  if (!(bareBefore > 0 && bareAfter > 0)) {
    failures.push(
      `bare-prohibition canary: expected BOTH>0, got ${bareBefore}/${bareAfter}` +
        " — the prefilter is nullifying real prohibitions"
    );
  }

  if (failures.length > 0) {
    console.error("FAIL: baseline canaries did not hold; counts below would be meaningless.");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("canaries OK: baseline and shipped path disagree on quoted, agree on bare.\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const limitArg = args.indexOf("--limit");
  const dirArg = args.indexOf("--dir");
  const verbose = args.includes("--verbose");
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : undefined;
  const transcriptDir = dirArg >= 0 ? String(args[dirArg + 1]) : defaultTranscriptDir();

  assertCanaries();

  const prompts = collectDispatchPrompts(transcriptDir, limit);
  if (prompts.length === 0) {
    console.log(`SKIP: no dispatch prompts found under ${transcriptDir}`);
    return;
  }

  let beforeFindings = 0;
  let afterFindings = 0;
  let beforeBare = 0;
  let afterBare = 0;
  let promptsMatchedBefore = 0;
  let promptsMatchedAfter = 0;
  let promptsSuppressed = 0;
  let promptsGained = 0;
  const changed: { suppressed: number; gained: number; sample: string }[] = [];

  for (const prompt of prompts) {
    const before = analyzeUnelided(prompt);
    const after = analyzeNegativeConstraints(prompt);

    beforeFindings += before.length;
    afterFindings += after.findings.length;
    beforeBare += before.filter((f) => !f.hasBasis).length;
    afterBare += after.bare.length;
    if (before.length > 0) promptsMatchedBefore++;
    if (after.findings.length > 0) promptsMatchedAfter++;

    // Both directions, per mt#4386 criterion 2. A GAIN is the alarming one: elision must only
    // ever remove text, so a prompt gaining a match means offsets or ordering are wrong.
    if (after.findings.length < before.length) {
      promptsSuppressed++;
      changed.push({
        suppressed: before.length - after.findings.length,
        gained: 0,
        sample: prompt.slice(0, 160).replace(/\n/g, " "),
      });
    } else if (after.findings.length > before.length) {
      promptsGained++;
      changed.push({
        suppressed: 0,
        gained: after.findings.length - before.length,
        sample: prompt.slice(0, 160).replace(/\n/g, " "),
      });
    }
  }

  console.log(`corpus: ${prompts.length} dispatch prompts from ${transcriptDir}\n`);
  console.log("                       BEFORE    AFTER    delta");
  console.log(
    `prompts with >=1 match  ${String(promptsMatchedBefore).padStart(6)}   ${String(promptsMatchedAfter).padStart(6)}   ${afterMinus(promptsMatchedAfter, promptsMatchedBefore)}`
  );
  console.log(
    `total findings          ${String(beforeFindings).padStart(6)}   ${String(afterFindings).padStart(6)}   ${afterMinus(afterFindings, beforeFindings)}`
  );
  console.log(
    `bare findings           ${String(beforeBare).padStart(6)}   ${String(afterBare).padStart(6)}   ${afterMinus(afterBare, beforeBare)}`
  );
  console.log(`\nprompts with matches SUPPRESSED: ${promptsSuppressed}`);
  console.log(`prompts with matches GAINED:     ${promptsGained}  (must be 0)`);

  if (verbose) {
    console.log("\n--- changed records ---");
    for (const c of changed) {
      const dir = c.gained > 0 ? `+${c.gained} GAINED` : `-${c.suppressed} suppressed`;
      console.log(`${dir}  ${c.sample}`);
    }
  }

  if (promptsGained > 0) {
    console.error("\nFAIL: elision blanks characters in place and can only REMOVE matches.");
    process.exit(1);
  }
}

function afterMinus(after: number, before: number): string {
  const d = after - before;
  return d === 0 ? "     0" : String(d).padStart(6);
}

main();
