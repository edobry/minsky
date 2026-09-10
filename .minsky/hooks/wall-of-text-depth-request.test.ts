/**
 * mt#4969 — the depth-request widening for "lets dive deeper" and "tell me
 * more", plus the classes it must NOT silence.
 *
 * Lives in its own file rather than appending to
 * `wall-of-text-detector.test.ts`, which these tests pushed past the 1500-line
 * `max-lines` ceiling. Same reason `wall-of-text-turn-window.test.ts` exists.
 * The full-array name-list assertion stays in that file, since it is about the
 * whole list rather than about these two entries.
 */

import { describe, expect, test } from "bun:test";

import { detectDepthRequest } from "./wall-of-text-detector";

// VERBATIM `precedingPrompt` excerpts (all `truncated: false`) from the
// 2026-09-04 window's injected over-budget records that carried
// `suppressedByDepthRequest: false`. Verbatim is the point: these are a
// regression test for the measured misses, not a restatement of the regex.
const DIVE_DEEPER_PATTERN_NAME = "lets-dive-deeper";
const TELL_ME_MORE_PATTERN_NAME = "tell-me-more";
const DIVE_DEEPER_PROMPT =
  "i want to poke more at the session/conversation ambiguity, lets dive deeper into the community discourse around this, and also take a look at the broader usage/consensus across the field, both in research and other harnesses/agents, i think we need to get some more certainty around our stance on these terms first. also have fable think thru this first";
const TELL_ME_MORE_PROMPT =
  'tell me more about their concept of an "exit handoff" and how that interacts with our notions of a handoff/work package';
// The NEAR-MISS, and the reason `lets-dive-deeper` carries a hortative lead
// rather than matching a bare "dive deeper into". This is a REAL injected
// record from the SAME window (2026-09-02T20:07:35.858Z, 407 words), not a
// constructed counter-example: its 960-character prompt reaches the phrase
// only around offset 830, where it names one of two candidate research
// TARGETS inside a hypothetical ("if we want to") rather than requesting a
// longer answer. A bare /\bdive deeper into\b/ suppresses it, taking the
// window's newly-suppressed count to 4 and failing mt#4969's AT1.
const HYPOTHETICAL_TARGET_PROMPT =
  'we\'ve discussed several times recently the whole harness/claude-code session/conversation semantic conflict, how there seems to be a lot of confusion all around regarding precisely what each word refers to, and we\'ve even found conflicting information in anthropics docs and claude code itself, iirc. i want to get a clear answer on this so we stop circling on this and can settle the question to my satisfaction, as this is a critical input to the direction we take minsky in, particularly in terms of "driving" "sessions". first, go hunt down all our recent conversations about this and any related artifacts (tasks, memories, notion docs, etc), and then depending on what you find, decide what the best path forward is, if its more research online into the salient literature/community discourse, or if we want to dive deeper into the claude code binary itself, disassembling it and reverse engineering how it actually thinks about these concepts internally';

