#!/usr/bin/env bun
/**
 * Measure the stale-state-assertion scan's GATE over a real transcript corpus
 * (mt#4199 SC6).
 *
 * ## What this measures, and what it deliberately does not
 *
 * The guard has two halves. This replays ONE of them.
 *
 *   - **The gate** — a pending-on-principal phrase and an entity ref within
 *     `PROXIMITY_CHARS` of each other, over the closing message. Pure, no IO,
 *     fully reconstructible from a past transcript. **This is what is measured.**
 *   - **The finding** — whether the substrate CONTRADICTED that claim. Not
 *     replayable, and the reason is not a missing harness: an entity's state
 *     TODAY is not its state at the moment the message was written. Replaying
 *     the finding would resolve every historical ref against present-day rows
 *     and report a confident, wrong number.
 *
 * So the output bounds the guard from above: the gate rate is the ceiling on how
 * often the substrate read runs at all, and therefore on how often a finding can
 * be produced. Read it as "how much does this cost, and how often could it
 * possibly speak" — not as a precision measurement. Precision needs live records
 * with their contemporaneous states, which is the calibration review's job once
 * the evaluation stream accumulates. Same split, and the same reason, that
 * `replay-stop-at-decision-corpus.ts` records for declining a corpus mode
 * outright.
 *
 * ## Parity
 *
 * Runs the gate from BOTH the `.minsky/hooks` source and the generated
 * `.claude/hooks` copy the harness actually executes, and exits non-zero if they
 * disagree — a missed recompile surfaces here rather than in production.
 *
 * ## Usage
 *
 *     bun scripts/replay-stale-state-assertion-gate.ts [--limit N] [--json]
 *                                                      [--projects-dir DIR]
 *
 * Exit code is 0 when the replay completes and the two copies agree. It is a
 * MEASUREMENT, not a gate.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { findPendingClaims as gateFromSource } from "../.minsky/hooks/turn-end-stale-state-assertion-scan";
import { findPendingClaims as gateFromGenerated } from "../.claude/hooks/turn-end-stale-state-assertion-scan";
import { safeTruncate } from "@minsky/shared/safe-truncate";

interface Options {
  limit: number;
  json: boolean;
  projectsDir: string;
}

function parseArgs(argv: string[]): Options {
  let limit = Number.POSITIVE_INFINITY;
  let json = false;
  let projectsDir = join(homedir(), ".claude", "projects");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--limit") limit = Number(argv[++i] ?? limit);
    else if (arg === "--json") json = true;
    else if (arg === "--projects-dir") projectsDir = String(argv[++i] ?? projectsDir);
  }
  return { limit, json, projectsDir };
}

/** The harness stores a project's transcripts under a path-derived directory name. */
function corpusDirFor(projectsDir: string, repoRoot: string): string {
  return join(projectsDir, repoRoot.replace(/\//g, "-"));
}

/**
 * The last assistant text block of each turn — the guard's actual input.
 *
 * A "turn" here ends at the next user line, which is the same boundary
 * `extractFinalTurn` uses. Reconstructed rather than imported because the
 * transcript helper reads a live hook payload, and this walks files.
 */
function closingMessagesOf(lines: string[]): string[] {
  const out: string[] = [];
  let pending = "";
  for (const raw of lines) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec["type"] === "user") {
      if (pending.trim().length > 0) out.push(pending);
      pending = "";
      continue;
    }
    if (rec["type"] !== "assistant") continue;
    const message = rec["message"];
    if (typeof message !== "object" || message === null) continue;
    const content = (message as Record<string, unknown>)["content"];
    if (!Array.isArray(content)) continue;
    const text = content
      .filter(
        (b): b is { type: string; text: string } =>
          typeof b === "object" &&
          b !== null &&
          (b as Record<string, unknown>)["type"] === "text" &&
          typeof (b as Record<string, unknown>)["text"] === "string"
      )
      .map((b) => b.text)
      .join("\n");
    if (text.trim().length > 0) pending = text;
  }
  if (pending.trim().length > 0) out.push(pending);
  return out;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const corpusDir = corpusDirFor(opts.projectsDir, repoRoot);

  if (!existsSync(corpusDir)) {
    console.log(`SKIP: no transcript corpus at ${corpusDir}`);
    return;
  }

  const files = readdirSync(corpusDir).filter((f) => f.endsWith(".jsonl"));
  let messagesScanned = 0;
  let gateHits = 0;
  let parityMismatches = 0;
  const samples: Array<{ file: string; refs: string[]; phrase: string; excerpt: string }> = [];

  for (const file of files.slice(0, Number.isFinite(opts.limit) ? opts.limit : files.length)) {
    let lines: string[];
    try {
      lines = readFileSync(join(corpusDir, file), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
    } catch {
      continue;
    }
    for (const message of closingMessagesOf(lines)) {
      messagesScanned += 1;
      const fromSource = gateFromSource(message);
      const fromGenerated = gateFromGenerated(message);
      if (fromSource.length !== fromGenerated.length) {
        parityMismatches += 1;
        console.error(
          `PARITY MISMATCH in ${file}: source=${fromSource.length} generated=${fromGenerated.length}`
        );
      }
      if (fromSource.length === 0) continue;
      gateHits += 1;
      if (samples.length < 15) {
        samples.push({
          file,
          refs: fromSource.map((c) => c.entity.ref),
          phrase: fromSource[0]?.assertion.phrase ?? "",
          // Surrogate-safe: a sample excerpt is printed, and a naive slice can
          // sever an emoji's pair and put a lone surrogate on stdout.
          excerpt: safeTruncate(message, 220, "tail"),
        });
      }
    }
  }

  const rate = messagesScanned === 0 ? 0 : (gateHits / messagesScanned) * 100;
  const report = {
    corpusDir,
    filesScanned: files.length,
    messagesScanned,
    gateHits,
    gateHitRatePct: Number(rate.toFixed(3)),
    parityMismatches,
    samples,
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`corpus:            ${corpusDir}`);
    console.log(`files scanned:     ${files.length}`);
    console.log(`closing messages:  ${messagesScanned}`);
    console.log(`gate hits:         ${gateHits}  (${rate.toFixed(3)}%)`);
    console.log(`parity mismatches: ${parityMismatches}`);
    console.log("");
    console.log("The gate rate bounds how often the substrate read runs, and so how often a");
    console.log("finding is possible. It is NOT a precision measurement — see this file's header.");
    if (samples.length > 0) {
      console.log("\nsamples:");
      for (const s of samples) {
        console.log(`  - [${s.refs.join(", ")}] on "${s.phrase}"`);
        console.log(`      …${s.excerpt.replace(/\n/g, " ")}`);
      }
    }
  }

  if (parityMismatches > 0) process.exit(1);
}

main();
