/**
 * Tests for `extractActualModel` (mt#2796).
 *
 * `readTranscriptMetrics`'s existing toolUseCount/totalTokens/durationMs logic
 * already has coverage via `.minsky/hooks/record-subagent-invocation.test.ts`
 * (through the resolveMetricsTranscriptPath + readTranscriptMetrics pair); this
 * file covers only the new `extractActualModel` reader, which — unlike
 * `readTranscriptMetrics`'s flat-shape assumption — reads the REAL Claude Code
 * transcript shape verified against real on-disk transcripts 2026-07-15:
 * `{"type":"assistant","message":{"model":"...", ...}, ...}` (nested under
 * `message`, not top-level).
 *
 * @see mt#2796 — this task
 * @see packages/domain/src/subagent/transcript-metrics.ts — implementation
 */

/* eslint-disable custom/no-real-fs-in-tests -- extractActualModel reads real JSONL files on disk; mirrors record-subagent-invocation.test.ts's fixture pattern */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractActualModel,
  readTranscriptMetrics,
  SYNTHETIC_MODEL_SENTINEL,
} from "./transcript-metrics";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const fixtureRoots: string[] = [];

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A real-shaped assistant transcript line: model nested under `message`. */
function assistantLine(opts: { model?: string; agentId?: string }): Record<string, unknown> {
  return {
    type: "assistant",
    agentId: opts.agentId,
    message: {
      role: "assistant",
      model: opts.model,
      content: [{ type: "text", text: "hello" }],
    },
  };
}

/** A real-shaped user transcript line — never carries a model field. */
function userLine(opts: { agentId?: string } = {}): Record<string, unknown> {
  return {
    type: "user",
    agentId: opts.agentId,
    message: { role: "user", content: "hi" },
  };
}

function writeTranscript(lines: Record<string, unknown>[]): string {
  const root = mkdtempSync(join(tmpdir(), "transcript-metrics-test-"));
  fixtureRoots.push(root);
  const path = join(root, "transcript.jsonl");
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}

// ---------------------------------------------------------------------------
// extractActualModel
// ---------------------------------------------------------------------------

