/**
 * mt#5044 — tests for the title/`## Summary` overlap measure.
 *
 * The headline fixture is not synthetic. mt#5042 was created with a title about one subject over
 * a spec about another, and corrected minutes later by `tasks_edit`; both titles below are
 * verbatim from that tool call's recorded `previousValues`, and the Summary excerpt is verbatim
 * from mt#5042's spec. That makes the pair a REAL positive and its correction a REAL negative
 * control over the SAME spec text — the strongest available shape, since the only variable
 * between the two assertions is the title.
 */
import { describe, it, expect } from "bun:test";

import { MT5042_CORRECT_TITLE, MT5042_WRONG_TITLE } from "./mt5042-fixture";
import { contentTokens, extractSummary, overlapReport } from "./title-summary-overlap";

/** Verbatim excerpt of mt#5042's `## Summary` — its three substantive paragraphs. */
const MT5042_SUMMARY = `Auto-compaction fires when the context window fills. That is a resource trigger, and it has two
costs that a work-boundary trigger would not have.

**It fires at the point of maximum re-upload.** Per \`docs/context-bandwidth.md\`, a result emitted at
request *i* of an *N*-request session is re-sent (N - i) times. Everything read before the
compaction was therefore re-transmitted on every request up to the moment it fired. Compacting at
the ceiling means paying the entire tail before getting any relief; compacting earlier is strictly
cheaper as well as less lossy.

**It fires mid-narrative.** Heap exhaustion is a fine GC trigger because objects have no narrative.
A conversation does. A compaction that lands mid-action must summarize a hypothesis stack it is
still inside; one that lands after a merge is summarizing residue whose conclusions are already in
git, the PR, and the task record.

Proposed shape: at each **work boundary** (a merge, a task closeout, a PR landing), if context is
past a threshold, write the handoff work package and end the conversation. Auto-compaction stays as
the floor for when no boundary arrives in time.`;

describe("extractSummary", () => {
  it("returns the body of a `## Summary` section", () => {
    const spec = "## Summary\n\nThe body.\n\n## Scope\n\nNot the body.";
    expect(extractSummary(spec)).toBe("The body.");
  });

  it("returns null when the spec has no Summary — AT4's no-crash case", () => {
    const spec = "## Scope\n\nIn scope: things.\n\n## Context\n\nBackground.";
    expect(extractSummary(spec)).toBeNull();
  });

  it("returns null rather than throwing on empty or non-string input", () => {
    expect(extractSummary("")).toBeNull();
    expect(extractSummary("   \n  ")).toBeNull();
    expect(extractSummary(undefined as unknown as string)).toBeNull();
  });

  it("distinguishes an ABSENT Summary from an EMPTY one", () => {
    // The denominator depends on this: an empty Summary is a real member scoring zero,
    // an absent one is outside the population entirely.
    expect(extractSummary("## Summary\n\n## Scope\n\nx")).toBe("");
    expect(extractSummary("## Scope\n\nx")).toBeNull();
  });

  it("does not let a `## ` line inside a fenced block truncate the section", () => {
    const spec = [
      "## Summary",
      "",
      "Real prose.",
      "",
      "```md",
      "## Not A Heading",
      "```",
      "",
      "More real prose.",
      "",
      "## Scope",
      "",
      "elsewhere",
    ].join("\n");
    const summary = extractSummary(spec);
    expect(summary).toContain("More real prose.");
    expect(summary).not.toContain("elsewhere");
  });

  it("does not match a deeper heading or a RENAMED one", () => {
    // A loose match would pull a different section's prose into the comparison — the one
    // error that corrupts the measurement without looking wrong.
    expect(extractSummary("### Summary\n\nbody")).toBeNull();
    expect(extractSummary("## Summary of changes\n\nbody")).toBeNull();
  });

  it("DOES match a parenthetically annotated heading — 5 real specs carry one", () => {
    // Measured, not assumed: counting excluded specs with a decorated heading found 5 of 4,915,
    // every one a real Summary annotated in place. See the docblock (PR #3691 R1).
    expect(extractSummary("## Summary (umbrella)\n\nbody")).toBe("body");
    expect(extractSummary("## Summary (re-scoped 2026-04-28)\n\nbody")).toBe("body");
    expect(extractSummary("## Summary (original diagnosis — REFUTED 2026-07-20)\n\nbody")).toBe(
      "body"
    );
  });

  it("is case-insensitive and tolerates a trailing colon", () => {
    expect(extractSummary("## summary\n\nbody")).toBe("body");
    expect(extractSummary("## Summary:\n\nbody")).toBe("body");
  });
});

