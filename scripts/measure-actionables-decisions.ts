#!/usr/bin/env bun
/**
 * Measure the terminal-actionables-block corpus, and the shipped detector's recall over it (mt#4807).
 *
 * Why this exists. `ask-routing-deferral` matches deferral and offer PHRASING, so a
 * principal-owned decision written as a flat declarative inside the terminal actionables block
 * passes silently — the failure mt#4807 was filed on. ADR-024 will not let that be answered with
 * another regex family on a measured-miss argument alone: Rung 1 is the default and Rungs 2-3 are
 * "strictly evidence-gated" on a measured recall-miss rate. This script produces that rate's
 * denominator and the shipped matcher's behaviour over it, so the rung is chosen against numbers
 * rather than against the one incident.
 *
 * It also settles a claim the task's spec asserted without measuring: that the block is
 * "rule-delimited and machine-locatable". A nine-block hand census at planning time found roughly
 * half the instances carrying neither a rule nor a heading. This runs the same census over the
 * whole corpus.
 *
 * EGRESS — the complete set of channels this script writes to (mt#4191: enumerate every channel,
 * not just the one you were designing):
 *   - stdout: COUNTS ONLY — totals, per-marker-form tallies, per-bucket tallies. No unit text, no
 *     turn text, no file path from the corpus is ever printed, on any path including errors.
 *   - files written: NONE by default. With `--dump <path>`, candidate unit text is written to that
 *     path and nowhere else, so the operator chooses whether the text lands on disk at all. The
 *     dump carries agent-authored report prose from the operator's own transcripts; it is not
 *     printed, so it never enters a transcript by running this.
 *   - network: none.
 *   - subprocess: none.
 *
 * Read-only over the corpus. Skips gracefully (exit 0) when no transcript directory is present.
 *
 * Usage:
 *   bun scripts/measure-actionables-decisions.ts [--dir <projects-dir>] [--dump <path>] [--files N]
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { locateActionablesBlock } from "../.minsky/hooks/actionables-block";
import type { ActionablesMarkerForm } from "../.minsky/hooks/actionables-block";
import { detectDeferralPhrases } from "../.minsky/hooks/ask-routing-deferral-detector";

/** A reference to a filed ask — the thing whose PRESENCE means the decision was routed. */
const ASK_REFERENCE_RE = /\bask#\d+\b|minsky:\/\/ask\/[0-9a-f-]{8,}/i;

/**
 * Units this script counts as ENTITY-BACKED: the bullet points at a task, PR, memory or ask.
 *
 * Not a decision classifier and not presented as one. It separates the two populations that
 * matter for sizing the problem — a bullet that hands the principal a pointer to something
 * already filed, versus one that carries its content inline — because the second is where an
 * unrouted decision can hide and the first is mostly legitimate routing.
 */
const ENTITY_REF_RE = /\b(?:mt#\d+|mem#\d+|ws#\d+|PR #\d+|issue #\d+)\b|minsky:\/\/[a-z]+\//i;

interface Bucket {
  markerForms: Record<ActionablesMarkerForm, number>;
  precededByRule: number;
  blocks: number;
  units: number;
  unitsFiringShippedMatcher: number;
  unitsCitingAsk: number;
  unitsWithEntityRef: number;
  unitsBare: number;
}

function emptyBucket(): Bucket {
  return {
    markerForms: { heading: 0, "bold-line": 0, "inline-label": 0 },
    precededByRule: 0,
    blocks: 0,
    units: 0,
    unitsFiringShippedMatcher: 0,
    unitsCitingAsk: 0,
    unitsWithEntityRef: 0,
    unitsBare: 0,
  };
}

/** Every `.jsonl` under the projects dir, newest first. */
function transcriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const project of readdirSync(dir)) {
    const projectDir = join(dir, project);
    let entries: string[];
    try {
      if (!statSync(projectDir).isDirectory()) continue;
      entries = readdirSync(projectDir);
    } catch {
      continue; // an unreadable project dir is not this script's problem
    }
    for (const f of entries) {
      if (f.endsWith(".jsonl")) out.push(join(projectDir, f));
    }
  }
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** Concatenated `text` blocks of an assistant line, or null when it carries none. */
function assistantText(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null; // a truncated trailing line is normal in a live transcript
  }
  const rec = parsed as { type?: string; message?: { content?: unknown } };
  if (rec.type !== "assistant") return null;
  const content = rec.message?.content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.length === 0 ? null : parts.join("\n");
}

