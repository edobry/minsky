/**
 * Tests for `extractActualModel` (mt#2796) and `readTranscriptMetrics` (mt#4122).
 *
 * Both readers now read the REAL Claude Code transcript shape, verified against
 * real on-disk transcripts (2026-07-15 for `model`, 2026-08-13 for `content` and
 * `usage`): `{"type":"assistant","message":{"model":..., "content":[...],
 * "usage":{...}}, "timestamp":..., "agentId":...}` — the payload is nested under
 * `message`; only `timestamp`, `type` and `agentId` are genuinely top-level.
 *
 * This header previously described `readTranscriptMetrics`'s "flat-shape
 * assumption" as a settled difference between the two readers rather than as a
 * defect in one of them, and said this file covered `extractActualModel` only.
 * It covered the divergence in prose while the divergence silently emptied two
 * columns for the corpus's entire lifetime — see mt#4122.
 *
 * @see mt#2796 — extractActualModel
 * @see mt#4122 — the `message`-envelope fix for readTranscriptMetrics
 * @see packages/domain/src/subagent/transcript-metrics.ts — implementation
 */

/* eslint-disable custom/no-real-fs-in-tests -- extractActualModel reads real JSONL files on disk; mirrors record-subagent-invocation.test.ts's fixture pattern */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractActualModel, readTranscriptMetrics } from "./transcript-metrics";
import { SYNTHETIC_MODEL_SENTINEL } from "../ai/dispatch-models";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const fixtureRoots: string[] = [];

