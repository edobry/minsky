#!/usr/bin/env bun
/**
 * Measure how much of the transcript corpus's `user_text` is actually PRINCIPAL-AUTHORED.
 *
 * Why this exists (mt#4248). `agent_transcript_turns.user_text` is the obvious corpus for
 * deriving "terms the principal has used, therefore knows". Its extractor
 * (`packages/domain/src/transcripts/turn-extractor.ts` `extractUserText`) keeps EVERY `text`
 * block on a harness `user` line and excludes only `tool_result`. Harness `user` lines also
 * carry injected, agent-authored material — `<system-reminder>` blocks, slash-command and
 * skill bodies, `UserPromptSubmit` hook output. So the column is a role label, not an
 * authorship label, and deriving vocabulary from it naively would mark the corpus's OWN
 * vocabulary as "the principal used it" (`claim-confidence.mdc §The corpus is agent-authored`).
 *
 * This script measures the size of that contamination so the feasibility note in
 * `docs/rules-rationale/principal-context.md` cites a number rather than an inference.
 *
 * EGRESS — the complete set of channels this script writes to (mt#4191: name every channel,
 * not just the one you were designing):
 *   - stdout: aggregate counts, character totals, percentages, and XML-ish TAG NAMES only.
 *     No prompt text, no snippet, no sample line is ever printed, on any path including
 *     errors, which is why the tag histogram prints tag NAMES and never their contents.
 *   - files written: none.
 *   - network: none.
 *   - subprocess: none.
 *
 * Read-only. Skips gracefully (exit 0) when no transcript directory is present.
 *
 * Usage:
 *   bun scripts/measure-principal-turn-purity.ts [--dir <projects-dir>] [--files N]
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Substrings that mark a `user` turn as carrying agent/harness-authored material.
 *
 * Deliberately NOT a paired-tag scan. A first pass classified by `<tag>...</tag>` spans and
 * reported 0.0% contamination over 5.3M chars — a number falsified by its own denominator
 * (227 "user" turns averaging 23,500 characters each; no human types that). The dominant
 * injected material is not tag-wrapped: generated dispatch prompts, skill bodies and rule
 * text arrive as plain `text` blocks on a `user` line and are indistinguishable from typed
 * prose by shape alone. These markers are what actually discriminates.
 */
const INJECTED_MARKERS = [
  "minsky:prompt:v1", // session_generate_prompt output — an agent-authored dispatch
  "minsky:dispatch:v1", // the mt#2292 dispatch-record stamp
  "<system-reminder>",
  "<command-message>",
  "<command-name>",
  "<local-command-stdout>",
  "Base directory for this skill:", // an expanded skill body
] as const;

/**
 * Character length above which a `user` turn is treated as not-typed regardless of markers.
 *
 * Grounded in the observed distribution rather than picked round (`decision-defaults.mdc
 * §Thresholds`): over the sampled corpus, turn sizes are strongly bimodal — a mass below
 * ~2k chars and a second mass above 20k, with the upper mode reaching >100k. 4000 sits in
 * the empty span between them, so it separates the modes rather than cutting either.
 */
const TYPED_PROSE_CEILING_CHARS = 4000;

interface Args {
  dir: string;
  files: number;
}

function parseArgs(argv: string[]): Args {
  const dirFlag = argv.indexOf("--dir");
  const filesFlag = argv.indexOf("--files");
  return {
    dir: dirFlag >= 0 ? (argv[dirFlag + 1] ?? "") : join(homedir(), ".claude", "projects"),
    files: filesFlag >= 0 ? Number(argv[filesFlag + 1] ?? "20") : 20,
  };
}

/** Most-recently-modified `.jsonl` transcripts under `dir`, newest first. */
function recentTranscripts(dir: string, limit: number): string[] {
  const found: Array<{ path: string; mtime: number }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = join(dir, entry.name);
    let names: string[];
    try {
      names = readdirSync(projectDir);
    } catch {
      continue; // unreadable project dir — skip rather than abort the sweep
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(projectDir, name);
      try {
        found.push({ path, mtime: statSync(path).mtimeMs });
      } catch {
        continue; // raced with a delete — skip
      }
    }
  }
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((f) => f.path);
}

