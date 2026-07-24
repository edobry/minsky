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
    expect(outcome?.additionalContext).toContain("naming a next action without taking it");
  });

  test("dedups: the same phrase does not fire twice for one turn", () => {
    const first = run(inputWith(R3_FINAL_MESSAGE), ctx, storeDir);
    expect(first?.additionalContext).toBeDefined();
    const second = run(inputWith(R3_FINAL_MESSAGE), ctx, storeDir);
    expect(second).toBeNull();
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
