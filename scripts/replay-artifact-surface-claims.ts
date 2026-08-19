#!/usr/bin/env bun
/**
 * Replay a durable-artifact prose body through the `code-mechanism-assertion`
 * detector's artifact surface, and report which stage — extraction or matching —
 * accounts for the outcome.
 *
 * Why this exists (mt#4106). The calibration log records a fire's CLAIMS, never
 * the corpus that produced them, and mt#3649's `judgedInput` capture hoists only
 * the CHAT surface's text. So a turn on which the artifact surface produced no
 * claim leaves nothing behind to inspect: absence in the log cannot distinguish
 * "the prose was never extracted" from "the prose was extracted and matched
 * nothing". This runs both stages against a reconstructed body and says which.
 *
 * The POSITIVE CONTROL is the load-bearing part. The finding here is an ABSENCE,
 * and a probe that reports absence because it is broken is indistinguishable
 * from one that reports absence because the absence is real (mem#1032). Each
 * fixture therefore carries a control variant: the same sentence with a known
 * behavior predicate spliced in. A run in which the controls do not match is a
 * broken harness, and this script exits non-zero on it rather than reporting the
 * absence it was pointed at.
 */

import {
  buildArtifactProseCorpus,
  detectCodeMechanismAssertion,
  elideBlocksAndQuotes,
  symbolsNear,
  augmentWithIdentityNomination,
  createIdentityClaimNominator,
} from "../.minsky/hooks/code-mechanism-assertion-detector";
import type { IdentityClaimNominator } from "../.minsky/hooks/code-mechanism-assertion-detector";
import type { TranscriptLine } from "../.minsky/hooks/transcript";

interface Fixture {
  /** Short label for the record. */
  id: string;
  /** The write-class tool the prose was authored through. */
  tool: string;
  /** The tool input key carrying the prose body. */
  key: string;
  /** The prose as authored, reconstructed. */
  body: string;
  /** Where the reconstruction came from, so the record can be checked. */
  provenance: string;
  /**
   * The same body with a behavior predicate spliced in, to prove the harness
   * can fire on this text. Must name the same symbol.
   */
  control: string;
  /** The symbol the claim is about. */
  symbol: string;
}

/**
 * The two 2026-08-13 instances, reconstructed from the specs' own audit
 * sections. Both carry the phantom symbol `readResidentBytes` or the
 * unread-module claim about `memory-capture.ts`.
 */
const FIXTURES: Fixture[] = [
  {
    id: "instance-1a-mt4104-success-criteria",
    tool: "tasks_create",
    key: "spec",
    symbol: "readResidentBytes",
    provenance:
      "mt#4104 Success Criteria item 3, with the corrected symbol substituted back per its own premise check (i)(1).",
    body: [
      "## Success Criteria",
      "",
      "3. `readResidentBytes` in `src/mcp/orphan-exit.ts` is converted to it — and mt#3973's",
      "   `MINSKY_MCP_MEMORY_CAPTURE_MB` watermark, which shares the same reader, is converted with",
      "   it.",
    ].join("\n"),
    control: [
      "## Success Criteria",
      "",
      "3. `readResidentBytes` in `src/mcp/orphan-exit.ts` returns the resident set size, and is",
      "   converted to it — and mt#3973's `MINSKY_MCP_MEMORY_CAPTURE_MB` watermark, which shares the",
      "   same reader, is converted with it.",
    ].join("\n"),
  },
  {
    id: "instance-1b-mt4104-scope",
    tool: "tasks_create",
    key: "spec",
    symbol: "readResidentBytes",
    provenance:
      "mt#4104 `## Scope` → `In scope`, first bullet, with the corrected symbol substituted back per its own premise check (i)(1).",
    body: [
      "### In scope",
      "",
      "- **`readResidentBytes` (`src/mcp/orphan-exit.ts:331`) — the single reader carrying the",
      "  defect.** It is injected, not called directly, at **five** wiring sites, so converting the",
      "  one function converts every consumer at once.",
    ].join("\n"),
    control: [
      "### In scope",
      "",
      "- **`readResidentBytes` (`src/mcp/orphan-exit.ts:331`) — the single reader carrying the",
      "  defect.** It reads from `/proc`, is injected, not called directly, at **five** wiring sites,",
      "  so converting the one function converts every consumer at once.",
    ].join("\n"),
  },
  {
    id: "instance-2-mt4104-scope-memory-capture",
    tool: "tasks_create",
    key: "spec",
    symbol: "src/mcp/memory-capture.ts",
    provenance:
      "mt#4104 `## Scope`, the `memory-capture.ts` bullet, quoted verbatim in its own premise check (i)(2).",
    body: [
      "### In scope",
      "",
      "- `src/mcp/memory-capture.ts` — its `HEAP_SNAPSHOT_RSS_MULTIPLIER` arithmetic is expressed in",
      "  the same unit against the same reading. Changing what the input means changes what that",
      "  projection means; re-derive it here.",
    ].join("\n"),
    control: [
      "### In scope",
      "",
      "- `src/mcp/memory-capture.ts` — its `HEAP_SNAPSHOT_RSS_MULTIPLIER` arithmetic reads from the",
      "  same source and is expressed in the same unit. Changing what the input means changes what",
      "  that projection means; re-derive it here.",
    ].join("\n"),
  },
  {
    id: "instance-1c-mt4099-gap-resolution",
    tool: "tasks_spec_patch",
    key: "content",
    symbol: "readResidentBytes",
    provenance:
      "mt#4099 gap-resolution prose, still present verbatim in that spec (the correction was appended, not substituted).",
    body: [
      "The primitive takes a pid so it works for both the calling process and another pid,",
      "converting `readResidentBytes` AND mt#3973's capture watermark, and the two mt#3764 watchers",
      "that consume them.",
    ].join("\n"),
    control: [
      "The primitive takes a pid so it works for both the calling process and another pid.",
      "`readResidentBytes` returns the resident set size, so converting it AND mt#3973's capture",
      "watermark also converts the two mt#3764 watchers that consume them.",
    ].join("\n"),
  },
];