describe("extractActualModel", () => {
  test("returns the model id from the first assistant line", async () => {
    const path = writeTranscript([
      userLine(),
      assistantLine({ model: "claude-sonnet-5" }),
      assistantLine({ model: "claude-opus-4-8" }),
    ]);

    expect(extractActualModel(path, undefined)).toBe("claude-sonnet-5");
  });

  test("skips <synthetic> entries and returns the first genuine model id", async () => {
    const path = writeTranscript([
      assistantLine({ model: SYNTHETIC_MODEL_SENTINEL }),
      assistantLine({ model: SYNTHETIC_MODEL_SENTINEL }),
      assistantLine({ model: "claude-sonnet-5" }),
    ]);

    expect(extractActualModel(path, undefined)).toBe("claude-sonnet-5");
  });

  test("a transcript whose only model entries are <synthetic> returns null, no error", async () => {
    const path = writeTranscript([
      assistantLine({ model: SYNTHETIC_MODEL_SENTINEL }),
      assistantLine({ model: SYNTHETIC_MODEL_SENTINEL }),
    ]);

    expect(extractActualModel(path, undefined)).toBeNull();
  });

  test("returns null for undefined transcriptPath", () => {
    expect(extractActualModel(undefined, "agent-1")).toBeNull();
  });

  test("returns null for a nonexistent file", () => {
    expect(extractActualModel("/nonexistent/path/transcript.jsonl", undefined)).toBeNull();
  });

  test("returns null when the file has no assistant lines", async () => {
    const path = writeTranscript([userLine(), userLine()]);
    expect(extractActualModel(path, undefined)).toBeNull();
  });

  test("returns null when the file is empty", async () => {
    const path = writeTranscript([]);
    expect(extractActualModel(path, undefined)).toBeNull();
  });

  test("skips malformed JSON lines and still finds the genuine model", async () => {
    const root = mkdtempSync(join(tmpdir(), "transcript-metrics-test-"));
    fixtureRoots.push(root);
    const path = join(root, "transcript.jsonl");
    writeFileSync(
      path,
      ["not valid json {{{", JSON.stringify(assistantLine({ model: "claude-sonnet-5" })), ""].join(
        "\n"
      )
    );

    expect(extractActualModel(path, undefined)).toBe("claude-sonnet-5");
  });

  test("filters by agentId — skips lines from a different agent", async () => {
    const path = writeTranscript([
      assistantLine({ model: "claude-opus-4-8", agentId: "some-other-agent" }),
      assistantLine({ model: "claude-sonnet-5", agentId: "abc123" }),
    ]);

    expect(extractActualModel(path, "abc123")).toBe("claude-sonnet-5");
  });

  test("a line carrying NO agentId is not attributed to a requested agent (mt#3256)", async () => {
    // WAS: "agentId filter is ignored when a line has no agentId field",
    // asserting this returned "claude-sonnet-5". That pinned the defect — see
    // the mt#3256 block below for why the assertion is inverted.
    const path = writeTranscript([assistantLine({ model: "claude-sonnet-5" })]);

    expect(extractActualModel(path, "abc123")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mt#3256 — attribution must be POSITIVE, or the parent's model gets recorded
// as the subagent's.
//
// The last test in the block above previously asserted the opposite:
//   "agentId filter is ignored when a line has no agentId field"
//   expect(extractActualModel(path, "abc123")).toBe("claude-sonnet-5")
// i.e. it PINNED the defect. Ignoring the filter is sound only if the file is
// already scoped to one agent — but `resolveMetricsTranscriptPath` falls back
// to the PARENT conversation's transcript when no per-agent file exists, and a
// parent's own assistant lines carry no `agentId`. Four of the seven rows in
// `subagent_invocations` that carried an `actual_model` held the parent's
// model, not any subagent's.
// ---------------------------------------------------------------------------

describe("mt#3256 — attribution requires a positive id match", () => {
  test("AT1: a parent-shaped transcript yields null, not the parent's model", () => {
    // Parent lines carry no agentId; the subagent's id appears on no line.
    const path = writeTranscript([
      assistantLine({ model: "claude-opus-4-8" }),
      assistantLine({ model: "claude-opus-4-8" }),
    ]);

    expect(extractActualModel(path, "abc123")).toBeNull();
  });

  test("AT2: a per-agent transcript still returns its model (no regression)", () => {
    // Real per-agent files carry agentId on every assistant line — verified
    // against `subagents/agent-<id>.jsonl` on disk.
    const path = writeTranscript([
      assistantLine({ model: "claude-sonnet-5", agentId: "abc123" }),
      assistantLine({ model: "claude-sonnet-5", agentId: "abc123" }),
    ]);

    expect(extractActualModel(path, "abc123")).toBe("claude-sonnet-5");
  });

  test("AT3: in a mixed transcript, the subagent's model wins over the parent's first line", () => {
    // The parent's line comes FIRST in file order — under the old filter it was
    // accepted and returned, which is exactly the production failure.
    const path = writeTranscript([
      assistantLine({ model: "claude-opus-4-8" }),
      userLine({ agentId: "abc123" }),
      assistantLine({ model: "claude-sonnet-5", agentId: "abc123" }),
    ]);

    expect(extractActualModel(path, "abc123")).toBe("claude-sonnet-5");
  });

  test("a mismatching agentId is still skipped (unchanged behavior)", () => {
    const path = writeTranscript([
      assistantLine({ model: "claude-opus-4-8", agentId: "some-other-agent" }),
      assistantLine({ model: "claude-sonnet-5", agentId: "abc123" }),
    ]);

    expect(extractActualModel(path, "abc123")).toBe("claude-sonnet-5");
  });

  test("passing no agentSessionId still reads the whole file (unchanged behavior)", () => {
    // The caller is not asking for attribution — every line qualifies.
    const path = writeTranscript([assistantLine({ model: "claude-sonnet-5" })]);

    expect(extractActualModel(path, undefined)).toBe("claude-sonnet-5");
  });

  test("SC3: readTranscriptMetrics does not count unattributed parent lines", async () => {
    // Same defect class, smaller blast radius: on a parent-transcript fallback
    // the old filter counted the PARENT's tool-uses and tokens into the
    // subagent's row. `agent_session_id` was never even present on real lines
    // (they carry `agentId`), so nothing was ever excluded.
    const path = writeTranscript([
      {
        type: "assistant",
        timestamp: "2026-07-26T00:00:00Z",
        content: [{ type: "tool_use" }, { type: "tool_use" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    ]);

    const metrics = await readTranscriptMetrics(path, "abc123");
    expect(metrics.toolUseCount).toBeNull();
    expect(metrics.totalTokens).toBeNull();
    expect(metrics.durationMs).toBeNull();
  });

  test("SC3: readTranscriptMetrics still counts lines that ARE attributed", async () => {
    const path = writeTranscript([
      {
        type: "assistant",
        agentId: "abc123",
        timestamp: "2026-07-26T00:00:00Z",
        content: [{ type: "tool_use" }, { type: "tool_use" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      {
        type: "assistant",
        agentId: "abc123",
        timestamp: "2026-07-26T00:00:05Z",
        content: [{ type: "tool_use" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);

    const metrics = await readTranscriptMetrics(path, "abc123");
    expect(metrics.toolUseCount).toBe(3);
    expect(metrics.totalTokens).toBe(165);
    expect(metrics.durationMs).toBe(5000);
  });

  test("an EMPTY-STRING agentSessionId is not 'not provided' (PR #2340 R1)", () => {
    // `"" == null` is false, so an empty id never took the not-provided path;
    // it stays a real id that no real line matches. Pinned in the conservative
    // direction: widening it to "take everything" would reintroduce this
    // task's defect for an empty id.
    const path = writeTranscript([assistantLine({ model: "claude-opus-4-8" })]);

    expect(extractActualModel(path, "")).toBeNull();
    // ...and the genuinely-not-provided case is unaffected.
    expect(extractActualModel(path, undefined)).toBe("claude-opus-4-8");
  });
});
