// Tests for the terminal-actionables-block locator (mt#4807).
//
// Every POSITIVE fixture below is verbatim from this project's transcript store,
// with the conversation id and turn index named. That matters more than usual
// here: the whole reason this module exists is that the contract's *described*
// marker ("rule + heading") and the marker agents *write* are not the same, so a
// fixture invented to match the regex would test the regex against itself.

import { describe, test, expect } from "bun:test";
import { locateActionablesBlock } from "./actionables-block";

/** `e5958d64` t110, 2026-08-30 — `---` + `### Actionables`. The described form. */
const HEADING_BLOCK = `Done. No ADR names mt#4742, so the stale-reference advisories were all heuristic title-token matches.

---

### Actionables

- **mt#4782** — the recurring consumer. mt#4742 closed the backlog, not the loop.
- **mt#4778** — the stranded findings.
- Unowned: the analyzer produced **no answer on 93 of 785 runs (11.8%)** and nobody has read that field.`;

/** `c55e7ebf` t300, 2026-08-31 — `---` + `**Actionables**`, a bold run, not a heading. */
const BOLD_LINE_BLOCK = `mt#4767 is merged and deployed.

---

**Actionables**

- mt#4787 is the last open child of mt#4760 — small, a percentage that renders backwards.
- Screenshots are above and in the PR; whether the layout reads well is your call, not something I've asserted.`;

/** `agent-a461b5d7` t111, 2026-08-31 — inline label, no rule and no heading at all. */
const INLINE_LABEL_BLOCK = `**What's next:** PR #3506 is APPROVED, 22/22 checks green.

**Terminal actionables:** merge PR #3506 for mt#4794; post-merge, the PR body's "Deploy verification" section commits to re-checking the tray daemon's rebuilt \`dist/\` against live data.`;

/** `e461ddb2` t296, 2026-08-30T17:41:36Z — the originating turn this task was filed on. */
const ORIGINATING_BLOCK = `Everything is recorded on mt#4678, including the PR sequence.

---

### Actionables

- **One yes needed before PR 1:** a hashed JSON payload at a stable URL is a de facto dataset release of your *editorial* layer (all-rights-reserved; the code is MIT). Smaller than the doc implies — the raw tweets are already on the Community Archive's public API — but it should be a deliberate yes.
- **PR 1 needs a peezombie-rooted window**, same \`session_start\` blocker as before (mt#4758). I can't create that session from here.
- **Flagged, not actioned:** removing the inlined \`index.html\` still leaves ~8.5 MB of corpus in git *history*. Purging that is a separate rewrite and your call.`;

describe("marker forms — all three measured shapes are located", () => {
  test("heading form, preceded by a rule", () => {
    const block = locateActionablesBlock(HEADING_BLOCK);
    expect(block?.markerForm).toBe("heading");
    expect(block?.precededByRule).toBe(true);
    expect(block?.units).toHaveLength(3);
    expect(block?.units[0]?.text).toStartWith("- **mt#4782**");
    expect(block?.units[2]?.text).toContain("11.8%");
  });

  test("bold-line form — a bold run standing in for a heading", () => {
    const block = locateActionablesBlock(BOLD_LINE_BLOCK);
    expect(block?.markerForm).toBe("bold-line");
    expect(block?.precededByRule).toBe(true);
    expect(block?.units).toHaveLength(2);
  });

  test("inline-label form — no rule, no heading, one unit", () => {
    // This is the half of the corpus a "rule + heading" locator cannot see, and
    // the reason this module does not key on the contract's own wording.
    const block = locateActionablesBlock(INLINE_LABEL_BLOCK);
    expect(block?.markerForm).toBe("inline-label");
    expect(block?.precededByRule).toBe(false);
    expect(block?.units).toHaveLength(1);
    expect(block?.units[0]?.text).toStartWith("merge PR #3506 for mt#4794");
  });

  test("the originating turn splits into its three bullets", () => {
    const block = locateActionablesBlock(ORIGINATING_BLOCK);
    expect(block?.markerForm).toBe("heading");
    expect(block?.units).toHaveLength(3);
    expect(block?.units[0]?.text).toContain("One yes needed before PR 1");
    expect(block?.units[0]?.text).toContain("it should be a deliberate yes");
    // Bullet 3 is a SEPARATE unit from bullet 1. It has to be: both are
    // decision-shaped, and a consumer that scored the block as one blob could
    // not say which bullet carried the decision.
    expect(block?.units[2]?.text).toContain("Purging that is a separate rewrite");
  });
});

