/* eslint-disable custom/no-real-fs-in-tests -- the dedup store (turn-end-scan-store.ts) writes real per-session JSON files; these tests exercise the real store roundtrip (write -> dedup-read -> clear) in an isolated mkdtemp dir, mirroring substrate-bypass-detector.test.ts's precedent */
// Tests for the Stop-event turn-end retrospective scan (mt#2357).
//
// Covers the guard's acceptance surface: fires on an unaddressed R-family
// phrase in the final turn; suppressed by a same-turn /retrospective
// invocation; dedup bounds each (turn, family, phrase) to ONE advisory
// across re-invocations (the Stop-continuation ping-pong guard); the
// last_assistant_message union covers a lagging transcript; elision keeps
// quoted phrases silent; the shared override env var is honored.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorExcerpt, run, type StopHookInput } from "./turn-end-retro-scan";
import { OVERRIDE_ENV_VAR, rungProvenance } from "./retrospective-trigger-scanner";
import {
  flagKey,
  readFlagged,
  turnKeyFor,
  writeFlagged,
  clearFlagged,
} from "./turn-end-scan-store";
import type { DispatchContext } from "./registry";
import type { TranscriptLine } from "./transcript";

// mt#3408: these suites exercise the DETERMINISTIC Rung-1 behaviour of `run()`.
// Rung 2 is switched off here so no test reaches for a live embedding provider;
// nomination has its own coverage with injected deps (see the Rung-2 describe
// block below and packages/domain/src/detectors/embedding-nomination.test.ts).
const ORIGINAL_RUNG2_DISABLE = process.env.MINSKY_DISABLE_RUNG2_NOMINATION;
process.env.MINSKY_DISABLE_RUNG2_NOMINATION = "1";

afterAll(() => {
  if (ORIGINAL_RUNG2_DISABLE === undefined) delete process.env.MINSKY_DISABLE_RUNG2_NOMINATION;
  else process.env.MINSKY_DISABLE_RUNG2_NOMINATION = ORIGINAL_RUNG2_DISABLE;
});

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

/** The opening user prompt paired with {@link DEPLOY_MISTAKE}. */
const DEPLOY_PROMPT = "deploy the service";

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
  test("unaddressed R1 phrase in the final turn -> advisory + calibration (channel stop)", async () => {
    const lines = [
      userPrompt(DEPLOY_PROMPT, "u-open"),
      assistantText(`Deploying now. ${DEPLOY_MISTAKE} Continuing.`),
    ];
    const outcome = await run(STOP_INPUT, makeCtx(lines), storeDir);
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
  test("reversed-order R3 commitment fires through the Stop path (mt#3098)", async () => {
    const lines = [
      userPrompt("give me a handoff", "u-3098"),
      assistantText("I'll invoke it rather than improvise going forward."),
    ];
    const outcome = await run(STOP_INPUT, makeCtx(lines), storeDir);
    expect(outcome).not.toBeNull();
    expect(outcome?.additionalContext).toContain("R3");
    expect(outcome?.calibration?.channel).toBe("stop");
  });

  test("same-turn /retrospective invocation -> silent", async () => {
    const lines = [
      userPrompt(DEPLOY_PROMPT),
      assistantText(DEPLOY_MISTAKE),
      retroSkillInvocation(),
    ];
    expect(await run(STOP_INPUT, makeCtx(lines), storeDir)).toBeNull();
  });

  test("no trigger phrase -> silent", async () => {
    const lines = [userPrompt("deploy"), assistantText("Deployed cleanly, all checks green.")];
    expect(await run(STOP_INPUT, makeCtx(lines), storeDir)).toBeNull();
  });

  test("quoted phrase (backticks) is elided -> silent", async () => {
    const lines = [
      userPrompt("explain the detector"),
      assistantText("The pattern `I made a mistake` is one of the R1 triggers."),
    ];
    expect(await run(STOP_INPUT, makeCtx(lines), storeDir)).toBeNull();
  });

  test("last_assistant_message is scanned even when the transcript lags (empty turn)", async () => {
    const input: StopHookInput = {
      ...STOP_INPUT,
      last_assistant_message: "I made a mistake in the migration ordering.",
    };
    const outcome = await run(input, makeCtx([userPrompt("migrate")]), storeDir);
    expect(outcome).not.toBeNull();
    expect(outcome?.additionalContext).toContain("R1");
  });

  test("override env var -> audit line only, no advisory", async () => {
    process.env[OVERRIDE_ENV_VAR] = "1";
    const lines = [userPrompt("x"), assistantText("I made a mistake here.")];
    const outcome = await run(STOP_INPUT, makeCtx(lines), storeDir);
    expect(outcome?.additionalContext).toBeUndefined();
    expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
  });
});

