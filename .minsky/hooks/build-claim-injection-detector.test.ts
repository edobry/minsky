#!/usr/bin/env bun
/**
 * Unit tests for build-claim-injection-detector.ts
 *
 * Covers the mt#2923 acceptance tests:
 * - build-surface merge + usability claim + no rebuild evidence -> FIRES
 * - same, but a rebuild/install command is present -> SILENT
 * - usability claim with NO in-session build-surface merge -> SILENT
 * - routine (non-usability) claim after a build-surface merge -> SILENT
 * - INJECTION_ENABLED is false (calibration-first, v1)
 * - override env var suppresses detection and returns an audit line
 * - no transcript_path / empty transcript -> null (silent allow)
 *
 * @see mt#2923
 */

import { describe, test, expect } from "bun:test";
import {
  detectBuildClaimInjection,
  elideBlocksAndQuotes,
  USABILITY_CLAIM_PATTERNS,
  INJECTION_ENABLED,
  OVERRIDE_ENV_VAR,
  run,
} from "./build-claim-injection-detector";
import { extractLastAssistantTurn, extractAssistantText } from "./transcript";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function userPromptLine(text: string): TranscriptLine {
  return { type: "user", message: { role: "user", content: text } };
}

function toolUseBlock(name: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "tool_use", name, input };
}

function textBlock(text: string): Record<string, unknown> {
  return { type: "text", text };
}

function assistantLine(content: Array<Record<string, unknown>>): TranscriptLine {
  return { type: "assistant", message: { role: "assistant", content } };
}

const TRAY_SURFACE_PATH = "cockpit-tray/src-tauri/src/main.rs";
const RAILWAY_SURFACE_PATH = "services/reviewer/Dockerfile";
const USABILITY_CLAIM_TEXT = "The tray app is updated and ready — you can use it now.";
const EDIT_TOOL_NAME = "mcp__minsky__session_edit_file";
const MERGE_TOOL_NAME = "mcp__minsky__session_pr_merge";
const DEFAULT_TASK_ID = "mt#0000";

/** Shorthand for the canonical (edit deploy-surface file, merge) tool_use pair. */
function editAndMergeBlocks(
  path: string,
  task: string = DEFAULT_TASK_ID
): Array<Record<string, unknown>> {
  return [toolUseBlock(EDIT_TOOL_NAME, { path }), toolUseBlock(MERGE_TOOL_NAME, { task })];
}

/** Build a 3-line synthetic transcript: prompt, one assistant turn, prompt. */
function buildTranscript(assistantContent: Array<Record<string, unknown>>): TranscriptLine[] {
  return [
    userPromptLine("first turn"),
    assistantLine(assistantContent),
    userPromptLine("second turn"),
  ];
}

