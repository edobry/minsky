#!/usr/bin/env bun
/**
 * Threshold calibration for the Rung-2 basis recognizer (mt#3861).
 *
 * `DEFAULT_SIMILARITY_THRESHOLD` in `embedding-nomination.ts` is 0.455, and its
 * own source says it was fit to ONE recall fixture and four negatives and is
 * "not a number to treat as well-calibrated on the evidence so far" — and it was
 * fit to a DIFFERENT predicate (retrospective-trigger admissions), not to basis
 * recognition. Inheriting it would be exactly the unmeasured-threshold move
 * `decision-defaults.mdc §Thresholds` forbids.
 *
 * This derives the band from the real corpus: the `prompt` argument of every
 * `Task`/`Agent` tool call across the local Claude Code transcripts for this
 * project — the same text the dispatch hook actually sees.
 *
 * ## What it measures, and why both halves are needed
 *
 * - **Recall (mt#3861 SC2):** the windows Rung 1 left BARE. These are the misses
 *   the climb exists to fix; their scores are the lower edge of the band.
 * - **Nullification (mt#3861 SC3):** the windows Rung 1 already marked
 *   basis-bearing. If the recognizer scores those at or above the same
 *   threshold, it is on its way to marking everything — the failure that got two
 *   regex candidates rejected. A usable threshold separates the two populations;
 *   if it cannot, that is the finding and no threshold should be pinned.
 *
 * ## What leaves this machine (PR #3033 R1)
 *
 * Scoring requires embedding the text, so `--execute` SENDS prohibition windows
 * from the operator's own transcripts to the configured embedding provider.
 * An earlier header said "aggregate counts and scores only, never prompt text",
 * which was true of STDOUT and misleading about the network — the reviewer was
 * right to block on it. Both statements are now made separately:
 *
 * - **stdout** carries aggregate counts and scores only, never prompt text.
 * - **the provider** receives raw ±240-char windows, under `--execute` only.
 *
 * This is the same data flow the repo already sanctions elsewhere —
 * `transcripts/per-turn-embedding-pipeline.ts` and the `transcripts
 * index-embeddings` command embed transcript turn text through the same
 * configured provider — so the concern is not a novel exposure class but an
 * ad-hoc script performing it without saying so. Hence the gate: this script is
 * DRY-RUN BY DEFAULT (`operational-safety-dry-run-first.mdc`), reporting corpus
 * shape and exactly how many windows it WOULD transmit, and makes no network
 * call at all until `--execute` is passed.
 *
 * Usage:
 *   bun scripts/calibrate-basis-nomination.ts               # dry run — no network
 *   bun scripts/calibrate-basis-nomination.ts --execute     # embeds; sends windows
 *   bun scripts/calibrate-basis-nomination.ts --execute --limit 50
 *   bun scripts/calibrate-basis-nomination.ts --execute --json
 *   bun scripts/calibrate-basis-nomination.ts --transcript-dir <path>
 *
 * Exits 0 when it completes, 2 when no embedding provider is available (a SKIP,
 * not a failure — the same shape §7a prescribes for env-gated artifacts).
 */

import "reflect-metadata";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  analyzeNegativeConstraints,
  BASIS_WINDOW_CHARS,
} from "@minsky/domain/validation/negative-constraint";
import { BASIS_EXEMPLARS } from "@minsky/domain/validation/basis-nomination";
import {
  cosineSimilarity,
  splitCandidateSegments,
} from "@minsky/domain/detectors/embedding-nomination";

/**
 * Claude Code stores a project's transcripts under a directory named by
 * flattening the project's absolute path (`/` and `.` -> `-`). Deriving it from
 * `cwd` rather than hardcoding one operator's path (PR #3033 R1) is what makes
 * this reproducible on another machine; `--transcript-dir` overrides for the
 * case where the corpus lives somewhere else.
 */