function main(): void {
  const argv = process.argv.slice(2);
  const readFlag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };

  const dir = readFlag("--dir") ?? join(homedir(), ".claude", "projects");
  const dumpPath = readFlag("--dump");
  const fileLimit = Number(readFlag("--files") ?? "0");

  if (!existsSync(dir)) {
    console.log(`SKIP: no transcript directory at the configured path`);
    return;
  }

  let files = transcriptFiles(dir);
  if (fileLimit > 0) files = files.slice(0, fileLimit);

  const bucket = emptyBucket();
  let turnsScanned = 0;
  const dumped: string[] = [];

  for (const file of files) {
    let body: string;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of body.split("\n")) {
      if (line === "") continue;
      const text = assistantText(line);
      if (text === null) continue;
      turnsScanned += 1;

      const block = locateActionablesBlock(text);
      if (block === null) continue;

      bucket.blocks += 1;
      bucket.markerForms[block.markerForm] += 1;
      if (block.precededByRule) bucket.precededByRule += 1;

      for (const unit of block.units) {
        bucket.units += 1;
        const fires = detectDeferralPhrases(unit.text).length > 0;
        const citesAsk = ASK_REFERENCE_RE.test(unit.text);
        const hasEntity = ENTITY_REF_RE.test(unit.text);
        if (fires) bucket.unitsFiringShippedMatcher += 1;
        if (citesAsk) bucket.unitsCitingAsk += 1;
        if (hasEntity) bucket.unitsWithEntityRef += 1;
        if (!hasEntity && !citesAsk) bucket.unitsBare += 1;

        if (dumpPath !== undefined) {
          // The dump is for hand-classification, which is what turns this census
          // into a recall RATE. Each record carries only what a classifier needs.
          dumped.push(
            JSON.stringify({
              markerForm: block.markerForm,
              firesShippedMatcher: fires,
              citesAsk,
              hasEntityRef: hasEntity,
              text: unit.text,
            })
          );
        }
      }
    }
  }

  if (dumpPath !== undefined) writeFileSync(dumpPath, `${dumped.join("\n")}\n`);

  const pct = (n: number, d: number): string =>
    d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;

  console.log(`files scanned                  ${files.length}`);
  console.log(`assistant turns scanned        ${turnsScanned}`);
  console.log(`terminal actionables blocks    ${bucket.blocks}`);
  console.log(`  marker form: heading         ${bucket.markerForms.heading}`);
  console.log(`  marker form: bold-line       ${bucket.markerForms["bold-line"]}`);
  console.log(`  marker form: inline-label    ${bucket.markerForms["inline-label"]}`);
  console.log(
    `  preceded by a rule           ${bucket.precededByRule} (${pct(bucket.precededByRule, bucket.blocks)})`
  );
  console.log(`units (bullets / prose)        ${bucket.units}`);
  console.log(
    `  shipped matcher fires        ${bucket.unitsFiringShippedMatcher} (${pct(bucket.unitsFiringShippedMatcher, bucket.units)})`
  );
  console.log(
    `  cites a filed ask            ${bucket.unitsCitingAsk} (${pct(bucket.unitsCitingAsk, bucket.units)})`
  );
  console.log(
    `  carries an entity ref        ${bucket.unitsWithEntityRef} (${pct(bucket.unitsWithEntityRef, bucket.units)})`
  );
  console.log(
    `  bare (no entity, no ask)     ${bucket.unitsBare} (${pct(bucket.unitsBare, bucket.units)})`
  );
  if (dumpPath !== undefined)
    console.log(`dumped ${dumped.length} unit record(s) to the --dump path`);
}

main();
