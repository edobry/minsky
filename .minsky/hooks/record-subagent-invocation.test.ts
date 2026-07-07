/* eslint-disable custom/no-real-fs-in-tests -- resolveTranscriptCandidates walks the real on-disk <session>/subagents/ layout via readdirSync and existsSync, and readTranscriptMetrics reads real JSONL files; mirrors check-task-spec-read.test.ts's fixture pattern */
// Tests for the SubagentStop transcript-metrics path fix (mt#2649).
//
// Background-Agent-dispatched subagents receive `transcript_path` pointing at
// the PARENT session's top-level transcript, while the subagent's own
// tool_use/usage lines live at `<session-dir>/subagents/agent-<id>.jsonl`
// (mt#2637 diagnosis). This file verifies `resolveMetricsTranscriptPath`
// resolves to the per-agent file (not the parent) and that
// `readTranscriptMetrics` reading THAT file returns the per-agent counts —
// preserving the `agent_session_id` line-filter along the way.

import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveMetricsTranscriptPath } from "./record-subagent-invocation";
import { readTranscriptMetrics } from "../../packages/domain/src/subagent/transcript-metrics";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const fixtureRoots: string[] = [];

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A transcript-metrics JSONL line with N tool_use blocks and optional usage/timestamp. */
function metricsLine(opts: {
  toolUseCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  timestamp?: string;
  agentSessionId?: string;
}): Record<string, unknown> {
  const blocks = Array.from({ length: opts.toolUseCount ?? 0 }, () => ({ type: "tool_use" }));
  return {
    type: "assistant",
    role: "assistant",
    content: blocks,
    usage:
      opts.inputTokens != null || opts.outputTokens != null
        ? { input_tokens: opts.inputTokens ?? 0, output_tokens: opts.outputTokens ?? 0 }
        : undefined,
    timestamp: opts.timestamp,
    agent_session_id: opts.agentSessionId,
  };
}

function toJsonl(lines: Record<string, unknown>[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

/**
 * Build an on-disk fixture mirroring the harness layout:
 *   <root>/<session-id>.jsonl                       (parent transcript)
 *   <root>/<session-id>/subagents/agent-<id>.jsonl  (per-agent transcript)
 * Returns both paths.
 */
function buildTranscriptTree(
  parentLines: Record<string, unknown>[],
  agentId: string,
  agentLines: Record<string, unknown>[]
): { parentPath: string; agentPath: string } {
  const root = mkdtempSync(join(tmpdir(), "record-subagent-invocation-"));
  fixtureRoots.push(root);
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const parentPath = join(root, `${sessionId}.jsonl`);
  writeFileSync(parentPath, toJsonl(parentLines));
  const subagentsDir = join(root, sessionId, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const agentPath = join(subagentsDir, `agent-${agentId}.jsonl`);
  writeFileSync(agentPath, toJsonl(agentLines));
  return { parentPath, agentPath };
}

// ---------------------------------------------------------------------------
// resolveMetricsTranscriptPath
// ---------------------------------------------------------------------------

describe("resolveMetricsTranscriptPath", () => {
  test("prefers the per-agent file when it exists on disk", () => {
    const { parentPath, agentPath } = buildTranscriptTree(
      [metricsLine({ toolUseCount: 1 })],
      "abc123",
      [metricsLine({ toolUseCount: 3 })]
    );
    expect(resolveMetricsTranscriptPath(parentPath, "abc123")).toBe(agentPath);
  });

  test("falls back to the given path when no per-agent file exists on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "record-subagent-invocation-"));
    fixtureRoots.push(root);
    const parentPath = join(root, "no-subagents-session.jsonl");
    writeFileSync(parentPath, toJsonl([metricsLine({ toolUseCount: 1 })]));
    expect(resolveMetricsTranscriptPath(parentPath, "zzz999")).toBe(parentPath);
  });

  test("undefined transcriptPath passes through unchanged", () => {
    expect(resolveMetricsTranscriptPath(undefined, "abc123")).toBeUndefined();
  });

  test("already given the per-agent path -> returns it unchanged", () => {
    const { agentPath } = buildTranscriptTree([metricsLine({ toolUseCount: 1 })], "abc123", [
      metricsLine({ toolUseCount: 3 }),
    ]);
    expect(resolveMetricsTranscriptPath(agentPath, "abc123")).toBe(agentPath);
  });
});

// ---------------------------------------------------------------------------
// readTranscriptMetrics on the resolved path (mt#2649 acceptance test)
// ---------------------------------------------------------------------------

describe("readTranscriptMetrics on the resolved path (mt#2649 acceptance test)", () => {
  test("metrics come from the per-agent file, not the parent", async () => {
    // Parent transcript deliberately has DIFFERENT counts/tokens than the
    // per-agent file, so a regression (reading the parent) produces a
    // visibly different — and wrong — result.
    const { parentPath } = buildTranscriptTree(
      [metricsLine({ toolUseCount: 1, inputTokens: 10, outputTokens: 5 })],
      "abc123",
      [
        metricsLine({
          toolUseCount: 2,
          inputTokens: 100,
          outputTokens: 50,
          timestamp: "2026-07-07T00:00:00.000Z",
        }),
        metricsLine({ toolUseCount: 1, timestamp: "2026-07-07T00:01:00.000Z" }),
      ]
    );

    const resolved = resolveMetricsTranscriptPath(parentPath, "abc123");
    const metrics = await readTranscriptMetrics(resolved, "abc123");

    expect(metrics.toolUseCount).toBe(3); // 2 + 1 tool_use blocks from the per-agent file
    expect(metrics.totalTokens).toBe(150); // 100 + 50 from the per-agent file
    expect(metrics.durationMs).toBe(60000); // 1 minute between the per-agent timestamps

    // Sanity check: reading the PARENT directly produces a different (wrong)
    // result — proves the fixtures are actually distinguishable, and that
    // the resolved path above is not accidentally reading the parent.
    const parentMetrics = await readTranscriptMetrics(parentPath, "abc123");
    expect(parentMetrics.toolUseCount).toBe(1);
    expect(parentMetrics.totalTokens).toBe(15);
  });

  test("agent_session_id line-filter is preserved on the resolved file", async () => {
    const { parentPath } = buildTranscriptTree([metricsLine({ toolUseCount: 1 })], "abc123", [
      metricsLine({ toolUseCount: 2, agentSessionId: "abc123" }),
      metricsLine({ toolUseCount: 5, agentSessionId: "some-other-agent" }), // filtered out
    ]);

    const resolved = resolveMetricsTranscriptPath(parentPath, "abc123");
    const metrics = await readTranscriptMetrics(resolved, "abc123");

    expect(metrics.toolUseCount).toBe(2);
  });

  test("nulls, not per-agent counts, when the per-agent file truly has no data", async () => {
    const { parentPath } = buildTranscriptTree(
      [metricsLine({ toolUseCount: 1, inputTokens: 10, outputTokens: 5 })],
      "abc123",
      []
    );

    const resolved = resolveMetricsTranscriptPath(parentPath, "abc123");
    const metrics = await readTranscriptMetrics(resolved, "abc123");

    expect(metrics.toolUseCount).toBeNull();
    expect(metrics.totalTokens).toBeNull();
    expect(metrics.durationMs).toBeNull();
  });
});
