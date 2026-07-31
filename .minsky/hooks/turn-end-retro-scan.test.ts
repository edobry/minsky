/* eslint-disable custom/no-real-fs-in-tests -- the dedup store (turn-end-scan-store.ts) writes real per-session JSON files; these tests exercise the real store roundtrip (write -> dedup-read -> clear) in an isolated mkdtemp dir, mirroring substrate-bypass-detector.test.ts's precedent */
// Tests for the Stop-event turn-end retrospective scan (mt#2357).
//
// Covers the guard's acceptance surface: fires on an unaddressed R-family
// phrase in the final turn; suppressed by a same-turn /retrospective
// invocation; dedup bounds each (turn, family, phrase) to ONE advisory
// across re-invocations (the Stop-continuation ping-pong guard); the
// last_assistant_message union covers a lagging transcript; elision keeps
// quoted phrases silent; the shared override env var is honored.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type StopHookInput } from "./turn-end-retro-scan";
import { OVERRIDE_ENV_VAR } from "./retrospective-trigger-scanner";
import {
  flagKey,
  readFlagged,
  turnKeyFor,
  writeFlagged,
  clearFlagged,
} from "./turn-end-scan-store";
import type { DispatchContext } from "./registry";
import type { TranscriptLine } from "./transcript";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const userPrompt = (text: string, uuid?: string): TranscriptLine => ({
  type: "user",
  message: { role: "user", content: text },
  ...(uuid ? { uuid } : {}),
});

const assistantText = (text: string): TranscriptLine => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const retroSkillInvocation = (): TranscriptLine => ({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", name: "Skill", input: { skill: "retrospective" } }],
  },
});

const STOP_INPUT: StopHookInput = {
  session_id: "mt2357-test-session",
  transcript_path: "/mock/transcript.jsonl",
  cwd: "/test",
  hook_event_name: "Stop",
};

/** Shared R1 admission fixture (matches R1's "I made a mistake" pattern). */
const DEPLOY_MISTAKE = "I made a mistake in the deploy step.";

function makeCtx(transcriptLines: TranscriptLine[]): DispatchContext {
  return {
    event: "Stop",
    hostCapSec: 15,
    budgets: { overallBudgetMs: 9000, fetchTimeoutMs: 4950, gitTimeoutMs: 1530 },
    transcriptCandidates: ["/mock/transcript.jsonl"],
    transcriptLines,
  };
}

let storeDir: string;

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "mt2357-turn-end-scan-"));
  delete process.env[OVERRIDE_ENV_VAR];
});

afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
  delete process.env[OVERRIDE_ENV_VAR];
});

// ---------------------------------------------------------------------------
// Firing + suppression
// ---------------------------------------------------------------------------

describe("run() — firing and suppression", () => {
  test("unaddressed R1 phrase in the final turn -> advisory + calibration (channel stop)", () => {
    const lines = [
      userPrompt("deploy the service", "u-open"),
      assistantText(`Deploying now. ${DEPLOY_MISTAKE} Continuing.`),
    ];
    const outcome = run(STOP_INPUT, makeCtx(lines), storeDir);
    expect(outcome).not.toBeNull();
    expect(outcome?.additionalContext).toContain("turn-end-retro-scan");
    expect(outcome?.additionalContext).toContain("R1");
    expect(outcome?.calibration?.channel).toBe("stop");
    expect(outcome?.calibration?.source).toBe("live");
  });

  // mt#3098: both scanners share ONE FAMILY_PATTERNS corpus (this module
  // imports detectTriggerPhrases from retrospective-trigger-scanner), so a
  // corpus gap is a two-surface gap — and the corpus fix must be provably a
  // two-surface fix. This pins the reversed-order R3 commitment (the 2026-07-23
  // admission) firing through the Stop path, not just the prompt-time one.
  test("reversed-order R3 commitment fires through the Stop path (mt#3098)", () => {
    const lines = [
      userPrompt("give me a handoff", "u-3098"),
      assistantText("I'll invoke it rather than improvise going forward."),
    ];
    const outcome = run(STOP_INPUT, makeCtx(lines), storeDir);
    expect(outcome).not.toBeNull();
    expect(outcome?.additionalContext).toContain("R3");
    expect(outcome?.calibration?.channel).toBe("stop");
  });

  test("same-turn /retrospective invocation -> silent", () => {
    const lines = [
      userPrompt("deploy the service"),
      assistantText(DEPLOY_MISTAKE),
      retroSkillInvocation(),
    ];
    expect(run(STOP_INPUT, makeCtx(lines), storeDir)).toBeNull();
  });

  test("no trigger phrase -> silent", () => {
    const lines = [userPrompt("deploy"), assistantText("Deployed cleanly, all checks green.")];
    expect(run(STOP_INPUT, makeCtx(lines), storeDir)).toBeNull();
  });

  test("quoted phrase (backticks) is elided -> silent", () => {
    const lines = [
      userPrompt("explain the detector"),
      assistantText("The pattern `I made a mistake` is one of the R1 triggers."),
    ];
    expect(run(STOP_INPUT, makeCtx(lines), storeDir)).toBeNull();
  });

  test("last_assistant_message is scanned even when the transcript lags (empty turn)", () => {
    const input: StopHookInput = {
      ...STOP_INPUT,
      last_assistant_message: "I made a mistake in the migration ordering.",
    };
    const outcome = run(input, makeCtx([userPrompt("migrate")]), storeDir);
    expect(outcome).not.toBeNull();
    expect(outcome?.additionalContext).toContain("R1");
  });

  test("override env var -> audit line only, no advisory", () => {
    process.env[OVERRIDE_ENV_VAR] = "1";
    const lines = [userPrompt("x"), assistantText("I made a mistake here.")];
    const outcome = run(STOP_INPUT, makeCtx(lines), storeDir);
    expect(outcome?.additionalContext).toBeUndefined();
    expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
  });
});