/** An agent id that never matches the id under test — the negative-attribution case. */
const OTHER_AGENT_ID = "some-other-agent";

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
      assistantLine({ model: "claude-opus-4-8", agentId: OTHER_AGENT_ID }),
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
      assistantLine({ model: "claude-opus-4-8", agentId: OTHER_AGENT_ID }),
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
    // mt#4122: fixture corrected to the REAL harness shape (payload nested under
    // `message`). It previously placed `content`/`usage` at the top level, which
    // no producer emits — so the nulls below passed for the wrong reason.
    const path = writeTranscript([
      {
        type: "assistant",
        timestamp: "2026-07-26T00:00:00Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use" }, { type: "tool_use" }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    ]);

    const metrics = await readTranscriptMetrics(path, "abc123");
    expect(metrics.toolUseCount).toBeNull();
    expect(metrics.totalTokens).toBeNull();
    expect(metrics.durationMs).toBeNull();
  });

  test("SC3: readTranscriptMetrics still counts lines that ARE attributed", async () => {
    // mt#4122: same fixture correction as above. Before the fix this test passed
    // against a top-level fixture the harness never emits — the assertion was
    // real but the input was not, which is what kept the defect invisible.
    const path = writeTranscript([
      {
        type: "assistant",
        agentId: "abc123",
        timestamp: "2026-07-26T00:00:00Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use" }, { type: "tool_use" }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      {
        type: "assistant",
        agentId: "abc123",
        timestamp: "2026-07-26T00:00:05Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
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

// ---------------------------------------------------------------------------
// mt#4122 — the payload is nested under `message`, not top-level
// ---------------------------------------------------------------------------

describe("mt#4122 — readTranscriptMetrics reads the `message` envelope", () => {
  /**
   * Structure captured from a real per-agent transcript
   * (`<conv>/subagents/agent-af4c7bcfdc311d929.jsonl`, 2026-08-13). Field names,
   * nesting and value types are verbatim; the content-block payloads and the
   * token counts are trimmed/rounded, since only the SHAPE is under test and a
   * real transcript's block bodies are arbitrary conversation text.
   *
   * The observed top-level key set was: agentId, attributionAgent,
   * attributionSkill, cwd, entrypoint, gitBranch, isSidechain, message,
   * parentUuid, requestId, sessionId, timestamp, type, userType, uuid, version.
   * Note what is NOT in it: `content` and `usage`.
   */
  function realShapeLine(over: {
    agentId?: string;
    timestamp: string;
    toolUses: number;
    inputTokens: number;
    outputTokens: number;
  }): Record<string, unknown> {
    return {
      type: "assistant",
      agentId: over.agentId ?? "abc123",
      timestamp: over.timestamp,
      isSidechain: true,
      userType: "external",
      cwd: "/Users/someone/Projects/minsky",
      message: {
        role: "assistant",
        model: "claude-sonnet-5",
        content: [
          { type: "text" },
          ...Array.from({ length: over.toolUses }, () => ({ type: "tool_use" })),
        ],
        usage: { input_tokens: over.inputTokens, output_tokens: over.outputTokens },
      },
    };
  }

  test("counts tool_use blocks and sums tokens from a real-shaped line", async () => {
    const path = writeTranscript([
      realShapeLine({
        timestamp: "2026-08-04T00:14:36.000Z",
        toolUses: 2,
        inputTokens: 2,
        outputTokens: 342,
      }),
      realShapeLine({
        timestamp: "2026-08-04T00:14:46.000Z",
        toolUses: 1,
        inputTokens: 10,
        outputTokens: 5,
      }),
    ]);

    const metrics = await readTranscriptMetrics(path, "abc123");

    // Pre-fix these two were null on 112 of 112 closed subagent_invocations rows.
    expect(metrics.toolUseCount).toBe(3);
    expect(metrics.totalTokens).toBe(359);
    // durationMs read `timestamp`, which IS genuinely top-level, so it always
    // worked — pinned here to prove the fix did not disturb it.
    expect(metrics.durationMs).toBe(10_000);
  });

  test("a non-tool_use content block is not counted", async () => {
    const path = writeTranscript([
      realShapeLine({
        timestamp: "2026-08-04T00:14:36.000Z",
        toolUses: 0,
        inputTokens: 7,
        outputTokens: 3,
      }),
    ]);

    const metrics = await readTranscriptMetrics(path, "abc123");
    expect(metrics.toolUseCount).toBeNull();
    expect(metrics.totalTokens).toBe(10);
  });

  test("attribution still applies to the nested shape", async () => {
    const path = writeTranscript([
      realShapeLine({
        agentId: OTHER_AGENT_ID,
        timestamp: "2026-08-04T00:14:36.000Z",
        toolUses: 5,
        inputTokens: 900,
        outputTokens: 900,
      }),
    ]);

    const metrics = await readTranscriptMetrics(path, "abc123");
    expect(metrics.toolUseCount).toBeNull();
    expect(metrics.totalTokens).toBeNull();
  });

  test("back-compat: a top-level-shaped line still reads", async () => {
    // No current producer emits this, but the fallback is deliberate — a
    // differently-shaped or older transcript must not silently read as empty.
    const path = writeTranscript([
      {
        type: "assistant",
        agentId: "abc123",
        timestamp: "2026-08-04T00:14:36.000Z",
        content: [{ type: "tool_use" }, { type: "tool_use" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      {
        type: "assistant",
        agentId: "abc123",
        timestamp: "2026-08-04T00:14:46.000Z",
        content: [{ type: "tool_use" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);

    const metrics = await readTranscriptMetrics(path, "abc123");
    expect(metrics.toolUseCount).toBe(3);
    expect(metrics.totalTokens).toBe(165);
    expect(metrics.durationMs).toBe(10_000);
  });

  test("the nested envelope wins when a line somehow carries both", async () => {
    const path = writeTranscript([
      {
        type: "assistant",
        agentId: "abc123",
        timestamp: "2026-08-04T00:14:36.000Z",
        content: [{ type: "tool_use" }, { type: "tool_use" }, { type: "tool_use" }],
        usage: { input_tokens: 999, output_tokens: 999 },
        message: {
          role: "assistant",
          content: [{ type: "tool_use" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);

    const metrics = await readTranscriptMetrics(path, "abc123");
    expect(metrics.toolUseCount).toBe(1);
    expect(metrics.totalTokens).toBe(15);
  });

  test("extractActualModel is unchanged by the interface collapse", async () => {
    const path = writeTranscript([
      realShapeLine({
        timestamp: "2026-08-04T00:14:36.000Z",
        toolUses: 1,
        inputTokens: 1,
        outputTokens: 1,
      }),
    ]);

    expect(extractActualModel(path, "abc123")).toBe("claude-sonnet-5");
  });
});
