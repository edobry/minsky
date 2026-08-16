// mt#3596: the halt-on-a-principal-decision test must be POSITIVE (name the reserved
// category), not a negative enumeration of known-bad rationales.
//
// R5 of the confabulated-strategic-frame family (mem#367) defeated the negative
// enumeration by construction: the halt rationale simply was not on the list, so
// walking the list honestly returned "not a confabulated halt". A list of bad reasons
// cannot close over reasons nobody has thought of yet; a citation into a CLOSED list
// can.
//
// The guidance lives on TWO always-in-context surfaces — the /plan-task skill and the
// key-workflows rule — each with its own compiled outputs. A fix that lands on one
// leaves the other still stating the old test, and a fix that lands on a source but is
// not recompiled leaves every agent reading the old text. So this asserts the
// requirement on every surface an agent actually reads: sources AND generated
// artifacts, following the tests/domain/plan-task-gate-letters.test.ts precedent.
//
// Two distinct guards live here, and they fail for different reasons:
//
//   1. PRESENCE (`describe` #1) — exact substrings, on every surface. Deliberately
//      brittle, for the same reason the gate-letter manifest is: these three strings
//      ARE the policy, not incidental prose around it, and a reviewer-invisible
//      reword of "NAME which reserved category" into something softer is exactly the
//      regression worth failing on. Rewording the policy should require touching this
//      file, which puts the change in front of a human. (PR #2616 R1 flagged the
//      brittleness; it is intentional and scoped to the policy phrases only — nothing
//      here asserts the surrounding explanatory prose.)
//   2. DRIFT (`describe` #2) — derived, not hardcoded. The reserved categories are
//      read out of the canonical rule at run time and checked against each surface's
//      restatement, so adding a seventh category canonically fails until the copies
//      catch up. This is the answer to "the list is hand-copied in two places": the
//      copies are still copies, but they can no longer silently diverge.

/* eslint-disable custom/no-real-fs-in-tests -- this test's PURPOSE is to verify the
   generated artifacts on disk carry the same requirement as their sources, so it must
   read the real files. */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import planTaskSkill from "../../.minsky/skills/plan-task/skill.ts";

const REPO_ROOT = join(import.meta.dir, "../..");

const read = (relPath: string): string => readFileSync(join(REPO_ROOT, relPath), "utf8") as string;

// Named because each is referenced from both the presence guard and the drift guard
// below, and a typo'd path would silently read a different file.
const SKILL_SOURCE = ".minsky/skills/plan-task/skill.ts";
const RULE_SOURCE = ".minsky/rules/key-workflows.mdc";

// mt#4141: the THIRD surface carrying the citation test, added after R7 of the
// confabulated-strategic-frame family. The two surfaces above are both scoped to a
// skill-chain transition ("override the chain-walk default at any transition"), so a
// turn-end deferral outside any chain reached the principal with the test never applied.
// /classify-before-deferring owns the whether-question generally — /escalation-packaging
// §Related delegates it there explicitly — and its Class C copy had drifted to six
// categories against the canonical seven, precisely because nothing here covered it.
const CLASSIFY_SOURCE = ".minsky/skills/classify-before-deferring/SKILL.md";
const CLASSIFY_GENERATED = ".claude/skills/classify-before-deferring/SKILL.md";
// Opens the restatement window on both classify surfaces AND on the plan-task skill —
// they deliberately share the phrase, so the drift guard reads the same construction
// everywhere it appears.
const CLOSED_LIST_MARKER = "The closed list:";

// The positive test itself: a halt must NAME the category.
const CITATION_MARKER = "NAME which reserved category";
// The closed list it must cite, by name — an uncited "name the category" is not a test.
const SOURCE_MARKER = "principal-context.mdc §Decisions Eugene reserves";
// The old negative enumeration is KEPT as illustration, but must not read as the test.
const DEMOTION_MARKER = "illustrative, NOT the test";

// Every surface an agent reads the halt conditions from. The skill source is asserted
// separately (it is a TS module, not a file read); these are the rule source plus the
// four generated artifacts — a source-only assertion passes on a stale compile.
const SURFACES = [
  RULE_SOURCE,
  ".claude/skills/plan-task/SKILL.md",
  "CLAUDE.md",
  "AGENTS.md",
  ".cursor/rules/key-workflows.mdc",
];

