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
} from "./prompt-generation";

describe("mt#4354 — dispatch-brief folded-section headings", () => {
  test("the generator's headings still match the cockpit's copy of them", () => {
    // These literals are the contents of `FOLDED_SECTION_HEADINGS` in
    // `src/cockpit/web/lib/dispatch-brief.ts`, verbatim.
    expect(ENVELOPE_HEADER).toBe("## Operating Envelope");
    expect(RECOMMENDED_SKILLS_HEADER).toBe("## Recommended Skills");
    expect(EMBEDDED_SKILLS_HEADER).toBe("## Embedded Skills");
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