/** Wrap a prose body in the transcript shape the artifact surface reads. */
function linesFor(fixture: Fixture, body: string): TranscriptLine[] {
  const line: TranscriptLine = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: fixture.tool, input: { [fixture.key]: body } }],
    },
  };
  return [line];
}

interface StageResult {
  extracted: boolean;
  matched: boolean;
  claims: Array<{ symbol: string; predicate: string }>;
  /** Which rung produced `matched` (mt#4155). Absent when Rung 2 was not run. */
  rung?: "1-lexical" | "2-embedding";
  /** Why nomination degraded, when it did. */
  degradedReason?: string;
}

/**
 * Rung-2 mode (mt#4155). Off by default so the script keeps reporting the
 * mt#4106 baseline — four `MISS-AT-MATCHER` verdicts — which is the negative
 * control this measurement rests on. With `--rung2` the same fixtures run
 * through the real embedding nominator, which is what AT1 asserts.
 */
const RUNG2 = process.argv.includes("--rung2");
const nominator: IdentityClaimNominator | undefined = RUNG2
  ? createIdentityClaimNominator()
  : undefined;

async function run(fixture: Fixture, body: string): Promise<StageResult> {
  const corpus = buildArtifactProseCorpus(linesFor(fixture, body));
  // Empty verification and write-echo corpora: the question is whether the
  // claim is EXTRACTED at all, not whether a same-turn read would have backed
  // it. A backed claim is excluded at claim level, which would confound the
  // measurement with a suppression that did not happen on the real turns.
  const result = detectCodeMechanismAssertion(corpus, "", "");
  // Exact-token extraction, not a substring test (PR #3007 R1). The question is
  // whether the detector's OWN tokenizer yields this symbol from this corpus, so
  // ask `symbolsNear` rather than whether the string appears anywhere: a raw
  // `includes` reports `memory-capture.ts` as extracted on the strength of the
  // longer `src/mcp/memory-capture.ts` span it sits inside, which would render an
  // extraction failure as a matcher miss — the one discrimination this script
  // exists to make.
  //
  // Anchored mid-corpus with a window wide enough to span it, because extraction
  // is COUNTERFACTUAL here: with no predicate match the real detector never calls
  // `symbolsNear` at all, and what this measures is whether the token would be
  // yielded if it did. Elided first, exactly as `detectCodeMechanismAssertion`
  // elides before tokenizing, so both stages judge the same text.
  const prose = elideBlocksAndQuotes(corpus);
  const tokens = symbolsNear(prose, Math.floor(prose.length / 2), prose.length);
  const augmented = await augmentWithIdentityNomination(result, corpus, "", "", nominator);
  return {
    extracted: tokens.includes(fixture.symbol),
    matched: augmented.matched,
    claims: augmented.claims,
    rung: RUNG2 ? augmented.detectionRung : undefined,
    degradedReason: augmented.nominationDegradedReason,
  };
}

let controlFailures = 0;
const records: Array<Record<string, unknown>> = [];

for (const fixture of FIXTURES) {
  const asWritten = await run(fixture, fixture.body);
  const control = await run(fixture, fixture.control);

  if (!control.matched) controlFailures++;

  records.push({
    id: fixture.id,
    tool: fixture.tool,
    symbol: fixture.symbol,
    provenance: fixture.provenance,
    asWritten,
    control,
    verdict: control.matched
      ? asWritten.matched
        ? "FIRED"
        : asWritten.extracted
          ? "MISS-AT-MATCHER"
          : "MISS-AT-EXTRACTION"
      : "CONTROL-FAILED",
  });
}

process.stdout.write(`${JSON.stringify({ records }, null, 2)}\n`);

for (const record of records) {
  process.stdout.write(`${record["id"]}: ${record["verdict"]}\n`);
}

if (controlFailures > 0) {
  process.stderr.write(
    `FAIL: ${controlFailures} positive control(s) did not match. The harness cannot fire on this ` +
      `text, so the as-written results carry no information. Do not read the absences above.\n`
  );
  process.exit(1);
}

process.exit(0);
