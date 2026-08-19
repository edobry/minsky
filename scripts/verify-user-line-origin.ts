#!/usr/bin/env bun
/**
 * Live verification for the user-line provenance predicate (mt#4289).
 *
 * **Why a script and not a unit test.** The unit tests assert that
 * `classifyUserLineOrigin` returns the right kind for fixtures we wrote. That
 * checks the predicate against our BELIEF about the harness. This runs it
 * against what Claude Code actually wrote to disk, which is the only thing that
 * can falsify the belief — and it is the same corpus the 43.5% figure in
 * mt#4289 `## Planning finding` was measured from, so the two are directly
 * comparable.
 *
 * **What it reports**, and how to read each part:
 *
 * 1. **The kind distribution** over every `type: "user"` line carrying text.
 *    Compare the harness-authored share against the ~43.5% measured prod-wide
 *    by prefix classes. Two independent methods over overlapping populations
 *    should land close; a large divergence means one of them is wrong.
 * 2. **Agreement with the text prefixes**, per prefix class. This is the
 *    important half: the prefixes are the INDEPENDENT method, so a prefix class
 *    that the field-based predicate calls `human` is a real disagreement to
 *    look at, not a rounding difference. A skill body reaching here as `human`
 *    would mean `isMeta` is not being stamped the way we measured.
 * 3. **Unrecognized `origin.kind` values**, if any — the harness's vocabulary
 *    growing past ours. Not a failure; a prompt to widen the docs.
 *
 * **Never prints transcript text.** Only kind names, counts, and the fixed
 * prefix literals this script itself declares — the corpus is the operator's
 * conversation history.
 *
 * Usage:
 *   bun scripts/verify-user-line-origin.ts [--dir <path>] [--files N]
 *
 * Exits 0 on pass, 1 when a prefix class disagrees with the predicate, and 0
 * with a SKIP notice when no transcript directory is present.
 *
 * @see packages/domain/src/transcripts/user-line-origin.ts — the predicate
 * @see mt#4289
 */

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

import {
  classifyUserLineOrigin,
  OPERATOR_ORIGIN,
} from "@minsky/domain/transcripts/user-line-origin";

/**
 * Default transcript directory. Derived at runtime rather than baked in as a
 * constant, so this runs on any machine (`portable defaults`, /implement-task
 * §7 checklist item 2).
 */
function defaultTranscriptDir(): string {
  return join(homedir(), ".claude", "projects", "-Users-edobry-Projects-minsky");
}

/**
 * The prefix classes mt#4289 sized the problem with — the INDEPENDENT method.
 *
 * Each maps to the kind the field-based predicate should return for a line
 * whose text starts with it. `null` means "no expectation": an operator can
 * legitimately type anything, so only classes the harness alone produces are
 * assertable.
 */
const PREFIX_EXPECTATIONS: ReadonlyArray<{ prefix: string; expected: string | null }> = [
  {
    prefix: "This session is being continued from a previous conversation",
    expected: "compact_summary",
  },
  { prefix: "Base directory for this skill:", expected: "harness_meta" },
  { prefix: "<task-notification>", expected: "task_notification" },
  { prefix: "<command-message>", expected: null },
  { prefix: "[SYSTEM NOTIFICATION - NOT USER INPUT]", expected: null },
  { prefix: "Stop hook feedback:", expected: null },
];

function parseArgs(argv: string[]): { dir: string; files: number } {
  let dir = defaultTranscriptDir();
  let files = Number.POSITIVE_INFINITY;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir" && argv[i + 1]) dir = argv[++i] as string;
    else if (argv[i] === "--files" && argv[i + 1]) files = Number(argv[++i]);
  }
  return { dir, files };
}

/** Text carried by a user line, whether its content is a string or blocks. */
function userTextOf(line: Record<string, unknown>): string | null {
  const message = line["message"] as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter(
      (b): b is { type: string; text: string } =>
        typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text"
    )
    .map((b) => b.text)
    .filter((t) => typeof t === "string");
  return parts.length > 0 ? parts.join("\n") : null;
}

