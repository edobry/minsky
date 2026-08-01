/* eslint-disable custom/no-real-fs-in-tests -- the dedup store (turn-end-scan-store.ts) writes real per-session JSON files; these tests exercise the real store roundtrip (write -> dedup-read) in an isolated mkdtemp dir, mirroring turn-end-retro-scan.test.ts's precedent */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectUntakenAction,
  run,
  TAIL_WINDOW_CHARS,
  OVERRIDE_ENV_VAR,
  SUPPRESSION_DEDUPED_BY_ASK_ROUTING_DEFERRAL,
} from "./turn-end-untaken-action-scan";
import type { StopHookInput } from "./turn-end-retro-scan";
import type { DispatchContext } from "./registry";

// Verbatim tails from the mt#3179 incidents. These are the regression anchors:
// if the detector stops matching them, the guard has lost the class it exists
// for.
const R3_FINAL_MESSAGE =
  "mt#3179 is incident-response, so I'm taking it forward rather than leaving it filed — that's the next step, not a question.";

const R2_FINAL_MESSAGE =
  "PR #2261 is now approved with zero findings and fully green — ready to merge on your word. " +
  "Holding per the merge carve-out, since bot approval doesn't auto-merge. " +
  "Once you give the go-ahead I'll merge, then confirm the deploy comes up healthy.";

// A turn that legitimately ended while an armed watcher was pending. This one
// must stay silent — the agent HAD taken an action.
const LEGITIMATE_WATCHER_MESSAGE =
  "GitHub is 500ing on the create-PR call. A retry watcher is armed (~7 min); " +
  "I'll re-attempt the PR when it fires — no action needed from you.";

const ctx: DispatchContext = { transcriptLines: [] } as unknown as DispatchContext;

let storeDir: string;

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "mt3179-store-"));
  delete process.env[OVERRIDE_ENV_VAR];
});

afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
  delete process.env[OVERRIDE_ENV_VAR];
});

describe("detectUntakenAction (mt#3179)", () => {
  test("fires on the R3 incident text (commitment-shaped stop)", () => {
    const matches = detectUntakenAction(R3_FINAL_MESSAGE);
    expect(matches.length).toBeGreaterThan(0);
    const families = matches.map((m) => m.family);
    expect(families).toContain("taking-forward");
    expect(families).toContain("next-step");
  });

  test("fires on the R2 incident text (deferral-shaped stop)", () => {
    const matches = detectUntakenAction(R2_FINAL_MESSAGE);
    expect(matches.map((m) => m.family)).toContain("give-go-ahead");
  });

  test("stays silent when an armed watcher explains the stop", () => {
    expect(detectUntakenAction(LEGITIMATE_WATCHER_MESSAGE)).toEqual([]);
  });

  test("stays silent on an announcement the turn then acted on (outside the tail window)", () => {
    // Announce-then-do: the announcement is followed by enough subsequent
    // content that it falls outside the tail window. Announce-then-STOP puts
    // the announcement last, which is the whole discriminator.
    const message = `I'll proceed to the migration now.\n${"x".repeat(TAIL_WINDOW_CHARS + 200)}`;
    expect(detectUntakenAction(message)).toEqual([]);
  });

  test("stays silent on empty input", () => {
    expect(detectUntakenAction("")).toEqual([]);
  });
});

describe("run (mt#3179)", () => {
  function inputWith(message: string): StopHookInput {
    return {
      session_id: "mt3179-test",
      last_assistant_message: message,
    } as StopHookInput;
  }

  test("returns an advisory additionalContext, never a deny", () => {
    const outcome = run(inputWith(R3_FINAL_MESSAGE), ctx, storeDir);
    expect(outcome).not.toBeNull();
    expect(outcome?.deny).toBeUndefined();
    expect(outcome?.additionalContext).toContain(
      "named a next action and ended the turn without taking it"
    );
  });

  test("dedups: the same phrase does not fire twice for one turn", () => {
    const first = run(inputWith(R3_FINAL_MESSAGE), ctx, storeDir);
    expect(first?.additionalContext).toBeDefined();
    const second = run(inputWith(R3_FINAL_MESSAGE), ctx, storeDir);
    expect(second).toBeNull();
  });

  test("a DIFFERENT later turn in the same session still fires (PR #2293 R1)", () => {
    // The regression this pins: keying dedup on the transcript's opening prompt
    // collapses to the literal "session-start" when no transcript is present
    // (which is the case throughout these tests — `ctx` carries none), so the
    // first fire would have suppressed the phrase for the REST of the session,
    // silencing exactly the repeat offenses the guard exists to catch. Keying
    // on the final message instead makes each distinct turn fire on its own.
    const first = run(inputWith(R3_FINAL_MESSAGE), ctx, storeDir);
    expect(first?.additionalContext).toBeDefined();

    // Same family ("say-the-word"/"give-go-ahead" vs "taking-forward") is not
    // required — what matters is that a different turn is not pre-suppressed.
    const second = run(inputWith(R2_FINAL_MESSAGE), ctx, storeDir);
    expect(second?.additionalContext).toBeDefined();

    // And a third turn repeating the SAME commitment family in new prose fires
    // too — the offense recurring is the signal, not noise to be deduped.
    const third = run(
      inputWith("Different wrap-up prose entirely. I'm taking it forward from here."),
      ctx,
      storeDir
    );
    expect(third?.additionalContext).toBeDefined();
  });

  test("returns null when there is no final message", () => {
    expect(run({ session_id: "x" } as StopHookInput, ctx, storeDir)).toBeNull();
  });

  test("override emits an audit line and no reminder", () => {
    process.env[OVERRIDE_ENV_VAR] = "1";
    const outcome = run(inputWith(R3_FINAL_MESSAGE), ctx, storeDir);
    expect(outcome?.additionalContext).toBeUndefined();
    expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
  });
});

