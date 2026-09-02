/**
 * mt#4181 — deterministic marker resolution for `tasks_spec_patch`.
 *
 * The defect these cover: `applyEditPattern` sends the whole document to a fast-apply model, and
 * past ~500 lines the model returns a fraction of it, so the mt#3674 collapse guard refuses and
 * there is no append path at all. The fixtures below are sized from the REAL reproductions
 * recorded on mt#4181 (525, 584, 588, 1172, 2246 lines) rather than from round numbers, so a
 * regression shows up at the sizes it actually shipped at.
 *
 * Two properties matter more than any individual case and are asserted throughout:
 *   1. a resolved splice retains every original line, in order;
 *   2. anything ambiguous refuses, so the caller falls back to the model rather than guessing.
 */

import { describe, test, expect } from "bun:test";
import {
  resolveMarkerMergeDeterministically,
  retainsAllLinesInOrder,
  detectSuspiciousCollapse,
  EXISTING_CODE_MARKER,
} from "./edit-pattern-utils";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A spec-shaped document of EXACTLY `targetLines` content lines. Every line is unique, which is
 * what makes any of them usable as an anchor — the property real spec headings have, and the one
 * the resolver's uniqueness requirement is about.
 */
function buildSpec(targetLines: number): string {
  const out: string[] = ["# Task spec", ""];
  let section = 1;
  while (out.length < targetLines) {
    if (out.length < targetLines) out.push(`## Section ${section}`);
    if (out.length < targetLines) out.push("");
    for (let l = 1; l <= 8 && out.length < targetLines; l++) {
      out.push(`Section ${section} body line ${l}.`);
    }
    if (out.length < targetLines) out.push("");
    section++;
  }
  // A trailing blank would be stripped by the line count, leaving the fixture one line short.
  if (out[out.length - 1] === "") out[out.length - 1] = "Closing line.";
  return `${out.join("\n")}\n`;
}

function contentLines(text: string): string[] {
  return text.replace(/\n+$/, "").split("\n");
}

function lineCount(text: string): number {
  return contentLines(text).length;
}

/** Two ADJACENT lines of the original, for use as the head/tail anchors of a segment. */
function adjacentAnchors(spec: string, index: number): { head: string; tail: string } {
  const lines = contentLines(spec);
  const head = lines[index];
  const tail = lines[index + 1];
  if (head === undefined || tail === undefined) {
    throw new Error(`fixture has no adjacent pair at index ${index}`);
  }
  return { head, tail };
}

const NEW_SECTION_HEADING = "## Recurrence 2026-09-02";

const NEW_SECTION = [
  NEW_SECTION_HEADING,
  "",
  ...Array.from({ length: 20 }, (_, i) => `Recurrence detail line ${i + 1}.`),
  "",
  "Recorded at the anchor rather than in a per-surface memory.",
].join("\n");

function expectRetainsOriginal(original: string, merged: string): void {
  expect(retainsAllLinesInOrder(contentLines(original), contentLines(merged))).toBe(true);
}

// ---------------------------------------------------------------------------
// AT1 / AT3 — the recorded reproductions
// ---------------------------------------------------------------------------

describe("AT1 — appending a section to a 588-line spec", () => {
  const original = buildSpec(588); // the mt#2544 size in the spec's third row
  const edit = `${EXISTING_CODE_MARKER}\n\n${NEW_SECTION}\n`;

  test("the fixture is exactly the recorded reproduction size", () => {
    expect(lineCount(original)).toBe(588);
  });

  test("resolves, and retains every original line in order plus the addition", () => {
    const result = resolveMarkerMergeDeterministically(original, edit);
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;

    expectRetainsOriginal(original, result.merged);
    expect(result.merged).toContain(NEW_SECTION_HEADING);
    expect(result.merged).toContain("Recurrence detail line 20.");
    expect(result.shapes).toEqual(["append"]);
  });

  test("the collapse guard does not fire on the spliced result", () => {
    // Criterion 2's other half: the guard is not weakened, it simply has nothing to catch here,
    // because a splice grows the document instead of shrinking it.
    const result = resolveMarkerMergeDeterministically(original, edit);
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expect(detectSuspiciousCollapse(original, result.merged)).toBeNull();
  });
});