function defaultTranscriptDir(): string {
  // Normalize the separator before flattening (PR #3033 R2): on Windows `cwd()`
  // returns `C:\Users\...`, whose backslashes the character class below would
  // leave intact, producing a directory name that matches nothing. Folding `\`
  // to `/` first makes the flattening platform-independent.
  const flattened = process.cwd().replace(/\\/g, "/").replace(/[/.:]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", flattened);
}

interface Window {
  text: string;
  /** True when Rung 1 already recognized a basis — the nullification population. */
  rung1HasBasis: boolean;
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
    // intentional-swallow: an absent transcript dir means an empty corpus, which
    // the caller reports as a SKIP rather than a failure.
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

/** Every prohibition window in the corpus, labeled by Rung 1's verdict. */
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

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx] as number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const execute = args.includes("--execute");
  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : undefined;
  const dirArg = args.indexOf("--transcript-dir");
  const transcriptDir = dirArg >= 0 ? String(args[dirArg + 1]) : defaultTranscriptDir();

  const prompts = collectDispatchPrompts(transcriptDir, limit);
  const windows = collectWindows(prompts);
  const bare = windows.filter((w) => !w.rung1HasBasis);
  const bearing = windows.filter((w) => w.rung1HasBasis);

  process.stdout.write(
    `corpus: ${prompts.length} dispatch prompts, ${windows.length} prohibition matches ` +
      `(${bare.length} bare under Rung 1, ${bearing.length} basis-bearing)\n`
  );
  if (windows.length === 0) {
    process.stdout.write("SKIP: no prohibition matches in corpus.\n");
    process.exit(2);
  }

  if (!execute) {
    // Dry run: name exactly what --execute would transmit, and to whom, before
    // any of it leaves the machine (PR #3033 R1). Everything above this point is
    // local — transcript reads and the synchronous Rung-1 matcher — which is
    // what lets the volume be reported before it is authorized.
    process.stdout.write(
      `\nDRY RUN — no network calls made.\n` +
        `  --execute would send ${windows.length} prohibition windows ` +
        `(up to ${BASIS_WINDOW_CHARS * 2} chars each, drawn from your own transcripts)\n` +
        `  plus ${BASIS_EXEMPLARS.length} exemplars, to the configured embedding provider.\n` +
        `  Re-run with --execute to perform the calibration.\n`
    );
    process.exit(0);
  }

  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

  const { resolveNominationDeps } = await import(
    "@minsky/domain/detectors/embedding-nomination-factory"
  );
  const deps = await resolveNominationDeps();
  if (deps === null || !deps.semantic) {
    process.stdout.write(
      "SKIP: no semantic embedding provider available — calibration needs live embeddings.\n"
    );
    process.exit(2);
  }

  // Bind after the null check so the closure below needs no non-null assertion.
  const embeddings = deps.embeddingService;

  // One batched embed of the exemplar set, reused for every window.
  const exemplarVectors = await embeddings.generateEmbeddings([...BASIS_EXEMPLARS]);

  /** Best cosine of any segment of `w` against any exemplar. */
  async function scoreWindow(w: Window): Promise<number> {
    const segments = splitCandidateSegments(w.text);
    if (segments.length === 0) return 0;
    const vectors = await embeddings.generateEmbeddings(segments);
    let best = 0;
    for (const sv of vectors) {
      for (const ev of exemplarVectors) {
        const s = cosineSimilarity(sv, ev);
        if (s > best) best = s;
      }
    }
    return best;
  }

  const bareScores: number[] = [];
  for (const w of bare) bareScores.push(await scoreWindow(w));
  const bearingScores: number[] = [];
  for (const w of bearing) bearingScores.push(await scoreWindow(w));

  bareScores.sort((a, b) => a - b);
  bearingScores.sort((a, b) => a - b);

  const candidates = [0.3, 0.35, 0.4, 0.425, 0.455, 0.475, 0.5, 0.55, 0.6];
  const sweep = candidates.map((t) => ({
    threshold: t,
    bareFlipped: bareScores.filter((s) => s >= t).length,
    bareTotal: bareScores.length,
    bearingMarked: bearingScores.filter((s) => s >= t).length,
    bearingTotal: bearingScores.length,
  }));

  const summary = {
    prompts: prompts.length,
    matches: windows.length,
    bare: bare.length,
    bearing: bearing.length,
    bareScores: {
      min: bareScores[0],
      p50: quantile(bareScores, 0.5),
      max: bareScores[bareScores.length - 1],
    },
    bearingScores: {
      min: bearingScores[0],
      p50: quantile(bearingScores, 0.5),
      max: bearingScores[bearingScores.length - 1],
    },
    sweep,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    // An empty population must read as "(none)", not as `min undefined p50 NaN`
    // — a report that prints NaN invites it being read as a measured value.
    const band = (s: { min?: number; p50: number; max?: number }, n: number): string =>
      n === 0
        ? "(none in this sample)"
        : `min ${s.min?.toFixed(3)} p50 ${s.p50.toFixed(3)} max ${s.max?.toFixed(3)}`;

    process.stdout.write(
      `\nbare-window scores      : ${band(summary.bareScores, bare.length)}\n` +
        `basis-bearing scores    : ${band(summary.bearingScores, bearing.length)}\n\n` +
        `threshold  bare-flipped  basis-bearing-also-marked\n`
    );
    for (const row of sweep) {
      process.stdout.write(
        `  ${row.threshold.toFixed(3)}      ${row.bareFlipped}/${row.bareTotal}` +
          `            ${row.bearingMarked}/${row.bearingTotal}\n`
      );
    }
  }
  process.exit(0);
}

await main();