// ---------------------------------------------------------------------------
// Dedup — one advisory beat per (turn, family, phrase)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// mt#4102 — the record has to say WHY it fired, and where the phrase came from
// ---------------------------------------------------------------------------

// PR #3163 R1 (BLOCKING): a raw-ENFORCED Rung-2 nomination reaches `matches`
// without passing through the confirm stage, so it is in neither set the
// original two-way `confirmedFamilies ? rung3 : rung1` test looked at — and got
// labelled `rung1`, i.e. "this phrase IS the reason", for a nominated segment.
// That is this task's own defect one level up, so it is pinned directly on the
// classifier rather than only through `run()`.
describe("rungProvenance — mt#4102 / PR #3163 R1", () => {
  test("a confirmed family is rung3 and its phrase is a nomination artifact", () => {
    expect(rungProvenance("R1", ["R1"], ["R1"])).toEqual({
      rung: "rung3",
      phrase_is_nomination_artifact: true,
    });
  });

  test("an ENFORCED nomination is rung2 — not rung1 — and still an artifact", () => {
    // Nominated, never confirmed: the only way it reached `matches` is raw
    // enforcement. The pre-fix code returned `rung1` here.
    expect(rungProvenance("R1", ["R1"], [])).toEqual({
      rung: "rung2",
      phrase_is_nomination_artifact: true,
    });
  });

  test("a family in neither list is rung1, with no artifact flag", () => {
    expect(rungProvenance("R1", [], [])).toEqual({ rung: "rung1" });
  });

  test("a Rung-1 family is unaffected by OTHER families being nominated", () => {
    expect(rungProvenance("R1", ["R4"], ["R4"])).toEqual({ rung: "rung1" });
  });
});

describe("anchorExcerpt — mt#4102", () => {
  test("a Rung-1 phrase anchors in the raw turn text", () => {
    const text = `Deploying now. ${DEPLOY_MISTAKE} Continuing.`;
    const result = anchorExcerpt(text, DEPLOY_MISTAKE);
    expect(result.text).toContain(DEPLOY_MISTAKE);
    expect(result.text).toContain("Deploying now.");
    expect(result.surface).toBe("raw");
    expect(result.unanchoredReason).toBeUndefined();
  });

  // The 2026-08-13T15:55:49Z record's exact shape. Rung 2 scores the ELIDED
  // text, so a confirmed phrase spanning a quoted span exists ONLY there —
  // `text.indexOf` returns -1 and the old code wrote `""` with no reason. That
  // empty excerpt is what made a genuine R1 admission read as a false positive
  // for six days.
  test("a phrase living only in the ELIDED text still anchors, via the fallback", () => {
    const raw = `One check before I answer, since "nothing reconciles them" is a claim I have been asserting. And more text after it.`;
    const elidedOnlyPhrase =
      "One check before I answer, since                           is a claim I have been asserting.";
    expect(raw.indexOf(elidedOnlyPhrase)).toBe(-1); // the pre-fix failure condition

    const result = anchorExcerpt(raw, elidedOnlyPhrase);
    expect(result.text).not.toBe("");
    expect(result.text).toContain("One check before I answer");
    expect(result.unanchoredReason).toBeUndefined();
    // PR #3163 R1 (non-blocking): quoted/code spans in this excerpt are blanked,
    // so it must not be read as raw transcript context.
    expect(result.surface).toBe("elided");
  });

  test("a phrase in neither text reports WHY rather than emitting a bare empty string", () => {
    const result = anchorExcerpt("some unrelated turn text", "a phrase that is simply not present");
    expect(result.text).toBe("");
    expect(result.surface).toBe("none");
    expect(result.unanchoredReason).toBe("phrase not found in raw or elided turn text");
  });
});