describe("halt-on-principal-decision requires naming the reserved category (mt#3596)", () => {
  test("the plan-task skill SOURCE states the positive citation test", () => {
    const content = planTaskSkill.content as string;
    expect(content).toContain(CITATION_MARKER);
    expect(content).toContain(SOURCE_MARKER);
    expect(content).toContain(DEMOTION_MARKER);
  });

  for (const surface of SURFACES) {
    test(`${surface} states the positive citation test`, () => {
      const content = read(surface);
      expect(content).toContain(CITATION_MARKER);
      expect(content).toContain(SOURCE_MARKER);
      expect(content).toContain(DEMOTION_MARKER);
    });
  }

  // Asserted separately from SURFACES, not appended to it: DEMOTION_MARKER is about
  // demoting plan-task's negative enumeration of bad halt rationales to illustration.
  // /classify-before-deferring never carried that enumeration, so requiring the marker
  // there would assert the presence of text that has nothing to demote.
  for (const surface of [CLASSIFY_SOURCE, CLASSIFY_GENERATED]) {
    test(`${surface} states the positive citation test (mt#4141)`, () => {
      const content = read(surface);
      expect(content).toContain(CITATION_MARKER);
      expect(content).toContain(SOURCE_MARKER);
    });
  }
});

// --- Drift guard (PR #2616 R1, non-blocking findings 2 and 3) -----------------------
//
// The reserved-category list is canonical in principal-context.mdc and restated on both
// halt-condition surfaces, because an agent deciding whether to halt is reading the halt
// conditions, not the principal-context rule. Restating is the right call for the reader
// and the wrong call for maintenance — so the divergence is made mechanical rather than
// left to discipline.

const CANONICAL_RULE = ".minsky/rules/principal-context.mdc";
const CANONICAL_HEADING = "### Decisions Eugene reserves";

/** The reserved categories, read from the canonical rule — never hardcoded here. */
function canonicalCategoryKeywords(): string[] {
  const content = read(CANONICAL_RULE);
  const start = content.indexOf(CANONICAL_HEADING);
  expect(start).toBeGreaterThanOrEqual(0);
  const afterHeading = content.slice(start + CANONICAL_HEADING.length);
  // The section ends at the next heading of the same or higher level.
  const end = afterHeading.search(/\n#{1,3} /);
  const section = end === -1 ? afterHeading : afterHeading.slice(0, end);

  return section
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) =>
      // First significant word, with markdown emphasis stripped: "Naming", "Vendor",
      // "**Framework** choices…" -> "Framework". Distinctive enough to locate the
      // category in a restatement without pinning its exact phrasing.
      (line.slice(2).trim().split(/\s+/)[0] ?? "").replace(/[*_`]/g, "").replace(/[^A-Za-z].*$/, "")
    )
    .filter((word) => word.length > 0);
}

/** The span of a surface that restates the list, so an incidental match elsewhere in the file can't satisfy the check. */
function restatementWindow(content: string, openMarker: string): string {
  const start = content.indexOf(openMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = content.slice(start + openMarker.length);
  const end = rest.indexOf("If you cannot name one");
  expect(end).toBeGreaterThanOrEqual(0);
  return rest.slice(0, end);
}

const RESTATEMENTS: Array<{ name: string; content: () => string; openMarker: string }> = [
  {
    name: SKILL_SOURCE,
    content: () => planTaskSkill.content as string,
    openMarker: CLOSED_LIST_MARKER,
  },
  {
    name: RULE_SOURCE,
    content: () => read(RULE_SOURCE),
    openMarker: "State the category before halting on it:",
  },
  // mt#4141 — both the source and its compiled output. The generated copy is included
  // because an agent reads .claude/skills/, so a source-only assertion passes on a stale
  // compile: exactly the failure mode the SURFACES list above already guards against.
  ...[CLASSIFY_SOURCE, CLASSIFY_GENERATED].map((name) => ({
    name,
    content: () => read(name),
    openMarker: CLOSED_LIST_MARKER,
  })),
];

describe("restated reserved-category lists track principal-context.mdc (mt#3596)", () => {
  test("the canonical section parses to a non-empty category list", () => {
    const keywords = canonicalCategoryKeywords();
    // No expected count is hardcoded — asserting only that parsing found categories, so
    // that adding or removing one canonically is caught by the per-surface checks below
    // rather than by a number that would itself need maintaining.
    expect(keywords.length).toBeGreaterThan(0);
    expect(keywords).toContain("Naming");
  });

  for (const surface of RESTATEMENTS) {
    test(`${surface.name} restates every canonical category`, () => {
      const window = restatementWindow(surface.content(), surface.openMarker).toLowerCase();
      const missing = canonicalCategoryKeywords().filter(
        (word) => !window.includes(word.toLowerCase())
      );
      expect(missing).toEqual([]);
    });
  }
});
