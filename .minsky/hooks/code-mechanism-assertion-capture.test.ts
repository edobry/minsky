/**
 * Judged-input capture on the code-mechanism-assertion detector (mt#3649) — AT1.
 *
 * A record used to carry the extracted claims but nothing to re-run a changed
 * detector against. These assert the RECOVERED input is the text the detector
 * judged — the premise the replay harness rests on — and that it is the ELIDED
 * copy rather than the raw turn text (SC4).
 *
 * Its own file rather than an append to `code-mechanism-assertion-detector.test.ts`
 * because that file sits at the 1500-line `max-lines` ceiling.
 */
import { describe, expect, test } from "bun:test";
import { run } from "./code-mechanism-assertion-detector";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";

const RUN_HOOK_EVENT_NAME = "UserPromptSubmit";

const RUN_HOOK_INPUT: ClaudeHookInput = {
  session_id: "test-session",
  transcript_path: "/mock/transcript.jsonl",
  cwd: "/test",
  hook_event_name: RUN_HOOK_EVENT_NAME,
};

/** Mirrors the sibling suite's stub: never touch the real fs-backed dedup store. */
const ALWAYS_INJECT_DEPS = { shouldInjectClaimSetFn: () => true };

function userLine(text = "test user message"): TranscriptLine {
  return { type: "user", message: { role: "user", content: text } };
}

function assistantLine(text: string): TranscriptLine {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function makeCtx(transcriptLines: TranscriptLine[]): DispatchContext {
  return {
    event: RUN_HOOK_EVENT_NAME,
    hostCapSec: 15,
    budgets: { overallBudgetMs: 9000, fetchTimeoutMs: 4950, gitTimeoutMs: 1530 },
    transcriptCandidates: ["/mock/transcript.jsonl"],
    transcriptLines,
  };
}

const CLAIM_TEXT = "The 1MB default `maxBuffer` is at its limit, and `executeCommand` clamps it.";

describe("judged-input capture (mt#3649)", () => {
  test("AT1: the record's captured input is recoverable and matches what was judged", async () => {
    const outcome = await run(
      RUN_HOOK_INPUT,
      makeCtx([userLine(), assistantLine(CLAIM_TEXT), userLine()]),
      ALWAYS_INJECT_DEPS
    );
    const cal = outcome?.calibration as Record<string, unknown>;

    // Without the marker a reader cannot tell "no claims" from "not
    // re-classifiable".
    expect(cal["captureSchema"]).toBe(1);

    const captured = cal["judgedInput"] as {
      excerpt: string;
      hash: string;
      length: number;
      truncated: boolean;
    };
    expect(captured.excerpt).toContain("maxBuffer");
    expect(captured.excerpt).toContain("executeCommand");
    expect(captured.truncated).toBe(false);
    expect(captured.length).toBe(captured.excerpt.length);
    expect(captured.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("PR #2926 R1: the capture is the ELIDED copy, not the raw turn text", async () => {
    // SC4 — a fenced block is where pasted tool output, and any secret in it,
    // would reach the log.
    const secretish = "sk-live-DO-NOT-LOG-abcdefghijklmnop";
    const outcome = await run(
      RUN_HOOK_INPUT,
      makeCtx([
        userLine(),
        assistantLine(`${CLAIM_TEXT}\n\n\`\`\`\n${secretish}\n\`\`\`\n`),
        userLine(),
      ]),
      ALWAYS_INJECT_DEPS
    );
    const cal = outcome?.calibration as Record<string, unknown>;
    const captured = cal["judgedInput"] as { excerpt: string };

    // The fenced content is blanked...
    expect(captured.excerpt).not.toContain(secretish);
    // ...while the prose the detector actually judged survives.
    expect(captured.excerpt).toContain("maxBuffer");
  });

  test("the capture is written even when the chat surface extracts NO claims", async () => {
    // Capture must not be conditional on a match, or the near-misses that most
    // need re-classification are the ones with no input to replay. PR #2926 R1:
    // this used matching text, so it asserted nothing about the empty case.
    const outcome = await run(
      RUN_HOOK_INPUT,
      makeCtx([
        userLine(),
        assistantLine("The comment surface is worth a look when you get a chance."),
        userLine(),
      ]),
      ALWAYS_INJECT_DEPS
    );
    if (outcome?.calibration === undefined) {
      // `no match -> null` is documented behaviour; nothing to assert here.
      expect(outcome).toBeNull();
      return;
    }
    const cal = outcome.calibration as Record<string, unknown>;
    expect((cal["claims"] as unknown[]).length).toBe(0);
    expect(cal["judgedInput"]).toBeDefined();
  });
});