// ---------------------------------------------------------------------------
// Dedup — one advisory beat per (turn, family, phrase)
// ---------------------------------------------------------------------------

describe("run() — dedup", () => {
  test("second Stop invocation for the same turn -> silent (no continuation ping-pong)", () => {
    const lines = [userPrompt("deploy", "u-open"), assistantText(DEPLOY_MISTAKE)];
    const first = run(STOP_INPUT, makeCtx(lines), storeDir);
    expect(first?.additionalContext).toBeDefined();

    // The continuation appended more assistant text; the flagged phrase must
    // not re-fire (stop_hook_active models the continuation re-invocation).
    const continued = [
      ...lines,
      assistantText(
        "Acknowledged — judged not retro-worthy because the phrase describes upstream code."
      ),
    ];
    const second = run({ ...STOP_INPUT, stop_hook_active: true }, makeCtx(continued), storeDir);
    expect(second).toBeNull();
  });

  test("a NEW phrase (different family) appearing in the continuation still fires once", () => {
    const lines = [userPrompt("deploy", "u-open"), assistantText(DEPLOY_MISTAKE)];
    run(STOP_INPUT, makeCtx(lines), storeDir);
    // NOTE: detectTriggerPhrases yields at most ONE match per family (first
    // pattern wins), so a second R1 phrase in the same turn is implicitly
    // masked by the flagged first one — the fresh signal here must be a
    // DIFFERENT family (R3).
    const continued = [
      ...lines,
      assistantText("Going forward I'll double-check the config target."),
    ];
    const second = run({ ...STOP_INPUT, stop_hook_active: true }, makeCtx(continued), storeDir);
    expect(second).not.toBeNull();
    expect(second?.additionalContext).toContain("R3");
    // And a THIRD invocation is silent again.
    expect(run({ ...STOP_INPUT, stop_hook_active: true }, makeCtx(continued), storeDir)).toBeNull();
  });

  test("store roundtrip: the flag the guard writes is keyed to the opening prompt", () => {
    const opening = userPrompt("deploy", "u-open");
    const lines = [opening, assistantText(DEPLOY_MISTAKE)];
    run(STOP_INPUT, makeCtx(lines), storeDir);
    const flagged = readFlagged(STOP_INPUT.session_id, storeDir);
    expect(flagged.has(flagKey(turnKeyFor(opening), "R1", "I made a mistake"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

describe("turn-end-scan-store", () => {
  test("read of an absent store fails open to empty; write/read/clear roundtrip", () => {
    expect(readFlagged("nope", storeDir).size).toBe(0);
    writeFlagged("s1", new Set(["a|R1|x"]), storeDir);
    expect(readFlagged("s1", storeDir).has("a|R1|x")).toBe(true);
    clearFlagged("s1", storeDir);
    expect(readFlagged("s1", storeDir).size).toBe(0);
  });

  test("turnKeyFor prefers uuid, falls back to timestamp, then session-start", () => {
    expect(turnKeyFor({ uuid: "u", timestamp: "t" } as TranscriptLine)).toBe("u");
    expect(turnKeyFor({ timestamp: "t" } as TranscriptLine)).toBe("t");
    expect(turnKeyFor(undefined)).toBe("session-start");
  });
});
