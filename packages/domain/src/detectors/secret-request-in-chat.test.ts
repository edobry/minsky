/**
 * Tests for the secret-request-in-chat matcher (mt#2428).
 *
 * The self-reference block below is CRITERION-GRADE, not a footnote. Every one
 * of the five fires the inherited patterns produced over sixteen days was a
 * false positive of the negation or describes class, and the one still firing
 * on today's tree is the handoff sentence announcing this task. A detector for
 * secret-request prose lives inside a corpus that discusses secret-request
 * prose; if these do not hold, the detector is noise.
 */

import { describe, expect, test } from "bun:test";
import {
  detectSecretRequestInOptionLabels,
  detectSecretRequestInProse,
  hasDescribingFrame,
  hasNegationLead,
  routesToMaskedSurface,
  stripQuoteChars,
} from "./secret-request-in-chat";

describe("secret-request-in-chat — AT1: a real request fires", () => {
  test("paste your bot token here", () => {
    const r = detectSecretRequestInProse("Paste your bot token here and I'll do the rest.");
    expect(r.matched).toBe(true);
    expect(r.matches[0]?.surface).toBe("assistant-prose");
    expect(r.matches[0]?.matchedPhrase.toLowerCase()).toContain("paste your bot token");
  });

  test("give me the API key", () => {
    const r = detectSecretRequestInProse("Give me the API key and I can finish the wiring.");
    expect(r.matched).toBe(true);
  });

  test("reply with your password", () => {
    const r = detectSecretRequestInProse("Reply with your password when you get a chance.");
    expect(r.matched).toBe(true);
  });

  test("the originating incident's own sentence (2026-06-10, mt#2364)", () => {
    const r = detectSecretRequestInProse("Paste the token here and I'll do the rest.");
    expect(r.matched).toBe(true);
  });
});

describe("secret-request-in-chat — overlapping patterns count once", () => {
  /**
   * `paste` appears in two of the three patterns, so "Paste your bot token"
   * matches twice. Reporting both counts ONE request as two in the calibration
   * log — the same double-count the carve against `operator-deferral` exists to
   * prevent, reappearing inside one detector. Caught by the adapter's
   * both-surfaces test before it could reach a log.
   */
  test("a phrase two patterns both match yields ONE match", () => {
    const r = detectSecretRequestInProse("Paste your bot token here.");
    expect(r.matched).toBe(true);
    expect(r.matches).toHaveLength(1);
  });

  test("two genuinely separate requests still yield two matches", () => {
    const r = detectSecretRequestInProse(
      "Paste your bot token here. Then give me the API key as well."
    );
    expect(r.matches).toHaveLength(2);
  });

  test("the longest span at a shared start is the one reported", () => {
    const r = detectSecretRequestInProse("Paste your bot token here.");
    expect(r.matches[0]?.matchedPhrase.toLowerCase()).toBe("paste your bot token");
  });
});

describe("secret-request-in-chat — AT2: routing to a masked surface is suppressed", () => {
  test("names credentials.request", () => {
    const r = detectSecretRequestInProse(
      "I've filed a credentials.request for the Telegram provider — paste the token into that masked form, not here."
    );
    expect(r.matched).toBe(false);
    expect(r.suppressedBy).toContain("routes-to-masked-surface");
  });

  test("names the cockpit credentials widget", () => {
    const r = detectSecretRequestInProse(
      "Open the cockpit credentials widget and enter the token there."
    );
    expect(r.matched).toBe(false);
  });
});

describe("secret-request-in-chat — AT3: non-secret nouns do not fire", () => {
  test.each([
    "Give me your chat id and I'll wire the sink.",
    "Paste the username you want to use.",
    "Share the URL of the failing run.",
    "Give me the task id and I'll pick it up.",
  ])("%s", (sentence) => {
    expect(detectSecretRequestInProse(sentence).matched).toBe(false);
  });
});

describe("secret-request-in-chat — AT4: self-reference control (criterion-grade)", () => {
  /**
   * (b) in the spec's AT4 list, and the load-bearing one: this exact sentence
   * is the single match still firing on `operator-deferral`'s current tree, as
   * of the 2026-08-24 calibration record. It carries no code span, no fence, no
   * blockquote and no double quotes, so `elideQuotedAndCodeContexts` cannot
   * reach it — this suppression is the reason the detector is shippable.
   */
  test("the handoff sentence that announced this task", () => {
    const r = detectSecretRequestInProse(
      "**Next I'm taking mt#2428** — the detector that flags an agent asking you to paste a secret into chat."
    );
    expect(r.matched).toBe(false);
    expect(r.suppressedBy).toContain("describes-rather-than-requests");
  });

  /** (a) this spec's own Summary sentence. */
  test("mt#2428's own Summary sentence", () => {
    const r = detectSecretRequestInProse(
      "Add a guidance detector hook that fires when the assistant's prior turn asks the user to enter a secret in chat."
    );
    expect(r.matched).toBe(false);
    expect(r.suppressedBy).toContain("describes-rather-than-requests");
  });

  /** (c) prose describing the pattern itself. */
  test("prose describing the detector's own trigger", () => {
    const r = detectSecretRequestInProse(
      "The rule fires when an agent asks you to paste the token into the conversation."
    );
    expect(r.matched).toBe(false);
    expect(r.suppressedBy).toContain("describes-rather-than-requests");
  });

  test("a describing frame AFTER the phrase does not suppress it", () => {
    // The frame must precede the match, in the same sentence. Otherwise a long
    // turn that happens to mention "detector" later would silence a real
    // request earlier — the over-suppression this scoping exists to prevent.
    const r = detectSecretRequestInProse(
      "Paste your bot token here. Separately, the detector for this shipped last week."
    );
    expect(r.matched).toBe(true);
  });
});

