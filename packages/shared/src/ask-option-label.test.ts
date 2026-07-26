/**
 * Tests for the shared ask-option-label rules (mt#3253).
 *
 * Fixtures marked "corpus" are verbatim labels from the live ask corpus
 * (measured 2026-07-26) — the defects this module exists to name, not invented
 * examples. The negative controls matter most: this pattern runs over every
 * label the cockpit renders, so a false positive would silently eat real text.
 */
import { describe, test, expect } from "bun:test";
import {
  OPTION_LABEL_BUDGET,
  hasRedundantOptionLetterPrefix,
  isOverOptionLabelBudget,
  stripOptionLetterPrefix,
} from "./ask-option-label";

/** The worst label in the corpus: 167 chars, a paragraph inside a button. */
const CORPUS_WORST =
  "B — boundary fix + Stop-event ADVISORY guard (recommended): agent self-addresses admissions at turn end; dedup vs prompt-time scanner; first Stop dispatcher entrypoint";

describe("isOverOptionLabelBudget (mt#3253)", () => {
  test("the corpus p50 label length is well under budget", () => {
    expect(isOverOptionLabelBudget("x".repeat(36))).toBe(false);
  });

  test("a label exactly at the budget does not fire", () => {
    expect(isOverOptionLabelBudget("x".repeat(OPTION_LABEL_BUDGET))).toBe(false);
  });

  test("one character over the budget fires", () => {
    expect(isOverOptionLabelBudget("x".repeat(OPTION_LABEL_BUDGET + 1))).toBe(true);
  });

  test("the corpus worst case (167 chars) fires", () => {
    expect(CORPUS_WORST.length).toBe(167);
    expect(isOverOptionLabelBudget(CORPUS_WORST)).toBe(true);
  });

  test("an empty label does not fire (that is a different defect)", () => {
    expect(isOverOptionLabelBudget("")).toBe(false);
  });

  test("the budget sits at the observed p90, not a round number", () => {
    // Corpus p90 is 62; 60 is the nearest value at or below it. Pinned so a
    // later "tidy it to 50/75" edit has to confront the derivation.
    expect(OPTION_LABEL_BUDGET).toBe(60);
  });
});

describe("hasRedundantOptionLetterPrefix — corpus positives (mt#3253)", () => {
  // Named rather than title-sliced so a failure says which FORM broke.
  const prefixed: Array<[form: string, label: string]> = [
    ["bracketed lower", "[a] GitHub Actions migrate-on-merge (recommended)"],
    ["bracketed, long label", "[b] Railway pre-deploy/release command"],
    ["bracketed, short label", "[c] Supabase CLI migration deploy"],
    ["hyphen separator", "A - scope becomes prose; new scopeFiles carries the paths"],
    ["em-dash separator", "A — build standalone, independent"],
    ["colon separator", "A: enroll now — unblock auto-update"],
    ["paren separator, lower", "a) Claude files it via gh with AI attribution"],
    ["period separator", "B. Drop to default"],
    ["the corpus worst case", CORPUS_WORST],
  ];

  for (const [form, label] of prefixed) {
    test(`fires on a ${form} marker`, () => {
      expect(hasRedundantOptionLetterPrefix(label)).toBe(true);
    });
  }
});

describe("hasRedundantOptionLetterPrefix — negative controls (mt#3253)", () => {
  const clean: Array<[why: string, label: string]> = [
    // Corpus labels with em dashes but no letter marker — the case a naive
    // "starts with a letter then an em dash" pattern would eat.
    ["a corpus em-dash label", "Adopt fully — vocabulary + one-pager reframe + essay draft"],
    ["another corpus em-dash label", "Adopt vocabulary only — defer essay/one-pager"],
    ["an apostrophe + em-dash label", "Don't adopt — keep current framing, revisit later"],
    ["a plain label", "Keep bypassPermissions"],
    ["an ALL-CAPS label", "TUNE ask-routing-deferral + KEEP knowledge-acquisition"],
    ["the optionless default", "Approve"],
    ["the quality.review default", "Request changes"],
    ["a single letter with no separator", "A"],
    ["a two-letter token before a separator", "AB — both variants"],
    ["a slash after the letter", "A/B test both variants"],
    // PR #2341 R1, a real finding: a dotted token is not a marker. Without the
    // whitespace guard these stripped to "B test both variants" / "CLI option".
    ["a dotted token (A.B)", "A.B test both variants"],
    ["a dotted token before a word (A.CLI)", "A.CLI option"],
    ["a separator with no space after it", "A -B variant"],
    ["a marker-only label with no trailing space", "A."],
    ["an empty label", ""],
  ];

  for (const [why, label] of clean) {
    test(`does not fire on ${why}`, () => {
      expect(hasRedundantOptionLetterPrefix(label)).toBe(false);
    });
  }
});

describe("stripOptionLetterPrefix (mt#3253)", () => {
  test("strips a bracketed marker", () => {
    expect(stripOptionLetterPrefix("[a] GitHub Actions migrate-on-merge")).toBe(
      "GitHub Actions migrate-on-merge"
    );
  });

  test("strips an em-dash marker", () => {
    expect(stripOptionLetterPrefix("A — build standalone, independent")).toBe(
      "build standalone, independent"
    );
  });

  test("strips a colon marker", () => {
    expect(stripOptionLetterPrefix("A: enroll now — unblock auto-update")).toBe(
      "enroll now — unblock auto-update"
    );
  });

  test("strips a paren marker", () => {
    expect(stripOptionLetterPrefix("a) Full T0 auto-merge, post-hoc review")).toBe(
      "Full T0 auto-merge, post-hoc review"
    );
  });

  test("strips a period marker", () => {
    expect(stripOptionLetterPrefix("B. Drop to default")).toBe("Drop to default");
  });

  test("leaves the rest of the label byte-identical, em dashes included", () => {
    expect(stripOptionLetterPrefix(CORPUS_WORST)).toBe(
      "boundary fix + Stop-event ADVISORY guard (recommended): agent self-addresses admissions at turn end; dedup vs prompt-time scanner; first Stop dispatcher entrypoint"
    );
  });

  test("a label with no marker passes through unchanged", () => {
    const label = "Adopt fully — vocabulary + one-pager reframe";
    expect(stripOptionLetterPrefix(label)).toBe(label);
  });

  test("a marker-only label is left alone rather than emptied", () => {
    // An empty button is worse than a redundant one.
    expect(stripOptionLetterPrefix("[a]")).toBe("[a]");
    expect(stripOptionLetterPrefix("A.")).toBe("A.");
    expect(stripOptionLetterPrefix("A — ")).toBe("A — ");
  });

  test("is idempotent — normalizing twice is normalizing once", () => {
    const once = stripOptionLetterPrefix("[a] GitHub Actions migrate-on-merge");
    expect(stripOptionLetterPrefix(once)).toBe(once);
  });

  test("stripping only ever shortens, never rewrites, the label", () => {
    for (const label of ["[b] Railway pre-deploy/release command", "Approve", CORPUS_WORST]) {
      expect(label.endsWith(stripOptionLetterPrefix(label))).toBe(true);
    }
  });
});