/**
 * Reproduce `extractUserText`: concatenate `text` blocks on a `user` line, drop the rest.
 * Returns null when the line is not a user line or carries no text.
 */
function userTextOf(line: unknown): string | null {
  if (typeof line !== "object" || line === null) return null;
  const rec = line as Record<string, unknown>;
  const message = rec["message"] as Record<string, unknown> | undefined;
  if (message?.["role"] !== "user") return null;

  const content = message["content"];
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string") parts.push(b["text"]);
  }
  const joined = parts.join("\n").trim();
  return joined.length > 0 ? joined : null;
}

/** Coarse size bucket for a turn, so the bimodality above is visible in the output. */
function sizeBucket(chars: number): string {
  if (chars < 200) return "a: <200";
  if (chars < 1000) return "b: 200-1k";
  if (chars < 4000) return "c: 1k-4k";
  if (chars < 20000) return "d: 4k-20k";
  if (chars < 100000) return "e: 20k-100k";
  return "f: >100k";
}

/** The injected markers present in a turn, if any. Names only — never the surrounding text. */
function markersIn(text: string): string[] {
  return INJECTED_MARKERS.filter((marker) => text.includes(marker));
}

function main(): void {
  const { dir, files } = parseArgs(process.argv.slice(2));
  if (!dir || !existsSync(dir)) {
    console.log(`SKIP: no transcript directory at ${dir || "<unset>"}`);
    process.exit(0);
  }

  const transcripts = recentTranscripts(dir, files);
  if (transcripts.length === 0) {
    console.log(`SKIP: no .jsonl transcripts under ${dir}`);
    process.exit(0);
  }

  let userTurns = 0;
  let totalChars = 0;
  let injectedChars = 0;
  let injectedTurns = 0;
  let typedTurns = 0;
  let typedChars = 0;
  const perMarker = new Map<string, number>();
  const sizeBuckets = new Map<string, number>();

  for (const path of transcripts) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue; // unreadable transcript — skip rather than abort
    }
    for (const rawLine of raw.split("\n")) {
      if (rawLine.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawLine);
      } catch {
        continue; // partial trailing write — skip
      }
      const text = userTextOf(parsed);
      if (text === null) continue;

      userTurns += 1;
      totalChars += text.length;

      const bucket = sizeBucket(text.length);
      sizeBuckets.set(bucket, (sizeBuckets.get(bucket) ?? 0) + 1);

      const markers = markersIn(text);
      for (const marker of markers) perMarker.set(marker, (perMarker.get(marker) ?? 0) + 1);

      const isInjected = markers.length > 0 || text.length > TYPED_PROSE_CEILING_CHARS;
      if (isInjected) {
        injectedTurns += 1;
        injectedChars += text.length;
      } else {
        typedTurns += 1;
        typedChars += text.length;
      }
    }
  }

  const pct = (n: number, d: number): string =>
    d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;

  console.log(`transcripts sampled: ${transcripts.length} (newest by mtime, under ${dir})`);
  console.log(`user-role turns with text: ${userTurns}`);
  console.log(`user_text chars total:     ${totalChars}`);
  console.log("");
  console.log(`agent/harness-authored turns: ${injectedTurns} (${pct(injectedTurns, userTurns)})`);
  console.log(`  their chars:                ${injectedChars} (${pct(injectedChars, totalChars)})`);
  console.log(`plausibly typed turns:        ${typedTurns} (${pct(typedTurns, userTurns)})`);
  console.log(`  their chars:                ${typedChars} (${pct(typedChars, totalChars)})`);
  console.log("");
  console.log("turn-size distribution (chars per turn):");
  for (const [bucket, count] of [...sizeBuckets.entries()].sort()) {
    console.log(`  ${bucket}: ${count}`);
  }
  console.log("marker hits — marker NAMES only, never their surrounding text:");
  for (const [marker, count] of [...perMarker.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${marker}: ${count} turns`);
  }
}

main();
