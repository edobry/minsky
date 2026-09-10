/**
 * Context-at-boundary instrument (mt#5042).
 *
 * The measurement this script produces is what mt#5042's threshold is derived
 * from, so the arithmetic is pinned rather than eyeballed against one run.
 *
 * Two properties matter most and neither is visible in the output:
 *
 *   1. Requests are deduped by `message.id`. Claude Code writes ONE JSONL LINE
 *      PER CONTENT BLOCK, so counting lines over-counts requests by ~2.3x
 *      (mem#762) — and the request ORDINAL is the unit AT2's "how many requests
 *      earlier" is reported in, so an inflated count inflates the headline.
 *   2. A boundary line with no usage is SKIPPED, not counted as zero. A zero
 *      would drag every percentile down with nothing to distinguish it from a
 *      genuinely empty context.
 */
import { describe, test, expect } from "bun:test";
import {
  BOUNDARY_TOOLS,
  CANDIDATE_THRESHOLDS,
  boundaryToolsInContent,
  buildReport,
  describe as describeDistribution,
  erroredToolUseIds,
  fillFromUsage,
  percentile,
  scanTranscriptText,
} from "./measure-context-at-merge";
import type { SessionScan } from "./measure-context-at-merge";
import { BOUNDARY_TOOLS as HOOK_BOUNDARY_TOOLS } from "../.minsky/hooks/handoff-at-work-boundary";

const MERGE_TOOL = "mcp__minsky__session_pr_merge";
const GH_MERGE_TOOL = "mcp__github__merge_pull_request";
const PR_CREATE_TOOL = "mcp__minsky__session_pr_create";
const STATUS_SET_TOOL = "mcp__minsky__tasks_status_set";
const NON_BOUNDARY_TOOL = "mcp__minsky__session_commit";

describe("BOUNDARY_TOOLS", () => {
  test("stays in sync with the hook's trigger set", () => {
    // The script duplicates the map deliberately (a historical measurement must
    // not silently re-scope when the live hook's triggers change), so the
    // duplication is CHECKED here rather than hoped for.
    expect(BOUNDARY_TOOLS).toEqual(HOOK_BOUNDARY_TOOLS);
  });
});

describe("fillFromUsage", () => {
  test("sums the three prompt-side counters", () => {
    expect(
      fillFromUsage({
        input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 3,
      })
    ).toBe(123);
  });

  test("EXCLUDES output_tokens — it is what the call produced, not what it carried", () => {
    expect(fillFromUsage({ input_tokens: 100, output_tokens: 999 })).toBe(100);
  });

  test("non-numeric and negative counters read as zero rather than throwing", () => {
    expect(fillFromUsage({ input_tokens: "many", cache_read_input_tokens: -5 })).toBe(0);
    expect(fillFromUsage(undefined)).toBe(0);
  });
});

describe("boundaryToolsInContent", () => {
  function toolUse(name: string, input: Record<string, unknown> = {}) {
    return { type: "tool_use", name, input };
  }

  const kinds = (c: unknown) => boundaryToolsInContent(c).map((u) => u.kind);

  test("recognizes each boundary tool", () => {
    expect(kinds([toolUse(MERGE_TOOL)])).toEqual(["merge"]);
    expect(kinds([toolUse(GH_MERGE_TOOL)])).toEqual(["merge"]);
    expect(kinds([toolUse(PR_CREATE_TOOL)])).toEqual(["pr-landing"]);
  });

  test("carries the tool_use id through, so the result can be joined", () => {
    expect(boundaryToolsInContent([{ ...toolUse(MERGE_TOOL), id: "toolu_abc" }])).toEqual([
      { kind: "merge", toolUseId: "toolu_abc" },
    ]);
  });

  test("a closeout is a status_set to DONE only", () => {
    expect(kinds([toolUse(STATUS_SET_TOOL, { status: "DONE" })])).toEqual(["closeout"]);
    expect(boundaryToolsInContent([toolUse(STATUS_SET_TOOL, { status: "IN-REVIEW" })])).toEqual([]);
  });

  test("ignores non-tool_use blocks and unrelated tools", () => {
    expect(boundaryToolsInContent([{ type: "text", text: MERGE_TOOL }])).toEqual([]);
    expect(boundaryToolsInContent([toolUse(NON_BOUNDARY_TOOL)])).toEqual([]);
    expect(boundaryToolsInContent("not an array")).toEqual([]);
  });
});