// ---------------------------------------------------------------------------
// mt#3336 (ask#6448 dispositions): quoted-context elision + same-turn dedup
// against ask-routing-deferral.
// ---------------------------------------------------------------------------

describe("mt#3336 — quoted-context elision", () => {
  // Replay of the self-demonstrating false positive recorded in mt#3303's
  // spec: a handoff QUOTING detector data in a markdown blockquote tripped
  // the "say-the-word" family. Quoted text is reported, not said.
  test("a commitment phrase inside a blockquote does NOT match", () => {
    const handoffShape =
      "Recording the calibration backlog for the next session. The flagged text was:\n\n" +
      '> the open question is a 7-of-10 "Say the word" cluster that needs turn context\n\n' +
      "No disposition was recorded; the review task carries the details.";
    expect(detectUntakenAction(handoffShape)).toEqual([]);
  });

  test("a commitment phrase inside a code fence or inline code does NOT match", () => {
    const fenced =
      "Documented the detector families.\n\n```\n{ family: 'say-the-word' } matches: say the word\n```\nDone.";
    expect(detectUntakenAction(fenced)).toEqual([]);
    const inline = "The `say the word` pattern stays as-is; nothing else changed.";
    expect(detectUntakenAction(inline)).toEqual([]);
  });

  test("the same phrase UNQUOTED still matches (elision does not over-suppress)", () => {
    const matches = detectUntakenAction("Everything is staged. Say the word and it ships.");
    expect(matches.map((m) => m.family)).toContain("say-the-word");
  });
});

describe("mt#3336 — dedup against ask-routing-deferral", () => {
  function inputFor(message: string): StopHookInput {
    return {
      session_id: "mt3336-dedup-session",
      last_assistant_message: message,
    } as StopHookInput;
  }

  // "say the word" sits in BOTH detectors' pattern sets; without the dedup
  // this turn gets an untaken-action reminder at Stop AND an
  // ask-routing-deferral reminder at the next UserPromptSubmit.
  test("a message also matching the deferral patterns logs but does NOT inject", () => {
    const both = "Everything is staged and green. Say the word and it ships.";
    const outcome = run(inputFor(both), ctx, storeDir);
    expect(outcome?.calibration).toBeDefined();
    expect((outcome?.calibration as Record<string, unknown>).suppressedByAskRoutingDeferral).toBe(
      true
    );
    expect(outcome?.additionalContext).toBeUndefined();
  });

  test("a commitment-only message (no deferral shape) still injects", () => {
    const outcome = run(inputFor(R3_FINAL_MESSAGE), ctx, storeDir);
    expect(outcome?.calibration).toBeDefined();
    expect((outcome?.calibration as Record<string, unknown>).suppressedByAskRoutingDeferral).toBe(
      false
    );
    expect(outcome?.additionalContext).toBeDefined();
  });

  // mt#3207: the boolean above is detector-specific detail that
  // `isSuppressedRecord` cannot see — which is why the 2026-08-01 sweep read
  // 18 dedup-suppressed fires as injected. These pin the SHARED field.
  test("mt#3207: a suppressed fire names the gate in suppressionReasons", () => {
    const both = "Everything is staged and green. Say the word and it ships.";
    const outcome = run(inputFor(both), ctx, storeDir);
    expect((outcome?.calibration as Record<string, unknown>).suppressionReasons).toEqual([
      SUPPRESSION_DEDUPED_BY_ASK_ROUTING_DEFERRAL,
    ]);
  });

  test("mt#3207: an injected fire records an EMPTY suppressionReasons, not an absent one", () => {
    const outcome = run(inputFor(R3_FINAL_MESSAGE), ctx, storeDir);
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.suppressionReasons).toEqual([]);
    expect(Object.keys(cal)).toContain("suppressionReasons");
  });
});
