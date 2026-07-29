#!/usr/bin/env bun
/**
 * Verify the mt#3280 turn-window resolution against REAL Claude Code
 * transcripts, not fixtures.
 *
 * The defect this checks for cannot be reproduced by a unit test: it depends
 * on whether the harness has written the firing prompt to `transcript_path`
 * by the time a `UserPromptSubmit` hook reads the file. Claude Code documents
 * the property — the transcript "is written asynchronously and may lag the
 * in-memory conversation" — but the observable consequence lives in real
 * transcripts on disk.
 *
 * Two modes, both exercised before merge (mt#2776: a branch that only runs in
 * one mode is a branch that ships unrun):
 *
 *   scan   (default) Sweep recent real transcripts. For each one whose last
 *          line is NOT a real prompt — the shape a prompt-time hook sees — the
 *          resolved window must open at the LAST real prompt, and the
 *          pre-mt#3280 rule must have opened at an earlier one. Reports every
 *          transcript where the two rules disagree, which is the population of
 *          turns the old rule mis-attributed.
 *
 *   replay Reconstruct one transcript as of a given fire timestamp and print
 *          both windows, so a specific logged detector fire can be re-derived.
 *          Serves mt#3280's third acceptance test.
 *
 * Exit 0 = pass (or a documented SKIP), non-zero = fail. Emits JSON on stdout.
 */

import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  parseTranscript,
  findRealPromptIndices,
  resolveCompletedTurn,
  isRealUserPrompt,
  type TranscriptLine,
} from "../.minsky/hooks/transcript";

/** The pre-mt#3280 rule, kept here verbatim as the comparison baseline. */
function legacyWindow(lines: TranscriptLine[]): { openingPromptIndex?: number; length: number } {
  const promptIndices = findRealPromptIndices(lines);
  if (promptIndices.length < 2) return { length: 0 };
  const start = promptIndices[promptIndices.length - 2] as number;
  const end = promptIndices[promptIndices.length - 1] as number;
  return { openingPromptIndex: start, length: lines.slice(start + 1, end).length };
}

function projectTranscriptDir(): string {
  // Claude Code encodes the project path by replacing separators with dashes.
  const encoded = process.cwd().replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", encoded);
}

function recentTranscripts(dir: string, limit: number): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((e) => e.p);
}

function lastLineIsRealPrompt(lines: TranscriptLine[]): boolean {
  const last = lines[lines.length - 1];
  return last !== undefined && isRealUserPrompt(last);
}

function scan(limit: number, dirOverride?: string): number {
  const dir = dirOverride ?? projectTranscriptDir();
  if (!existsSync(dir)) {
    console.log(JSON.stringify({ result: "SKIP", reason: `no transcript dir at ${dir}` }, null, 2));
    return 0;
  }

  const results: Array<Record<string, unknown>> = [];
  let checked = 0;
  let disagreements = 0;
  let failures = 0;

  for (const path of recentTranscripts(dir, limit)) {
    let lines: TranscriptLine[];
    try {
      lines = parseTranscript(path);
    } catch {
      continue;
    }
    if (lines.length === 0) continue;

    const promptIndices = findRealPromptIndices(lines);
    if (promptIndices.length === 0) continue;

    const resolved = resolveCompletedTurn(lines);
    const legacy = legacyWindow(lines);
    const promptTimeShape = !lastLineIsRealPrompt(lines);
    checked++;

    // In the prompt-time shape the resolver must open at the LAST real
    // prompt — anything else means the firing-prompt-absent branch did not
    // take effect.
    const opensAtLastPrompt =
      resolved.openingPromptIndex === promptIndices[promptIndices.length - 1];
    const ok = promptTimeShape ? opensAtLastPrompt && !resolved.firingPromptLanded : true;
    if (!ok) failures++;

    const differs = resolved.openingPromptIndex !== legacy.openingPromptIndex;
    if (differs) disagreements++;

    results.push({
      transcript: path.split("/").pop(),
      lines: lines.length,
      realPrompts: promptIndices.length,
      promptTimeShape,
      firingPromptLanded: resolved.firingPromptLanded,
      resolvedOpeningPromptIndex: resolved.openingPromptIndex,
      resolvedTurnLines: resolved.turnLines.length,
      legacyOpeningPromptIndex: legacy.openingPromptIndex,
      legacyTurnLines: legacy.length,
      rulesDisagree: differs,
      ok,
    });
  }

  const result = failures === 0 ? "PASS" : "FAIL";
  console.log(
    JSON.stringify(
      {
        result,
        mode: "scan",
        checked,
        rulesDisagree: disagreements,
        failures,
        note: "rulesDisagree counts transcripts whose just-completed turn the pre-mt#3280 rule mis-attributed",
        results,
      },
      null,
      2
    )
  );
  return failures === 0 ? 0 : 1;
}