function main(): number {
  const { dir, files: fileLimit } = parseArgs(process.argv.slice(2));

  if (!existsSync(dir)) {
    console.log(`SKIP: no transcript directory at ${dir} — nothing to verify against.`);
    return 0;
  }

  const jsonlFiles = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, Number.isFinite(fileLimit) ? fileLimit : undefined);

  if (jsonlFiles.length === 0) {
    console.log(`SKIP: ${dir} contains no .jsonl transcripts.`);
    return 0;
  }

  const kindCounts = new Map<string, number>();
  const prefixCounts = new Map<string, Map<string, number>>();
  let userLinesWithText = 0;

  for (const path of jsonlFiles) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (err) {
      console.warn(`WARN: could not read ${path}: ${(err as Error).message}`);
      continue;
    }
    for (const rawLine of raw.split("\n")) {
      if (!rawLine.trim()) continue;
      let line: Record<string, unknown>;
      try {
        line = JSON.parse(rawLine) as Record<string, unknown>;
      } catch {
        continue; // a partially-flushed tail line; the ingest path skips these too
      }
      if (line["type"] !== "user") continue;
      const text = userTextOf(line);
      if (text === null) continue; // tool_result-only line: no user_text, no origin

      userLinesWithText++;
      const kind = classifyUserLineOrigin(line);
      kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);

      for (const { prefix } of PREFIX_EXPECTATIONS) {
        if (!text.startsWith(prefix)) continue;
        const perKind = prefixCounts.get(prefix) ?? new Map<string, number>();
        perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
        prefixCounts.set(prefix, perKind);
      }
    }
  }

  const pct = (n: number) => `${((n / userLinesWithText) * 100).toFixed(1)}%`;
  const operator = kindCounts.get(OPERATOR_ORIGIN) ?? 0;
  const harness = userLinesWithText - operator;

  console.log(`transcripts scanned:        ${jsonlFiles.length}`);
  console.log(`user lines carrying text:   ${userLinesWithText}`);
  console.log(`  operator-authored:        ${operator} (${pct(operator)})`);
  console.log(`  harness-authored:         ${harness} (${pct(harness)})`);
  console.log("\nby kind:");
  for (const [kind, count] of [...kindCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind}: ${count} (${pct(count)})`);
  }

  console.log("\nagreement with the independent prefix method:");
  let disagreements = 0;
  for (const { prefix, expected } of PREFIX_EXPECTATIONS) {
    const perKind = prefixCounts.get(prefix);
    if (!perKind) {
      console.log(`  "${prefix}": absent from this sample`);
      continue;
    }
    const rendered = [...perKind.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => `${kind}=${count}`)
      .join(", ");
    if (expected === null) {
      console.log(`  "${prefix}": ${rendered}  (no assertion — see PREFIX_EXPECTATIONS)`);
      continue;
    }
    const wrong = [...perKind.entries()]
      .filter(([kind]) => kind !== expected)
      .reduce((sum, [, count]) => sum + count, 0);
    if (wrong > 0) {
      disagreements += wrong;
      console.log(`  "${prefix}": ${rendered}  FAIL — expected all ${expected}`);
    } else {
      console.log(`  "${prefix}": ${rendered}  OK`);
    }
  }

  const known = new Set([OPERATOR_ORIGIN, "compact_summary", "harness_meta"]);
  const novel = [...kindCounts.keys()].filter((k) => !known.has(k));
  if (novel.length > 0) {
    console.log(`\nharness kinds beyond the documented three: ${novel.sort().join(", ")}`);
    console.log("(not a failure — the vocabulary is partly the harness's and may have grown)");
  }

  if (disagreements > 0) {
    console.error(
      `\nverify-user-line-origin: FAIL — ${disagreements} line(s) classified against the ` +
        `independent prefix method. The field-based predicate and the text evidence disagree; ` +
        `one of them is wrong and it matters which.`
    );
    return 1;
  }

  console.log("\nverify-user-line-origin: PASS");
  return 0;
}

process.exit(main());