describe("contentTokens", () => {
  it("drops stopwords and short words but keeps short identifiers", () => {
    const tokens = contentTokens("the spec of mt#5042 is in db with that");
    expect(tokens.has("spec")).toBe(true);
    expect(tokens.has("mt#5042")).toBe(true);
    expect(tokens.has("that")).toBe(false);
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("of")).toBe(false);
  });

  it("unifies a simple plural with its singular", () => {
    expect(contentTokens("steps").has("step")).toBe(true);
    expect(contentTokens("step").has("step")).toBe(true);
  });

  it("does not strip an `ss` ending into a non-word", () => {
    expect(contentTokens("class process").has("class")).toBe(true);
    expect(contentTokens("class process").has("proces")).toBe(false);
  });

  it("reads an identifier out of inline code rather than discarding it", () => {
    expect(contentTokens("calls `tasks_create` directly").has("tasks_create")).toBe(true);
  });

  it("drops bare numbers, which carry no subject information", () => {
    expect(contentTokens("about 136079 bytes").has("136079")).toBe(false);
  });
});

describe("overlapReport — the mt#5042 pair", () => {
  it("scores the WRONG title low against the spec it was filed over", () => {
    const report = overlapReport(MT5042_WRONG_TITLE, MT5042_SUMMARY);
    // The two texts share essentially one noun ("compaction") out of a dozen title words.
    expect(report.coverage).toBeLessThan(0.3);
    expect(report.missingTokens).toContain("debugging");
    expect(report.missingTokens).toContain("successor");
  });

  it("scores the CORRECTED title high against the same spec — the negative control", () => {
    const report = overlapReport(MT5042_CORRECT_TITLE, MT5042_SUMMARY);
    expect(report.coverage).toBeGreaterThan(0.6);
    expect(report.sharedTokens).toContain("compaction");
    expect(report.sharedTokens).toContain("boundary");
  });

  it("separates the two by a wide margin — the discriminating property", () => {
    // If this margin were narrow the measure would be reporting register rather than subject,
    // which is the failure mode a symmetric similarity measure has on this data.
    const wrong = overlapReport(MT5042_WRONG_TITLE, MT5042_SUMMARY).coverage;
    const right = overlapReport(MT5042_CORRECT_TITLE, MT5042_SUMMARY).coverage;
    expect(right - wrong).toBeGreaterThan(0.4);
  });
});

describe("overlapReport — degenerate and boundary inputs", () => {
  it("treats a title with no content tokens as vacuously agreeing, not maximally disagreeing", () => {
    expect(overlapReport("a of the", "anything at all").coverage).toBe(1);
  });

  it("scores a title fully contained in its summary at 1", () => {
    expect(overlapReport("widget rendering", "The widget rendering path is slow.").coverage).toBe(
      1
    );
  });

  it("reports the exact-match coverage alongside the normalized one", () => {
    // Sensitivity is surfaced rather than assumed: plural normalization can only raise coverage,
    // so the exact figure is the floor.
    const report = overlapReport("dropped steps", "we dropped a step");
    expect(report.coverageExact).toBeLessThanOrEqual(report.coverage);
  });

  it("does not throw on an empty summary", () => {
    const report = overlapReport("some title words", "");
    expect(report.coverage).toBe(0);
  });
});
