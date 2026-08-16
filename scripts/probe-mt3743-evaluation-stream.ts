#!/usr/bin/env bun
/**
 * Live probe for mt#3743's evaluation stream.
 *
 * §7 item 8 (binding direction): the unit tests inject a collector, so they
 * prove `run()` CALLS the seam and say nothing about whether the real,
 * default-wired write path produces a file. This drives the REAL
 * `defaultEvaluationWriter` -> `logEvaluationRecord` -> `evaluationLogPath`
 * chain against a scratch repo and prints what landed on disk.
 *
 * Run: bun scripts/probe-mt3743-evaluation-stream.ts
 * Exits non-zero if either the miss record or the fire record is missing.
 */

import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = join(mkdtempSync(join(tmpdir(), "mt3743-probe-")), "repo");
mkdirSync(join(scratch, ".git"), { recursive: true });
process.env["CLAUDE_PROJECT_DIR"] = scratch;

const { run } = await import("../.minsky/hooks/causal-premise-detector");

function turn(text: string) {
  return [
    { type: "user", message: { role: "user", content: "prompt" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } },
    { type: "user", message: { role: "user", content: "next" } },
  ];
}

function ctxFor(lines: unknown[]) {
  return {
    transcriptLines: lines,
    recordedAnchor: undefined,
    budgets: { overallBudgetMs: 10_000 },
  };
}

const input = {
  session_id: "mt3743-probe-session",
  cwd: scratch,
  hook_event_name: "UserPromptSubmit",
  transcript_path: "mt3743-probe-transcript",
};

// A turn that FIRES: causal phrase + mechanism term, no same-turn backing.
const fired = run(
  input as never,
  ctxFor(
    turn("The branch name got mangled due to the encoding configuration in the client library.")
  ) as never
);

// A turn that does NOT fire — the case a fire-only log cannot record.
const missed = run(input as never, ctxFor(turn("Nothing noteworthy here.")) as never);

const logPath = join(scratch, ".minsky", "causal-premise-evaluations.jsonl");
if (!existsSync(logPath)) {
  console.error(`FAIL: no evaluation log written at ${logPath}`);
  process.exit(1);
}

const records = readFileSync(logPath, "utf-8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Record<string, unknown>);

console.log(`log: ${logPath}`);
console.log(`records: ${records.length}`);
for (const r of records) {
  const capture = r["judgedInput"] as { length: number; truncated: boolean; hash: string };
  console.log(
    `  fired=${r["fired"]} captureSchema=${r["captureSchema"]} ` +
      `judgedChars=${capture.length} truncated=${capture.truncated} hash=${capture.hash}`
  );
}

const firedRecords = records.filter((r) => r["fired"] === true);
const missRecords = records.filter((r) => r["fired"] === false);
console.log(`\ncalibration outcome present on fire: ${Boolean(fired?.calibration)}`);
console.log(`run() returned null on miss: ${missed === null}`);
console.log(
  `denominator=${records.length} fires=${firedRecords.length} misses=${missRecords.length}`
);

if (firedRecords.length !== 1 || missRecords.length !== 1) {
  console.error("FAIL: expected exactly one fire record and one miss record");
  process.exit(1);
}
console.log("\nPASS: the default-wired write path produces both a fire and a miss record.");