describe("units carry ORIGINAL text at ORIGINAL offsets", () => {
  test("a unit's index slices its own text back out of the input", () => {
    const block = locateActionablesBlock(ORIGINATING_BLOCK);
    for (const unit of block?.units ?? []) {
      expect(ORIGINATING_BLOCK.slice(unit.index, unit.index + unit.text.length)).toBe(unit.text);
    }
  });

  test("a unit containing a code span keeps the span, not the elision filler", () => {
    // Matching runs on the elided residual; slicing must not. Bullet 2 of the
    // originating block carries `session_start` in backticks.
    const block = locateActionablesBlock(ORIGINATING_BLOCK);
    expect(block?.units[1]?.text).toContain("`session_start`");
  });
});

describe("NEGATIVE CONTROLS — the false-positive axis", () => {
  test("a block quoted inside a fence is not a block", () => {
    // How this corpus discusses itself. Without the elision pass, every message
    // about this task would read as having an actionables block.
    const text = `Here is what the shape looks like:

\`\`\`markdown
### Actionables

- merge PR #1
\`\`\``;
    expect(locateActionablesBlock(text)).toBeNull();
  });

  test("a block quoted in a blockquote is not a block", () => {
    const text = `The rule's example reads:

> ### Actionables
>
> - merge PR #1`;
    expect(locateActionablesBlock(text)).toBeNull();
  });

  test("a mid-message heading followed by prose is not TERMINAL", () => {
    const text = `### Actionables

- merge PR #1

Anyway, the deeper problem is elsewhere, and I want to explain why before stopping.`;
    expect(locateActionablesBlock(text)).toBeNull();
  });

  test("a message with no marker at all", () => {
    expect(locateActionablesBlock("Merged and deployed. Nothing outstanding.")).toBeNull();
  });

  test("a marker with an empty body", () => {
    expect(locateActionablesBlock("Done.\n\n---\n\n### Actionables\n\n")).toBeNull();
  });

  test("empty input", () => {
    expect(locateActionablesBlock("")).toBeNull();
  });
});

describe("structure", () => {
  test("the LAST marker wins when a message carries two", () => {
    const text = `### Actionables

- an earlier list that is not the closing block

Some prose in between that makes the first one non-terminal.

---

### Actionables

- the real one`;
    const block = locateActionablesBlock(text);
    expect(block?.units).toHaveLength(1);
    expect(block?.units[0]?.text).toBe("- the real one");
  });

  test("sub-bullets stay with their parent unit", () => {
    const text = `---

### Actionables

- parent one
  - child a
  - child b
- parent two`;
    const block = locateActionablesBlock(text);
    expect(block?.units).toHaveLength(2);
    expect(block?.units[0]?.text).toContain("child b");
  });

  test("a headed block with prose and no list is one unit", () => {
    const text = `---

### Actionables

Nothing is blocked; the remaining item is the tray rebuild.`;
    const block = locateActionablesBlock(text);
    expect(block?.units).toHaveLength(1);
    expect(block?.units[0]?.text).toStartWith("Nothing is blocked");
  });

  test("a heading with no preceding rule still matches, and reports so", () => {
    const text = `### Actionables

- merge PR #1`;
    const block = locateActionablesBlock(text);
    expect(block?.markerForm).toBe("heading");
    expect(block?.precededByRule).toBe(false);
  });

  test("the `Terminal actionables` spelling matches in headed form too", () => {
    const text = `---

## Terminal actionables

- merge PR #1`;
    expect(locateActionablesBlock(text)?.markerForm).toBe("heading");
  });
});