describe("run() — match provenance and nomination fields (mt#4102)", () => {
  test("a Rung-1 fire records rung=rung1 and no nomination-artifact flag", async () => {
    const lines = [
      userPrompt(DEPLOY_PROMPT, "u-4102-rung1"),
      assistantText(`Deploying now. ${DEPLOY_MISTAKE} Continuing.`),
    ];
    const outcome = await run(STOP_INPUT, makeCtx(lines), storeDir);
    expect(outcome).not.toBeNull();

    const matches = outcome?.calibration?.matches as
      | { family: string; phrase: string; rung?: string; phrase_is_nomination_artifact?: boolean }[]
      | undefined;
    expect(matches?.[0]?.rung).toBe("rung1");
    expect(matches?.[0]?.phrase_is_nomination_artifact).toBeUndefined();
  });

  // The firing path dropped `nominated_families` entirely while the non-firing
  // path has always written it — so on exactly the records that FIRED, nothing
  // showed what Rung 2 nominated. Absence-of-key is not absence-of-nomination.
  test("the FIRING path writes nominated_families, not only the non-firing path", async () => {
    const lines = [
      userPrompt(DEPLOY_PROMPT, "u-4102-nomfields"),
      assistantText(`Deploying now. ${DEPLOY_MISTAKE} Continuing.`),
    ];
    const outcome = await run(STOP_INPUT, makeCtx(lines), storeDir);
    expect(outcome?.calibration).toHaveProperty("nominated_families");
    expect(outcome?.calibration?.nominated_families).toEqual([]);
    expect(outcome?.calibration).toHaveProperty("nomination_enforcing");
  });
});

describe("run() — dedup", () => {
  test("second Stop invocation for the same turn -> silent (no continuation ping-pong)", async () => {
    const lines = [userPrompt("deploy", "u-open"), assistantText(DEPLOY_MISTAKE)];
    const first = await run(STOP_INPUT, makeCtx(lines), storeDir);
    expect(first?.additionalContext).toBeDefined();

    // The continuation appended more assistant text; the flagged phrase must
    // not re-fire (stop_hook_active models the continuation re-invocation).
    const continued = [
      ...lines,
      assistantText(
        "Acknowledged — judged not retro-worthy because the phrase describes upstream code."
      ),
    ];
    const second = await run(
      { ...STOP_INPUT, stop_hook_active: true },
      makeCtx(continued),
      storeDir
    );
    expect(second).toBeNull();
  });

  test("a NEW phrase (different family) appearing in the continuation still fires once", async () => {
    const lines = [userPrompt("deploy", "u-open"), assistantText(DEPLOY_MISTAKE)];
    await run(STOP_INPUT, makeCtx(lines), storeDir);
    // NOTE: detectTriggerPhrases yields at most ONE match per family (first
    // pattern wins), so a second R1 phrase in the same turn is implicitly
    // masked by the flagged first one — the fresh signal here must be a
    // DIFFERENT family (R3).
    const continued = [
      ...lines,
      assistantText("Going forward I'll double-check the config target."),
    ];
    const second = await run(
      { ...STOP_INPUT, stop_hook_active: true },
      makeCtx(continued),
      storeDir
    );
    expect(second).not.toBeNull();
    expect(second?.additionalContext).toContain("R3");
    // And a THIRD invocation is silent again.
    expect(
      await run({ ...STOP_INPUT, stop_hook_active: true }, makeCtx(continued), storeDir)
    ).toBeNull();
  });

  test("store roundtrip: the flag the guard writes is keyed to the opening prompt", async () => {
    const opening = userPrompt("deploy", "u-open");
    const lines = [opening, assistantText(DEPLOY_MISTAKE)];
    await run(STOP_INPUT, makeCtx(lines), storeDir);
    const flagged = readFlagged(STOP_INPUT.session_id, storeDir);
    expect(flagged.has(flagKey(turnKeyFor(opening), "R1", "I made a mistake"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

describe("turn-end-scan-store", () => {
  test("read of an absent store fails open to empty; write/read/clear roundtrip", async () => {
    expect(readFlagged("nope", storeDir).size).toBe(0);
    writeFlagged("s1", new Set(["a|R1|x"]), storeDir);
    expect(readFlagged("s1", storeDir).has("a|R1|x")).toBe(true);
    clearFlagged("s1", storeDir);
    expect(readFlagged("s1", storeDir).size).toBe(0);
  });

  test("turnKeyFor prefers uuid, falls back to timestamp, then session-start", async () => {
    expect(turnKeyFor({ uuid: "u", timestamp: "t" } as TranscriptLine)).toBe("u");
    expect(turnKeyFor({ timestamp: "t" } as TranscriptLine)).toBe("t");
    expect(turnKeyFor(undefined)).toBe("session-start");
  });
});