describe("secret-request-in-chat — AT5: negation control", () => {
  /**
   * Both recorded verbatim from `.minsky/operator-deferral-calibration.jsonl`
   * (2026-08-10). The agent REFUSING to receive a secret is the
   * security-correct behaviour; firing on it would advise degrading it.
   */
  test.each([
    "Then — no needed. Don't paste the token into this chat; I don't need to see it.",
    "Don't paste the token here.",
    "You should not paste the token into chat.",
  ])("%s", (sentence) => {
    const r = detectSecretRequestInProse(sentence);
    expect(r.matched).toBe(false);
    expect(r.suppressedBy).toContain("negation");
  });

  test("a bare `not` is deliberately not a negation lead", () => {
    // "I will not be able to provide the token" is not a refusal to RECEIVE
    // one; the sibling detector omits bare `not` for the same reason.
    expect(hasNegationLead("I will not be able to provide the token", 30)).toBe(false);
  });
});

describe("secret-request-in-chat — known miss, pinned so it stays a decision", () => {
  /**
   * The describes suppression loses a real request phrased in the third person
   * about the speaker. Accepted for a LOG-ONLY v1 and re-measured at the first
   * calibration review; pinned here so it is a decision rather than a belief.
   */
  test("third-person self-attribution is suppressed (accepted false negative)", () => {
    const r = detectSecretRequestInProse("The agent is asking you to paste the token.");
    expect(r.matched).toBe(false);
    expect(r.suppressedBy).toContain("describes-rather-than-requests");
  });

  test("but a first-person request in the same shape still fires", () => {
    const r = detectSecretRequestInProse("I need you to paste the token.");
    expect(r.matched).toBe(true);
  });
});

describe("secret-request-in-chat — ask option labels", () => {
  test("a credential-request label fires", () => {
    const r = detectSecretRequestInOptionLabels(["Provide me the MCP auth token"]);
    expect(r.matched).toBe(true);
    expect(r.matches[0]?.surface).toBe("ask-option-label");
  });

  test("a quote-decorated label still fires", () => {
    // The sibling's mt#3273 audit found this exact silent false negative: the
    // filler group is `[\w-]+`, and `"MCP` opens with a non-word character.
    const r = detectSecretRequestInOptionLabels(['Provide me the "MCP auth token"']);
    expect(r.matched).toBe(true);
  });

  test("the reported context is the ORIGINAL label, not the stripped rewrite", () => {
    const label = 'Provide me the "MCP auth token"';
    const r = detectSecretRequestInOptionLabels([label]);
    expect(r.matches[0]?.context).toBe(label);
  });

  test("a masked-surface label does not fire", () => {
    const r = detectSecretRequestInOptionLabels(["Enter it in the masked form"]);
    expect(r.matched).toBe(false);
  });

  test("a non-secret label does not fire", () => {
    expect(detectSecretRequestInOptionLabels(["You restart the reviewer service"]).matched).toBe(
      false
    );
  });

  test("option labels are NOT describing-frame suppressed", () => {
    // Opposite of prose, deliberately: a label is the agent's own proposal, so
    // it cannot be describing someone else's request. A label mentioning
    // "detector" must still fire.
    const r = detectSecretRequestInOptionLabels(["Give me the detector token"]);
    expect(r.matched).toBe(true);
  });
});

describe("secret-request-in-chat — helpers", () => {
  test("stripQuoteChars keeps the words", () => {
    expect(stripQuoteChars('the "MCP auth token"')).toBe("the MCP auth token");
  });

  test("routesToMaskedSurface recognises credentials.request", () => {
    expect(routesToMaskedSurface("file a credentials.request")).toBe(true);
    expect(routesToMaskedSurface("just send it over")).toBe(false);
  });

  test("hasDescribingFrame only reads text before the match", () => {
    const s = "the detector flags a request to paste the token";
    const idx = s.indexOf("paste");
    expect(hasDescribingFrame(s, idx)).toBe(true);
    expect(hasDescribingFrame(s, 0)).toBe(false);
  });

  test("empty prose is clean, not a crash", () => {
    expect(detectSecretRequestInProse("").matched).toBe(false);
    expect(detectSecretRequestInOptionLabels([]).matched).toBe(false);
  });
});