describe("erroredToolUseIds", () => {
  test("collects the ids of tool_result blocks flagged is_error", () => {
    expect(
      erroredToolUseIds([
        { type: "tool_result", tool_use_id: "a", is_error: true },
        { type: "tool_result", tool_use_id: "b" },
        { type: "text", text: "x" },
      ])
    ).toEqual(["a"]);
  });

  test("a non-array content is not an error source", () => {
    expect(erroredToolUseIds(undefined)).toEqual([]);
  });
});

describe("percentile", () => {
  test("nearest-rank over a known series", () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 90)).toBe(9);
    expect(percentile(v, 100)).toBe(10);
    expect(percentile(v, 10)).toBe(1);
  });

  test("an empty series is 0, not NaN", () => {
    expect(percentile([], 50)).toBe(0);
    expect(describeDistribution([]).max).toBe(0);
  });

  test("does not mutate its input", () => {
    const v = [3, 1, 2];
    percentile(v, 50);
    expect(v).toEqual([3, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Transcript scanning
// ---------------------------------------------------------------------------

function assistant(
  id: string,
  fill: number,
  content: unknown[] = [],
  opts: { withUsage?: boolean } = {}
): string {
  const message: Record<string, unknown> = { id, content };
  if (opts.withUsage !== false) {
    message["usage"] = {
      input_tokens: fill,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
  }
  return JSON.stringify({ type: "assistant", message });
}

function compaction(preTokens: number, trigger = "auto"): string {
  return JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    compactMetadata: { trigger, preTokens, postTokens: 30_000 },
  });
}

function mergeCall() {
  return { type: "tool_use", name: MERGE_TOOL, input: {} };
}

describe("scanTranscriptText", () => {
  test("counts one request per message.id, not per line", () => {
    // Three lines, two responses: the first response spans two content blocks.
    const raw = [
      assistant("m1", 100),
      assistant("m1", 100, [mergeCall()]),
      assistant("m2", 200),
    ].join("\n");
    const scan = scanTranscriptText(raw);
    expect(scan.requests).toBe(2);
    // The merge is attributed to request 0 — the one that carried it — even
    // though it arrived on the second LINE.
    expect(scan.boundaries).toEqual([{ kind: "merge", fillTokens: 100, requestIndex: 0 }]);
  });

  test("skips a boundary when NO line of the message carries usage", () => {
    // Genuinely unknown fill — recording zero would drag every percentile down.
    const raw = assistant("m1", 0, [mergeCall()], { withUsage: false });
    expect(scanTranscriptText(raw).boundaries).toEqual([]);
  });

  test("borrows the fill from another line of the SAME response", () => {
    // One API response, two content blocks, two JSONL lines: usage on the first,
    // the boundary tool_use on the second. They are one request and share one
    // context size, so the boundary must not be dropped (PR #3702 R3).
    const raw = [
      assistant("m1", 700_000),
      assistant("m1", 0, [mergeCall()], { withUsage: false }),
    ].join("\n");
    expect(scanTranscriptText(raw).boundaries).toEqual([
      { kind: "merge", fillTokens: 700_000, requestIndex: 0 },
    ]);
  });

  test("does NOT borrow across different responses", () => {
    // A different message.id is a different request with a different context
    // size; borrowing there would fabricate a reading rather than recover one.
    const raw = [
      assistant("m1", 700_000),
      assistant("m2", 0, [mergeCall()], { withUsage: false }),
    ].join("\n");
    expect(scanTranscriptText(raw).boundaries).toEqual([]);
  });

  test("drops a boundary whose tool result came back an error", () => {
    // The hook does not treat a failed merge as a boundary; without this join the
    // measured population would be WIDER than the population the hook fires on,
    // silently diverging the threshold's derivation from its mechanism.
    const call = { type: "tool_use", name: MERGE_TOOL, input: {}, id: "toolu_x" };
    const failed = [
      assistant("m1", 700_000, [call]),
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_x", is_error: true }],
        },
      }),
    ].join("\n");
    expect(scanTranscriptText(failed).boundaries).toEqual([]);

    // ...and the identical transcript WITHOUT the error keeps it, so the test
    // discriminates rather than merely passing.
    const ok = [
      assistant("m1", 700_000, [call]),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_x" }] },
      }),
    ].join("\n");
    expect(scanTranscriptText(ok).boundaries).toHaveLength(1);
  });

  test("captures compaction onset and its trigger", () => {
    const raw = [assistant("m1", 100), compaction(999_000), compaction(500_000, "manual")].join(
      "\n"
    );
    const scan = scanTranscriptText(raw);
    expect(scan.compactions.map((c) => [c.preTokens, c.trigger])).toEqual([
      [999_000, "auto"],
      [500_000, "manual"],
    ]);
  });

  test("a malformed or partially-flushed line is skipped, not fatal", () => {
    const raw = [assistant("m1", 100, [mergeCall()]), '{"type":"assist'].join("\n");
    expect(scanTranscriptText(raw).boundaries).toHaveLength(1);
  });
});