describe("AT3 — the reproductions recorded in the spec", () => {
  test("mt#3861 at 525 lines: leading marker, ~45-line payload", () => {
    const original = buildSpec(525);
    const payload = Array.from({ length: 45 }, (_, i) => `Appended line ${i + 1}.`).join("\n");
    const result = resolveMarkerMergeDeterministically(
      original,
      `${EXISTING_CODE_MARKER}\n\n${payload}\n`
    );
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expectRetainsOriginal(original, result.merged);
    expect(result.merged).toContain("Appended line 45.");
  });

  test("mt#4368 at 584 lines: the confirmed-failure size from 2026-09-02", () => {
    const original = buildSpec(584);
    const result = resolveMarkerMergeDeterministically(
      original,
      `${EXISTING_CODE_MARKER}\n\n${NEW_SECTION}\n`
    );
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expectRetainsOriginal(original, result.merged);
  });

  test("mt#2544 at 588 lines: anchored on unique lines, markers on BOTH sides", () => {
    // The shape the spec records as having collapsed 588 -> 86 despite being exactly the shape
    // the tool's own description prescribes.
    const original = buildSpec(588);
    const { head, tail } = adjacentAnchors(original, 400);
    const edit = [
      EXISTING_CODE_MARKER,
      "",
      head,
      "",
      NEW_SECTION,
      "",
      tail,
      "",
      EXISTING_CODE_MARKER,
    ].join("\n");

    const result = resolveMarkerMergeDeterministically(original, edit);
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expectRetainsOriginal(original, result.merged);
    expect(result.shapes).toEqual(["anchored"]);
    expect(result.merged).toContain(NEW_SECTION_HEADING);
  });

  test("mt#2544 at 2,246 lines: the size it had reached by 2026-09-01", () => {
    const original = buildSpec(2246);
    expect(lineCount(original)).toBe(2246);
    const result = resolveMarkerMergeDeterministically(
      original,
      `${EXISTING_CODE_MARKER}\n\n${NEW_SECTION}\n`
    );
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expectRetainsOriginal(original, result.merged);
    expect(lineCount(result.merged)).toBeGreaterThan(2246);
  });

  test("byte-identical survival: the original is a verbatim PREFIX of the append result", () => {
    // mt#4853's suggested assertion, lifted per this spec's note. Stronger than the ordered-subset
    // check: for an append specifically, nothing before the addition may have moved at all.
    const original = buildSpec(2246);
    const result = resolveMarkerMergeDeterministically(
      original,
      `${EXISTING_CODE_MARKER}\n\n${NEW_SECTION}\n`
    );
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expect(result.merged.startsWith(original.replace(/\n+$/, ""))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AT2 — the collapse guard is not weakened
// ---------------------------------------------------------------------------

describe("AT2 — the mt#3674 collapse guard still refuses a genuine collapse", () => {
  test("a model result a fraction of the original is still detected", () => {
    // The negative control for criterion 2: this is the mt#4181 failure signature itself
    // (2130 -> 63 lines). The deterministic path must not have made the guard blind to it.
    const original = buildSpec(588);
    const collapsed = "## Section 48\n\nSection 48 body line 8.\n";
    const detected = detectSuspiciousCollapse(original, collapsed);
    expect(detected).not.toBeNull();
    expect(detected?.originalLines).toBe(588);
    expect(detected?.finalLines).toBe(3);
  });

  test("the guard's short-document floor is untouched", () => {
    expect(detectSuspiciousCollapse("a\nb\nc\n", "a\n")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Refusals — ambiguity must fall back, never guess
// ---------------------------------------------------------------------------

describe("ambiguous patches refuse rather than splice", () => {
  test("an opening anchor that occurs twice refuses", () => {
    const original = ["## A", "shared line", "## B", "shared line", "## C"].join("\n");
    const edit = [
      EXISTING_CODE_MARKER,
      "shared line",
      "new text",
      "## C",
      EXISTING_CODE_MARKER,
    ].join("\n");
    const result = resolveMarkerMergeDeterministically(original, edit);
    expect(result.resolved).toBe(false);
    if (result.resolved) return;
    expect(result.reason).toContain("2 times");
  });

  test("a content segment in the middle with no anchor refuses", () => {
    const original = buildSpec(120);
    const edit = [
      EXISTING_CODE_MARKER,
      "content that exists nowhere in the original",
      EXISTING_CODE_MARKER,
      "## Section 3",
      EXISTING_CODE_MARKER,
    ].join("\n");
    const result = resolveMarkerMergeDeterministically(original, edit);
    expect(result.resolved).toBe(false);
  });

  test("a marker-less patch refuses, leaving the mt#2400 fail-closed guard to handle it", () => {
    const result = resolveMarkerMergeDeterministically(buildSpec(120), "wholesale replacement");
    expect(result.resolved).toBe(false);
    if (result.resolved) return;
    expect(result.reason).toContain("no existing-code marker");
  });

  test("a DELETION falls back to the model rather than being spliced", () => {
    // The retention post-condition's whole job. Deleting is a legitimate edit, but it is not a
    // shape this resolver can prove safe, so it must go to the model — today's behaviour.
    const original = buildSpec(120);
    // Anchors that bracket a span whose interior the segment does not reproduce.
    const { head: near } = adjacentAnchors(original, 10);
    const { head: far } = adjacentAnchors(original, 20);
    const edit = [EXISTING_CODE_MARKER, near, far, EXISTING_CODE_MARKER].join("\n");
    const result = resolveMarkerMergeDeterministically(original, edit);
    expect(result.resolved).toBe(false);
    if (result.resolved) return;
    expect(result.reason).toContain("retain every original line");
  });
});

describe("retainsAllLinesInOrder", () => {
  test("accepts an insertion and rejects a dropped line", () => {
    expect(retainsAllLinesInOrder(["a", "b", "c"], ["a", "new", "b", "c"])).toBe(true);
    expect(retainsAllLinesInOrder(["a", "b", "c"], ["a", "c"])).toBe(false);
  });

  test("rejects reordering — order is part of the guarantee", () => {
    expect(retainsAllLinesInOrder(["a", "b", "c"], ["c", "b", "a"])).toBe(false);
  });

  test("ignores trailing whitespace only, never leading indentation", () => {
    expect(retainsAllLinesInOrder(["  indented"], ["  indented   "])).toBe(true);
    expect(retainsAllLinesInOrder(["  indented"], ["indented"])).toBe(false);
  });
});

describe("shape coverage", () => {
  test("prepend: content before a lone trailing marker", () => {
    const original = buildSpec(120);
    const result = resolveMarkerMergeDeterministically(
      original,
      `> **BANNER — read this first.**\n\n${EXISTING_CODE_MARKER}\n`
    );
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expect(result.shapes).toEqual(["prepend"]);
    expect(result.merged.startsWith("> **BANNER — read this first.**")).toBe(true);
    expectRetainsOriginal(original, result.merged);
  });

  test("two regions in one patch: an anchored insert plus a trailing append", () => {
    // The shape a real planning pass produces when it amends one section and appends another.
    const original = buildSpec(200);
    const { head, tail } = adjacentAnchors(original, 60);
    const edit = [
      EXISTING_CODE_MARKER,
      head,
      "",
      "An inserted note.",
      "",
      tail,
      EXISTING_CODE_MARKER,
      "",
      NEW_SECTION,
    ].join("\n");
    const result = resolveMarkerMergeDeterministically(original, edit);
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expect(result.shapes).toEqual(["anchored", "append"]);
    expect(result.merged).toContain("An inserted note.");
    expect(result.merged).toContain(NEW_SECTION_HEADING);
    expectRetainsOriginal(original, result.merged);
  });

  test("preserves the original's trailing-newline state", () => {
    const withNewline = buildSpec(120);
    const withoutNewline = withNewline.replace(/\n+$/, "");
    const edit = `${EXISTING_CODE_MARKER}\n\nappended.\n`;

    const a = resolveMarkerMergeDeterministically(withNewline, edit);
    const b = resolveMarkerMergeDeterministically(withoutNewline, edit);
    expect(a.resolved && a.merged.endsWith("\n")).toBe(true);
    expect(b.resolved && b.merged.endsWith("\n")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PR #3580 R1 — boundary fidelity
// ---------------------------------------------------------------------------

describe("boundary fidelity (PR #3580 R1)", () => {
  // A spec has no version history, so a blank line or a line ending silently changed by the
  // splice is unrecoverable. The first revision stripped blank edges off the ORIGINAL and then
  // ran the retention check against that stripped array — so the post-condition could not see its
  // own damage. These pin both halves.

  test("leading blank lines of the original survive", () => {
    const original = "\n\n# Title\n\nbody line\n";
    const result = resolveMarkerMergeDeterministically(
      original,
      `${EXISTING_CODE_MARKER}\n\nnew section\n`
    );
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expect(result.merged.startsWith("\n\n# Title")).toBe(true);
    expect(result.merged).toBe("\n\n# Title\n\nbody line\n\nnew section\n");
  });

  test("trailing blank lines of the original survive", () => {
    const original = "# Title\n\nbody line\n\n\n";
    const result = resolveMarkerMergeDeterministically(
      original,
      `${EXISTING_CODE_MARKER}\n\nnew section\n`
    );
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    // The two genuine trailing blanks are kept; only the terminator's artifact is dropped, and
    // the separator is not doubled because a blank already ends the document.
    expect(result.merged).toBe("# Title\n\nbody line\n\n\nnew section\n");
  });

  test("a CRLF document stays CRLF throughout, including inserted lines", () => {
    const original = "# Title\r\n\r\nbody line\r\n";
    const result = resolveMarkerMergeDeterministically(
      original,
      `${EXISTING_CODE_MARKER}\n\nnew section\n`
    );
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expect(result.merged).toBe("# Title\r\n\r\nbody line\r\n\r\nnew section\r\n");
    expect(/[^\r]\n/.test(result.merged)).toBe(false);
  });

  test("an LF document is not given CRLF endings", () => {
    const original = "# Title\nbody line\n";
    const result = resolveMarkerMergeDeterministically(
      original,
      `${EXISTING_CODE_MARKER}\n\nnew section\n`
    );
    expect(result.resolved && result.merged.includes("\r")).toBe(false);
  });

  test("a document with no trailing newline does not gain one", () => {
    const result = resolveMarkerMergeDeterministically(
      "# Title\nbody line",
      `${EXISTING_CODE_MARKER}\n\nnew section\n`
    );
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expect(result.merged.endsWith("new section")).toBe(true);
  });

  test("the retention check now sees boundary blanks, because it runs on the FULL original", () => {
    // The hole in the first revision: blanks were stripped before the check, so losing them was
    // invisible to it. Asserted directly on the exported predicate.
    expect(retainsAllLinesInOrder(["", "", "# Title"], ["# Title"])).toBe(false);
    expect(retainsAllLinesInOrder(["", "", "# Title"], ["", "", "# Title", "added"])).toBe(true);
  });

  test("a patch of markers and blanks only refuses instead of rewriting the original", () => {
    const result = resolveMarkerMergeDeterministically(
      "# Title\nbody\n",
      `${EXISTING_CODE_MARKER}\n\n${EXISTING_CODE_MARKER}\n`
    );
    expect(result.resolved).toBe(false);
    if (result.resolved) return;
    expect(result.reason).toContain("no content to apply");
  });
});
