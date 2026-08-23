/**
 * The shared terminal-condition classifier (mt#3132 Success Criterion 4).
 *
 * Pure — no React, no router, no DOM. These pin the taxonomy's two properties
 * that matter: BOTH pipelines resolve to the same vocabulary, and the classifier
 * refuses to name an outcome it cannot evidence.
 */
import { describe, test, expect } from "bun:test";
import {
  classifyOutcome,
  isApiErrorText,
  isTerminalSessionDriverStatus,
  OUTCOME_TONE,
  type ConversationOutcome,
} from "./conversation-outcome";

/** A representative harness-emitted API-error turn (mt#2793's own example). */
const API_ERROR_TURN = "API Error: Connection closed mid-response.";

function transcript(texts: string[], interrupted = false) {
  return classifyOutcome({ source: "transcript", interrupted, texts });
}

describe("classifyOutcome — transcript evidence", () => {
  test("an unremarkable turn is null, never Completed", () => {
    // The load-bearing negative: labeling a turn `Completed` with no completion
    // signal asserts completion for turns that were actually cut off.
    expect(transcript(["just some ordinary assistant prose"])).toBeNull();
    expect(transcript([])).toBeNull();
  });

  test("an anchored API-error turn is Errored", () => {
    expect(transcript([API_ERROR_TURN])).toBe("Errored");
  });

  test("leading whitespace does not defeat the anchor", () => {
    expect(transcript(["   API Error: something broke"])).toBe("Errored");
  });

  test("a throttle-shaped API-error turn is Rate-limited, not Errored", () => {
    expect(transcript(["API Error: 429 Too Many Requests"])).toBe("Rate-limited");
    expect(transcript(["API Error: rate limit exceeded, retry later"])).toBe("Rate-limited");
  });

  test("Rate-limited wins over a plain error elsewhere in the same turn", () => {
    // The more specific reading of the same evidence, and the one that tells the
    // operator the condition clears on its own.
    expect(transcript([API_ERROR_TURN, "API Error: 429 slow down"])).toBe("Rate-limited");
  });

  test("interruption wins over error", () => {
    // Load-bearing precedence: the harness marks a cancelled tool call `isError`,
    // but the operator cancelling is not a failure — reporting it as `Errored`
    // is the miscount mt#3131 removed from the tallies.
    expect(transcript([API_ERROR_TURN], true)).toBe("Interrupted");
  });

  test("prose ABOUT rate limits or API errors is not classified", () => {
    // The conservatism that makes this usable: an agent discussing these terms
    // is the common case, and matching it would misreport healthy turns.
    expect(transcript(["We should handle the API Error: prefix case and 429s here."])).toBeNull();
    expect(transcript(["the provider rate limit is 429 requests per minute"])).toBeNull();
    expect(transcript(["I hit a rate limit earlier but recovered"])).toBeNull();
  });
});

describe("classifyOutcome — session driver evidence", () => {
  test("a clean exit is Completed", () => {
    expect(classifyOutcome({ source: "sessionDriver", status: "exited" })).toBe("Completed");
  });

  test("both crash flavours are Crashed", () => {
    expect(classifyOutcome({ source: "sessionDriver", status: "crashed" })).toBe("Crashed");
    expect(classifyOutcome({ source: "sessionDriver", status: "unrecoverable" })).toBe("Crashed");
  });
});

describe("isTerminalSessionDriverStatus", () => {
  test("admits the three terminal statuses", () => {
    expect(isTerminalSessionDriverStatus("exited")).toBe(true);
    expect(isTerminalSessionDriverStatus("crashed")).toBe(true);
    expect(isTerminalSessionDriverStatus("unrecoverable")).toBe(true);
  });

  test("rejects transport states — a channel's lifecycle is not an outcome", () => {
    expect(isTerminalSessionDriverStatus("connecting")).toBe(false);
    expect(isTerminalSessionDriverStatus("reconnecting")).toBe(false);
    expect(isTerminalSessionDriverStatus("live")).toBe(false);
  });
});

describe("the shared vocabulary", () => {
  test("every value carries a tone, so no outcome can render unstyled", () => {
    const values: ConversationOutcome[] = [
      "Completed",
      "Interrupted",
      "Errored",
      "Rate-limited",
      "Crashed",
      "Stalled",
    ];
    for (const value of values) {
      expect(OUTCOME_TONE[value]).toBeTruthy();
    }
    // Exactly the six mt#3130 values — a seventh added without a tone would
    // fail above, and one added WITH a tone should be a deliberate edit here.
    expect(Object.keys(OUTCOME_TONE).sort()).toEqual([...values].sort());
  });

  test("Interrupted and Rate-limited are amber, never destructive", () => {
    // `docs/design-system.md`'s red-scarcity rule: neither an operator's own
    // cancellation nor a transient throttle is a genuine failure.
    expect(OUTCOME_TONE.Interrupted).not.toContain("destructive");
    expect(OUTCOME_TONE["Rate-limited"]).not.toContain("destructive");
    expect(OUTCOME_TONE.Errored).toContain("destructive");
    expect(OUTCOME_TONE.Crashed).toContain("destructive");
  });
});

describe("isApiErrorText", () => {
  test("is the same anchored rule the classifier splits on", () => {
    expect(isApiErrorText("API Error: boom")).toBe(true);
    expect(isApiErrorText("  API Error: boom")).toBe(true);
    expect(isApiErrorText("discussing the API Error: prefix")).toBe(false);
  });
});
