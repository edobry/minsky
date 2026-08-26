/**
 * Tests for the Braintrust gold-set push (mt#2746).
 *
 * The load-bearing property here is the BLIND PAYLOAD: nothing that reveals
 * how a finding was already judged may reach the labeling UI. That failure is
 * silent — an anchored labeler still produces labels, and the resulting kappa
 * still looks like a kappa — so it cannot be caught by inspecting output. The
 * key sets are pinned instead.
 *
 * These assertions use exact key-set equality rather than scanning the
 * serialized payload for verdict strings. A scan would be both unsound and
 * noisy: `VALID` and `NOISE` legitimately occur inside finding prose and code
 * context, so a substring match would flag correct payloads, while a field
 * added under a new name would slip past it entirely.
 */

import { describe, expect, test } from "bun:test";

import type { CorpusRow } from "../src/eval-corpus";
import { buildBlindDatasetRow, parseArgs, toBrowserUrl } from "./push-braintrust-gold-set";

function makeRow(overrides: Partial<CorpusRow> = {}): CorpusRow {
  return {
    id: "pr-2141-r2-f0",
    corpusVersion: "v1",
    source: "git-diff-mined",
    prNumber: 2141,
    round: 2,
    finding: {
      file: "src/example.ts",
      severity: "BLOCKING",
      line: 42,
      lineEnd: 47,
      text: "This nullable value is dereferenced without a guard.",
    },
    codeContextWindow: "function example() {\n  return maybe.value;\n}",
    label: {
      value: "git-diff-fixed",
      provenance: "deterministic",
      confidence: "noisy-positive",
    },
    minedAt: "2026-08-25T14:12:00.000Z",
    ...overrides,
  } as CorpusRow;
}

describe("buildBlindDatasetRow", () => {
  test("emits exactly the allowlisted input keys", () => {
    const built = buildBlindDatasetRow(makeRow());
    expect(Object.keys(built.input).sort()).toEqual([
      "codeContext",
      "file",
      "findingText",
      "line",
      "lineEnd",
      "rowId",
      "severity",
    ]);
  });

  test("emits exactly the allowlisted metadata keys", () => {
    const built = buildBlindDatasetRow(makeRow());
    expect(Object.keys(built.metadata).sort()).toEqual([
      "corpusVersion",
      "prNumber",
      "round",
      "rowId",
    ]);
  });

  test("carries no `expected` field — that is where the human's label goes", () => {
    const built = buildBlindDatasetRow(makeRow());
    expect("expected" in built).toBe(false);
    expect(Object.keys(built).sort()).toEqual(["id", "input", "metadata", "tags"]);
  });

  test("does not carry the deterministic corpus label at any depth", () => {
    // The label encodes whether the finding was fixed in the next round, which
    // is as strong an anchor as the judge's verdict. It must not survive the
    // projection under ANY key name, so this walks the built object rather
    // than checking a known key.
    const row = makeRow();
    const built = buildBlindDatasetRow(row);

    const values: unknown[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") return Object.values(node).forEach(walk);
      values.push(node);
    };
    walk(built);

    expect(values).not.toContain(row.label.value);
    expect(values).not.toContain(row.label.provenance);
    expect(values).not.toContain(row.label.confidence);
    expect(values).not.toContain(row.source);
    expect(values).not.toContain(row.minedAt);
  });

  test("gives the labeler the same evidence the judge panel receives", () => {
    // buildJudgeUserPrompt (src/judge.ts) shows file, severity, line, finding
    // text and code context. Kappa compares two raters over ONE body of
    // evidence; a mismatch here measures something other than disagreement.
    const row = makeRow();
    const built = buildBlindDatasetRow(row);
    expect(built.input.file).toBe(row.finding.file);
    expect(built.input.severity).toBe(row.finding.severity);
    expect(built.input.line).toBe(42);
    expect(built.input.lineEnd).toBe(47);
    expect(built.input.findingText).toBe(row.finding.text);
    expect(built.input.codeContext).toBe(row.codeContextWindow);
  });

  test("uses the corpus row id as the record id so a re-push upserts", () => {
    const built = buildBlindDatasetRow(makeRow());
    expect(built.id).toBe("pr-2141-r2-f0");
    expect(built.input.rowId).toBe("pr-2141-r2-f0");
    expect(built.metadata.rowId).toBe("pr-2141-r2-f0");
  });

  test("omits line and lineEnd rather than emitting undefined", () => {
    const row = makeRow();
    const bare = buildBlindDatasetRow(
      makeRow({ finding: { ...row.finding, line: undefined, lineEnd: undefined } })
    );
    expect("line" in bare.input).toBe(false);
    expect("lineEnd" in bare.input).toBe(false);
  });
});

describe("parseArgs", () => {
  test("defaults to a dry run", () => {
    expect(parseArgs([]).execute).toBe(false);
  });

  test("requires --execute to opt into writing", () => {
    expect(parseArgs(["--execute"]).execute).toBe(true);
  });

  test("reads --artifact and --dataset", () => {
    const args = parseArgs(["--artifact", "/tmp/a.json", "--dataset", "gold-v2"]);
    expect(args.artifactPath).toBe("/tmp/a.json");
    expect(args.datasetName).toBe("gold-v2");
  });

  test("rejects a non-positive --limit instead of silently pushing everything", () => {
    expect(() => parseArgs(["--limit", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--limit", "abc"])).toThrow(/positive integer/);
  });
});

describe("toBrowserUrl", () => {
  test("rewrites the Braintrust API host to the web UI host", () => {
    // The SDK builds datasetUrl from the configured appUrl, which
    // readBraintrustConfig derives from apiUrl — so its link points at the API
    // host and does not open in a browser.
    expect(
      toBrowserUrl("https://api.braintrust.dev/app/minsky/p/minsky/datasets/reviewer-gold-set-v1")
    ).toBe("https://www.braintrust.dev/app/minsky/p/minsky/datasets/reviewer-gold-set-v1");
  });

  test("leaves a self-hosted host alone rather than guessing", () => {
    const selfHosted = "https://braintrust.internal.example/app/o/p/p/datasets/d";
    expect(toBrowserUrl(selfHosted)).toBe(selfHosted);
  });
});