/** Run the pure detector against a synthetic transcript, mirroring run()'s own extraction. */
function detect(lines: TranscriptLine[]) {
  const turnLines = extractLastAssistantTurn(lines);
  const assistantText = extractAssistantText(turnLines);
  return detectBuildClaimInjection(assistantText, lines);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("module constants", () => {
  test("INJECTION_ENABLED is false in v1 (calibration mode)", () => {
    expect(INJECTION_ENABLED).toBe(false);
  });

  test("OVERRIDE_ENV_VAR exports the correct env var name", () => {
    expect(OVERRIDE_ENV_VAR).toBe("MINSKY_ACK_BUILD_CLAIM_INJECTION");
  });

  test("USABILITY_CLAIM_PATTERNS is non-empty", () => {
    expect(USABILITY_CLAIM_PATTERNS.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// detectBuildClaimInjection (pure logic)
// ---------------------------------------------------------------------------

describe("detectBuildClaimInjection", () => {
  test("FIRES: cockpit-tray-surface merge + usability claim + no rebuild evidence", () => {
    const lines = buildTranscript([
      ...editAndMergeBlocks(TRAY_SURFACE_PATH),
      textBlock(USABILITY_CLAIM_TEXT),
    ]);

    const result = detect(lines);

    expect(result.matched).toBe(true);
    expect(result.matchedPhrase).toBeDefined();
    expect(result.deploySurfaceFiles).toContain(TRAY_SURFACE_PATH);
    expect(result.hadMerge).toBe(true);
    expect(result.hadRebuildEvidence).toBe(false);
  });

  test("FIRES: Railway deploy-surface merge (Dockerfile) + usability claim + no rebuild evidence", () => {
    const lines = buildTranscript([
      toolUseBlock("Edit", { file_path: RAILWAY_SURFACE_PATH }),
      toolUseBlock(MERGE_TOOL_NAME, { task: "mt#0001" }),
      textBlock("It's live — go ahead and test."),
    ]);

    const result = detect(lines);

    expect(result.matched).toBe(true);
    expect(result.deploySurfaceFiles).toContain(RAILWAY_SURFACE_PATH);
  });

  test("SILENT: same scenario, but a rebuild/install command is present", () => {
    const lines = buildTranscript([
      ...editAndMergeBlocks(TRAY_SURFACE_PATH),
      toolUseBlock("Bash", { command: "cockpit-tray/scripts/install-local.sh" }),
      textBlock(USABILITY_CLAIM_TEXT),
    ]);

    const result = detect(lines);

    expect(result.matched).toBe(false);
    expect(result.hadRebuildEvidence).toBe(true);
  });

  test("SILENT: rebuild evidence via deployment_wait-for-latest tool name", () => {
    const lines = buildTranscript([
      ...editAndMergeBlocks(TRAY_SURFACE_PATH),
      toolUseBlock("mcp__minsky__deployment_wait-for-latest", {}),
      textBlock(USABILITY_CLAIM_TEXT),
    ]);

    const result = detect(lines);

    expect(result.matched).toBe(false);
    expect(result.hadRebuildEvidence).toBe(true);
  });

  test("SILENT: usability claim with NO in-session build-surface merge", () => {
    const lines = buildTranscript([textBlock(USABILITY_CLAIM_TEXT)]);

    const result = detect(lines);

    expect(result.matched).toBe(false);
    expect(result.hadMerge).toBe(false);
    expect(result.deploySurfaceFiles).toHaveLength(0);
  });

  test("SILENT: merge occurred, but no deploy-surface file was edited this session", () => {
    const lines = buildTranscript([
      ...editAndMergeBlocks("src/domain/tasks/tasks.ts", "mt#0002"),
      textBlock(USABILITY_CLAIM_TEXT),
    ]);

    const result = detect(lines);

    expect(result.matched).toBe(false);
    expect(result.hadMerge).toBe(true);
    expect(result.deploySurfaceFiles).toHaveLength(0);
  });

  test("SILENT: routine (non-usability) claim after a build-surface merge", () => {
    const lines = buildTranscript([
      ...editAndMergeBlocks(TRAY_SURFACE_PATH),
      textBlock("I merged the PR. The changes are committed to main."),
    ]);

    const result = detect(lines);

    expect(result.matched).toBe(false);
    expect(result.matchedPhrase).toBeUndefined();
  });

  test("empty assistant text returns the empty result", () => {
    const result = detectBuildClaimInjection("", []);
    expect(result.matched).toBe(false);
    expect(result.deploySurfaceFiles).toHaveLength(0);
    expect(result.hadMerge).toBe(false);
    expect(result.hadRebuildEvidence).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// elideBlocksAndQuotes
// ---------------------------------------------------------------------------

describe("elideBlocksAndQuotes", () => {
  test("elides a fenced code block", () => {
    const text = "before\n```\nyou can use it now\n```\nafter";
    const elided = elideBlocksAndQuotes(text);
    expect(elided).not.toContain("you can use it now");
  });

  test("elides a blockquote line", () => {
    const text = "> you can use it now\nreal text";
    const elided = elideBlocksAndQuotes(text);
    expect(elided).toContain("real text");
    expect(elided.split("\n")[0]?.trim()).toBe("");
  });

  test("keeps ordinary prose untouched", () => {
    const text = "you can use it now";
    expect(elideBlocksAndQuotes(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// run() (dispatcher-compatible)
// ---------------------------------------------------------------------------

const HOOK_EVENT_NAME = "UserPromptSubmit";

const HOOK_INPUT: ClaudeHookInput = {
  session_id: "test-session",
  transcript_path: "/mock/transcript.jsonl",
  cwd: "/test",
  hook_event_name: HOOK_EVENT_NAME,
};

function makeCtx(transcriptLines: TranscriptLine[]): DispatchContext {
  return {
    event: HOOK_EVENT_NAME,
    hostCapSec: 15,
    budgets: { overallBudgetMs: 9000, fetchTimeoutMs: 4950, gitTimeoutMs: 1530 },
    transcriptCandidates: ["/mock/transcript.jsonl"],
    transcriptLines,
  };
}

/** The canonical firing scenario's transcript, reused across the run() tests below. */
function firingScenarioLines(): TranscriptLine[] {
  return buildTranscript([
    ...editAndMergeBlocks(TRAY_SURFACE_PATH),
    textBlock(USABILITY_CLAIM_TEXT),
  ]);
}

describe("run() (dispatcher-compatible)", () => {
  test("firing scenario -> calibration record, NO additionalContext (INJECTION_ENABLED=false)", () => {
    const outcome = run(HOOK_INPUT, makeCtx(firingScenarioLines()));

    expect(outcome?.calibration).toBeDefined();
    expect(outcome?.calibration?.session_id).toBe("test-session");
    expect(outcome?.calibration?.matchedPhrases).toBeDefined();
    expect(outcome?.additionalContext).toBeUndefined();
    expect(INJECTION_ENABLED).toBe(false);
  });

  test("non-firing scenario -> null (silent allow)", () => {
    const lines = buildTranscript([textBlock(USABILITY_CLAIM_TEXT)]);
    expect(run(HOOK_INPUT, makeCtx(lines))).toBeNull();
  });

  test("no transcript_path -> null", () => {
    const input: ClaudeHookInput = {
      session_id: "test",
      cwd: "/test",
      hook_event_name: HOOK_EVENT_NAME,
    };
    expect(run(input, makeCtx(firingScenarioLines()))).toBeNull();
  });

  test("empty transcript -> null", () => {
    expect(run(HOOK_INPUT, makeCtx([]))).toBeNull();
  });

  test("override env var suppresses detection and returns an audit line", () => {
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const outcome = run(HOOK_INPUT, makeCtx(firingScenarioLines()));
      expect(outcome?.calibration).toBeUndefined();
      expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
    } finally {
      delete process.env[OVERRIDE_ENV_VAR];
    }
  });
});
