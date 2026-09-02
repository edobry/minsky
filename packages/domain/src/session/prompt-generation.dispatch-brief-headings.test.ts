/**
 * Drift guard for the section headings the cockpit folds inside a dispatch
 * brief (mt#4354).
 *
 * `src/cockpit/web/lib/dispatch-brief.ts` duplicates these three headings as
 * literals because `custom/no-node-import-in-cockpit-web` (mt#3239) bars the
 * browser bundle from importing `@minsky/domain` values. The duplication is
 * forced; letting it rot silently is not.
 *
 * The guard is deliberately on THIS side of the boundary rather than a
 * cross-package import from the web test: a test in `src/cockpit/web/**` that
 * imported these constants would itself violate the rule the duplication
 * exists to satisfy.
 *
 * If this test fails, someone renamed a section heading in the generator. Fix
 * `FOLDED_SECTION_HEADINGS` in the cockpit module to match, then update the
 * literals here — in that order, because the cockpit copy is what actually
 * decides what a reader sees.
 */
import { describe, test, expect } from "bun:test";
import {
  ENVELOPE_HEADER,
  RECOMMENDED_SKILLS_HEADER,
  EMBEDDED_SKILLS_HEADER,
  SESSION_LINE_PREFIX,
  READ_ONLY_DECLARATION,
} from "./prompt-generation";

describe("mt#4354 — dispatch-brief folded-section headings", () => {
  test("the generator's headings still match the cockpit's copy of them", () => {
    // These literals are the contents of `FOLDED_SECTION_HEADINGS` in
    // `src/cockpit/web/lib/dispatch-brief.ts`, verbatim.
    expect(ENVELOPE_HEADER).toBe("## Operating Envelope");
    expect(RECOMMENDED_SKILLS_HEADER).toBe("## Recommended Skills");
    expect(EMBEDDED_SKILLS_HEADER).toBe("## Embedded Skills");
  });

  test("the prose shapes the cockpit PARSES for header facts are unchanged", () => {
    // `extractDispatchBriefFacts` (src/cockpit/web/lib/dispatch-brief.ts) reads
    // the session id, the task id and the read-only declaration out of the
    // generated prompt's PROSE, because the generator emits them as prose and
    // the render path has no structured channel to them.
    //
    // Those three anchors are not exported constants, so this pins them against
    // the generator's SOURCE. Crude, and it is the only thing that actually
    // detects the drift: reword any of these and the cockpit header silently
    // starts omitting a fact, with nothing else failing.
    // These are the literals `extractDispatchBriefFacts` matches, verbatim. The
    // generator now BUILDS its templates from these same constants, so the
    // coupling is declared rather than scraped — an earlier draft read the
    // generator's source text instead, which `custom/no-real-fs-in-tests`
    // correctly rejected and which would have been the weaker guard anyway.
    expect(SESSION_LINE_PREFIX).toBe("You are working in Minsky session");
    expect(READ_ONLY_DECLARATION).toBe("This dispatch is declared **read-only**");
  });

  test("each heading is a full top-level markdown heading", () => {
    // The cockpit matches these against a WHOLE LINE, so a heading that lost
    // its `## ` prefix would silently stop folding rather than fail loudly.
    for (const heading of [ENVELOPE_HEADER, RECOMMENDED_SKILLS_HEADER, EMBEDDED_SKILLS_HEADER]) {
      expect(heading.startsWith("## ")).toBe(true);
      expect(heading.trim()).toBe(heading);
    }
  });
});
