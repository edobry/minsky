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
import { extractActualModel, SYNTHETIC_MODEL_SENTINEL } from "./transcript-metrics";

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

  test("agentId filter is ignored when a line has no agentId field", async () => {
    const path = writeTranscript([assistantLine({ model: "claude-sonnet-5" })]);

    expect(extractActualModel(path, "abc123")).toBe("claude-sonnet-5");
  });
});