function replay(path: string, fireIso: string): number {
  if (!existsSync(path)) {
    console.log(JSON.stringify({ result: "SKIP", reason: `no transcript at ${path}` }, null, 2));
    return 0;
  }
  const fireMs = Date.parse(fireIso);
  if (Number.isNaN(fireMs)) {
    console.error(`Invalid --fire timestamp: ${fireIso}`);
    return 2;
  }

  const all = parseTranscript(path);
  // Reconstruct what the hook could have read. The transcript is append-only,
  // so the faithful reconstruction is a PREFIX ending at the first line
  // stamped after the fire — not a filter. A filter keeps untimestamped lines
  // (permission-mode markers and similar) that were appended later, which
  // makes the tail look non-empty and flips the resolver's shape detection.
  //
  // Even done correctly this remains an INFERENCE about past file state: a
  // line present now was not necessarily present then. That is why `scan` —
  // which reads the file exactly as a hook would — is the primary mode, and
  // why mt#3280's evidence rests on a logged detector anchor disagreeing with
  // the transcript rather than on a reconstruction like this one.
  let cut = all.length;
  for (let i = 0; i < all.length; i++) {
    const stamp = all[i]?.timestamp;
    if (!stamp) continue;
    const t = Date.parse(stamp);
    if (!Number.isNaN(t) && t > fireMs) {
      cut = i;
      break;
    }
  }
  const asOfFire = all.slice(0, cut);

  const resolved = resolveCompletedTurn(asOfFire);
  const legacy = legacyWindow(asOfFire);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        mode: "replay",
        transcript: path.split("/").pop(),
        fire: fireIso,
        linesAsOfFire: asOfFire.length,
        linesTotal: all.length,
        resolvedOpeningPromptIndex: resolved.openingPromptIndex,
        resolvedTurnLines: resolved.turnLines.length,
        firingPromptLanded: resolved.firingPromptLanded,
        legacyOpeningPromptIndex: legacy.openingPromptIndex,
        legacyTurnLines: legacy.length,
        rulesDisagree: resolved.openingPromptIndex !== legacy.openingPromptIndex,
      },
      null,
      2
    )
  );
  return 0;
}

function main(): number {
  const args = process.argv.slice(2);
  const fireIdx = args.indexOf("--fire");
  if (fireIdx !== -1) {
    const transcriptIdx = args.indexOf("--transcript");
    if (transcriptIdx === -1) {
      console.error("--fire requires --transcript <path>");
      return 2;
    }
    return replay(args[transcriptIdx + 1] as string, args[fireIdx + 1] as string);
  }
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx === -1 ? 10 : Number(args[limitIdx + 1]);
  const dirIdx = args.indexOf("--dir");
  const dirOverride = dirIdx === -1 ? undefined : (args[dirIdx + 1] as string);
  return scan(Number.isFinite(limit) && limit > 0 ? limit : 10, dirOverride);
}

process.exit(main());