describe("mt#4969 — depth-request widening", () => {
  test("matches the measured prompts, through the entry each was calibrated from", () => {
    expect(detectDepthRequest([DIVE_DEEPER_PROMPT]).matched).toBe(true);
    expect(detectDepthRequest([DIVE_DEEPER_PROMPT]).matchedPattern).toBe(DIVE_DEEPER_PATTERN_NAME);
    expect(detectDepthRequest([TELL_ME_MORE_PROMPT]).matched).toBe(true);
    expect(detectDepthRequest([TELL_ME_MORE_PROMPT]).matchedPattern).toBe(
      TELL_ME_MORE_PATTERN_NAME
    );
  });

  // AT4's near-miss half, and the load-bearing one: a REAL injected record
  // from the same window rather than a constructed counter-example. If this
  // ever goes true, the window's newly-suppressed count is 4 and AT1 fails.
  test("does not reach the hypothetical-target near-miss", () => {
    expect(detectDepthRequest([HYPOTHETICAL_TARGET_PROMPT]).matched).toBe(false);
  });

  // The neighborhood the two entries deliberately do NOT reach. Pinning these
  // as non-matching is what keeps a later edit from generalizing
  // `lets-dive-deeper` into any mention of depth, or `tell-me-more` into any
  // request to be told something.
  test("does not reach adjacent unmeasured phrasings", () => {
    expect(detectDepthRequest(["there's a deeper problem here"]).matched).toBe(false);
    expect(detectDepthRequest(["we could dive deeper if that turns out to matter"]).matched).toBe(
      false
    );
    expect(detectDepthRequest(["tell me when the deploy finishes"]).matched).toBe(false);
    expect(detectDepthRequest(["tell me what you think"]).matched).toBe(false);
  });

  // PR #3699 R1 BLOCKING — a NEGATED "tell me more" is a request for LESS.
  // Matching it would suppress the reminder exactly when the principal asked
  // for brevity, inverting the entry and violating SC5. `tell-me-more` is
  // anchored to an imperative position, which makes it immune to every negator
  // by construction rather than to an enumerated list of them — so these cases
  // pin the PROPERTY, and a future switch to a lookbehind that misses one of
  // them fails here.
  test("tell-me-more does not match negated brevity requests", () => {
    for (const negated of [
      "don't tell me more",
      "don’t tell me more", // curly apostrophe — the form macOS substitutes
      "do not tell me more about it",
      "please do not tell me more",
      "no need to tell me more",
      "never tell me more than i asked for",
      "rather than tell me more, just do it",
      "instead of telling me more, summarize",
    ]) {
      expect(detectDepthRequest([negated]).matched).toBe(false);
    }
  });

  // The imperative anchor's positive half: the measured record opens the
  // prompt, and a request opening a later sentence or paragraph also counts.
  test("tell-me-more matches an imperative position, including mid-prompt", () => {
    expect(detectDepthRequest(["Tell me more about the sweep logic"]).matched).toBe(true);
    expect(detectDepthRequest(["That's clear. Tell me more about the gate."]).matched).toBe(true);
    expect(detectDepthRequest(["please tell me more about the gate"]).matched).toBe(true);
    expect(detectDepthRequest(["Looks good.\ntell me more about the second half"]).matched).toBe(
      true
    );
  });

  // `lets-dive-deeper` requires "let's" adjacent to "dive deeper", so a
  // negation cannot sit between them. Asserted rather than claimed in prose:
  // this is the property that makes the entry safe, so it gets a test.
  test("lets-dive-deeper cannot be negated between the hortative and the verb", () => {
    expect(detectDepthRequest(["let's not dive deeper on this"]).matched).toBe(false);
    expect(detectDepthRequest(["we shouldn't dive deeper here"]).matched).toBe(false);
    expect(detectDepthRequest(["no need to dive deeper into that"]).matched).toBe(false);
  });

  // PR #3699 R1 spec-verification marked AT2/AT3/SC5 "Unverifiable" because
  // their evidence was a script the review cannot execute. These pin the same
  // three classes as unit assertions, using verbatim window prompts, so the
  // criteria are checkable without the runtime calibration log. They do NOT
  // replace the replay (which measures the real COUNTS over the window); they
  // make the direction of each class checkable in-repo.
  test("leaves the classes this task must not silence unmatched", () => {
    // AT2 — bare go-aheads, verbatim from the window.
    for (const goAhead of ["Proceed.", "proceed", ".", "Let's keep going", "Proceed"]) {
      expect(detectDepthRequest([goAhead]).matched).toBe(false);
    }
    // AT3 — the handoff class, this task's explicit non-goal.
    for (const handoff of ["handoff mt#4825", "Handoff.", "handoff mem#1340", "handoff d8b9d5f8"]) {
      expect(detectDepthRequest([handoff]).matched).toBe(false);
    }
    // SC5 — requests for BREVITY must never be read as requests for depth.
    for (const brevity of [
      "Summarize this all for me more concisely and Contextualized",
      "present them to me concisely",
      "a concise, very punchy, high-level overview",
      "higher level, what were we doing and why",
    ]) {
      expect(detectDepthRequest([brevity]).matched).toBe(false);
    }
  });
});