describe("buildReport", () => {
  function scan(
    boundaries: SessionScan["boundaries"],
    compactions: SessionScan["compactions"] = []
  ): SessionScan {
    return { boundaries, compactions, requests: 10 };
  }

  test("a boundary counts as pre-compaction only when a compaction FOLLOWS it", () => {
    const before = { kind: "merge" as const, fillTokens: 700_000, requestIndex: 5 };
    const after = { kind: "merge" as const, fillTokens: 700_000, requestIndex: 40 };
    const report = buildReport(
      [scan([before, after], [{ preTokens: 999_000, trigger: "auto", requestIndex: 20 }])],
      "2026-09-10T00:00:00.000Z"
    );
    expect(report.fillAtBoundary.count).toBe(2);
    expect(report.preCompactionBoundaries.count).toBe(1);
  });

  test("reports how many requests earlier the catch would have landed", () => {
    const report = buildReport(
      [
        scan(
          [{ kind: "merge", fillTokens: 700_000, requestIndex: 5 }],
          [{ preTokens: 999_000, trigger: "auto", requestIndex: 105 }]
        ),
      ],
      "2026-09-10T00:00:00.000Z"
    );
    const row = report.thresholds.find((t) => t.thresholdTokens === 650_000);
    expect(row?.preCompactionCaught).toBe(1);
    expect(row?.medianRequestsEarlier).toBe(100);
  });

  test("a threshold above the fill catches nothing", () => {
    const report = buildReport(
      [
        scan(
          [{ kind: "merge", fillTokens: 700_000, requestIndex: 5 }],
          [{ preTokens: 999_000, trigger: "auto", requestIndex: 105 }]
        ),
      ],
      "2026-09-10T00:00:00.000Z"
    );
    const row = report.thresholds.find((t) => t.thresholdTokens === 950_000);
    expect(row?.fires).toBe(0);
    expect(row?.preCompactionCaught).toBe(0);
  });

  test("recall falls monotonically as the threshold rises", () => {
    // The structural finding the decision record rests on: a boundary-gated
    // trigger trades fire rate against recall, and a HIGHER threshold cannot
    // catch more opportunities.
    const boundaries = [400_000, 550_000, 675_000, 820_000, 960_000].map((fillTokens, i) => ({
      kind: "merge" as const,
      fillTokens,
      requestIndex: i,
    }));
    const report = buildReport(
      [scan(boundaries, [{ preTokens: 999_000, trigger: "auto", requestIndex: 99 }])],
      "2026-09-10T00:00:00.000Z"
    );
    const caught = report.thresholds.map((t) => t.preCompactionCaught);
    for (let i = 1; i < caught.length; i++) {
      expect(caught[i]).toBeLessThanOrEqual(caught[i - 1] as number);
    }
    expect(CANDIDATE_THRESHOLDS).toContain(650_000);
  });

  test("auto and manual compactions are separated for cross-validation", () => {
    const report = buildReport(
      [
        scan(
          [],
          [
            { preTokens: 999_000, trigger: "auto", requestIndex: 1 },
            { preTokens: 400_000, trigger: "manual", requestIndex: 2 },
          ]
        ),
      ],
      "2026-09-10T00:00:00.000Z"
    );
    expect(report.compactionOnset.count).toBe(2);
    expect(report.autoCompactionOnset.count).toBe(1);
    expect(report.autoCompactionOnset.p50).toBe(999_000);
  });

  test("an empty corpus produces a report rather than throwing", () => {
    const report = buildReport([], "2026-09-10T00:00:00.000Z");
    expect(report.corpus.boundaryEvents).toBe(0);
    expect(report.thresholds.every((t) => t.firesPct === 0)).toBe(true);
  });
});
