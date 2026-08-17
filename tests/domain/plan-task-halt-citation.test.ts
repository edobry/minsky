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
// The plan-task skill's COMPILED output. Named because three separate guards below read it:
// the presence list, the mt#3855 prose list, and the drift guard (PR #3071 R1).
const PLAN_TASK_GENERATED = ".claude/skills/plan-task/SKILL.md";

// mt#4141: the THIRD surface carrying the citation test, added after R7 of the
// confabulated-strategic-frame family. The two surfaces above are both scoped to a
// skill-chain transition ("override the chain-walk default at any transition"), so a
// turn-end deferral outside any chain reached the principal with the test never applied.
// /classify-before-deferring owns the whether-question generally — /escalation-packaging
// §Related delegates it there explicitly — and its Class C copy had drifted to six
// categories against the canonical seven, precisely because nothing here covered it.
const CLASSIFY_SOURCE = ".minsky/skills/classify-before-deferring/SKILL.md";
const CLASSIFY_GENERATED = ".claude/skills/classify-before-deferring/SKILL.md";
// --- Restatement-window anchors (drift guard, `describe` #2) -------------------------
//
// These three phrases bound the span of a surface that restates the reserved-category list
// (see `restatementWindow` below). They are grouped here so each phrase is defined ONCE
// rather than once per call site, and they are hardcoded ON PURPOSE.
//
// Hardcoding is irreducible: the guard has to LOCATE the restatement inside prose it does
// not control, so something must say where that span begins and ends. What WAS reducible is
// the silence about why that is safe — the file header defends this same brittleness for
// the PRESENCE guard (`describe` #1) and says nothing about these anchors, which is what
// mt#4146 (PR #2998 R1, non-blocking) flagged.
//
// It is safe because the failure is FAIL-CLOSED, and that is measured rather than assumed
// (mt#4146): reword an anchor on any surface and `indexOf` returns -1, so
// `restatementWindow`'s `expect(...).toBeGreaterThanOrEqual(0)` fails loudly AND the failing
// test names the drifted surface. It does NOT silently widen the window and keep passing —
// that failure DIRECTION is the whole reason this is a nit rather than a defect, and it is
// the opposite of the silent drift mt#4141 fixed one level down. Observed by rewording
// CLOSE_MARKER's phrase in the classify source: 12 pass, 1 fail, the one failure being that
// surface's own drift test.
//
// FIVE surfaces depend on these anchors as of PR #3071 R1, so each anchor is load-bearing for
// a real test: the plan-task skill's source AND its compiled output, `key-workflows.mdc`, and
// the classify skill's source AND its compiled output. (mt#4141 brought this to four; the
// plan-task compiled copy was the asymmetry R1 caught — `SURFACES` already read that file
// while the drift guard did not.)

// Opens the window on both classify surfaces AND on the plan-task skill — they deliberately
// share the phrase, so the drift guard reads the same construction everywhere it appears.
const CLOSED_LIST_MARKER = "The closed list:";
// Opens the window on the rule source, which introduces the same list in its own words.
const RULE_OPEN_MARKER = "State the category before halting on it:";
// Closes the window on every surface — all four restatements are followed by this sentence.
const CLOSE_MARKER = "If you cannot name one";

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
  PLAN_TASK_GENERATED,
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

// --- mt#3855: both halt conditions need a citation, and the quote must support it ----
//
// mt#3596 (above) pins that condition 3 names a reserved CATEGORY. Two later recurrences
// showed that is necessary and not sufficient, in two different directions:
//
//   R6 (2026-08-08) — the agent wrote "Principal approves the final hero headline before
//   merge" into the spec itself, then halted an APPROVED, checks-green PR citing that
//   criterion plus "naming". A real category, so everything above PASSED. The fabrication
//   had moved upstream out of the RATIONALE and into the RESERVATION.
//
//   R8 (2026-08-16) — the agent cited condition 1 instead ("the principal deferred"),
//   which carried no verification requirement on any surface. It quoted a genuine "Hold
//   on, help me understand…" and called that an explicit pause on implementation. Every
//   fix in this family was inapplicable by construction, each being scoped to condition 3.
//
// So: condition 3 additionally needs the reserving ACT with principal provenance,
// condition 1 needs a quote that names the step it defers, and BOTH need the quote to say
// what the citation claims it says.

/**
 * Whitespace-normalized read, used only by the mt#3855 assertions.
 *
 * These markers are full sentences rather than the short noun phrases above, so they wrap
 * — and where a line break falls is a function of prettier and the 100-char width, not of
 * the policy. A raw `toContain` would fail on a REWRAP, which is a false positive that
 * teaches the next author to delete the test. Normalizing collapses that axis while
 * leaving the wording itself pinned exactly as brittle as the guards above.
 */
const readFlat = (relPath: string): string => read(relPath).replace(/\s+/g, " ");
const flat = (text: string): string => text.replace(/\s+/g, " ");

// Condition 3 (R6): naming the category is not enough — cite the act, and agent-authored
// artifact text is explicitly not provenance.
const PROVENANCE_MARKER = "principal provenance";
const NON_PROVENANCE_MARKER = "Agent-authored artifact text is NOT provenance";
// Condition 1 (R8): quote the principal AND name the step the quote defers.
const CONDITION1_MARKER = "name which step the quote defers";
// Both conditions (R8 refinement): a genuine quote that does not say what you claim.
const QUOTE_SUPPORT_MARKER = "A quote must SUPPORT the claim";

// The PROSE surfaces carry the full discipline. Same source-plus-generated split as
// SURFACES above, for the same reason: a source-only assertion passes on a stale compile.
const PROSE_SURFACES = [
  RULE_SOURCE,
  PLAN_TASK_GENERATED,
  "CLAUDE.md",
  "AGENTS.md",
  ".cursor/rules/key-workflows.mdc",
];

describe("both halt conditions require a supporting citation (mt#3855)", () => {
  test("the plan-task skill SOURCE states both conditions' citation tests", () => {
    const content = flat(planTaskSkill.content as string);
    expect(content).toContain(PROVENANCE_MARKER);
    expect(content).toContain(NON_PROVENANCE_MARKER);
    expect(content).toContain(CONDITION1_MARKER);
    expect(content).toContain(QUOTE_SUPPORT_MARKER);
  });

  for (const surface of PROSE_SURFACES) {
    test(`${surface} states both conditions' citation tests`, () => {
      const content = readFlat(surface);
      expect(content).toContain(PROVENANCE_MARKER);
      expect(content).toContain(NON_PROVENANCE_MARKER);
      expect(content).toContain(CONDITION1_MARKER);
      expect(content).toContain(QUOTE_SUPPORT_MARKER);
    });
  }

  // The hook that INJECTS the halt enumeration at the moment of the READY transition.
  //
  // This surface is why R8 happened rather than merely where it is described: the hook
  // fired correctly, listed three legitimate halts, and the agent picked the one with no
  // test attached. An enumeration whose members are unevenly verified routes traffic to
  // the unverified ones, so the two condition-specific tests have to travel WITH the
  // enumeration, not merely exist in a rule the agent may not re-read.
  //
  // It is asserted on a narrower marker set than the prose surfaces on purpose: this is a
  // bounded injected message with an attention budget, so it carries the two operative
  // per-condition requirements and leaves the R6/R8 narrative and the quote-support
  // refinement to the prose it cites.
  for (const surface of [
    ".minsky/hooks/drive-ready-to-implementation.ts",
    ".claude/hooks/drive-ready-to-implementation.ts",
  ]) {
    test(`${surface} injects both conditions' citation tests`, () => {
      const content = readFlat(surface);
      expect(content).toContain(CONDITION1_MARKER);
      expect(content).toContain(NON_PROVENANCE_MARKER);
    });
  }

  // The upstream half (SC4). The consumption-side fix above stops a fabricated
  // reservation from being CITED; this stops one class of it being WRITTEN, at the
  // cheapest moment. Recorded choice: /create-task, because §2a-§2c already carry
  // exactly this "cite it or mark it" shape there and Step 4's gate enumerates them.
  for (const surface of [
    ".minsky/skills/create-task/SKILL.md",
    ".claude/skills/create-task/SKILL.md",
  ]) {
    test(`${surface} requires the reserving act at spec-authoring time`, () => {
      const content = readFlat(surface);
      expect(content).toContain("reserves a decision to the principal");
      expect(content).toContain("Selecting an option endorses its LABEL");
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
  const end = rest.indexOf(CLOSE_MARKER);
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
    openMarker: RULE_OPEN_MARKER,
  },
  // mt#4141 — both the source and its compiled output. The generated copy is included
  // because an agent reads .claude/skills/, so a source-only assertion passes on a stale
  // compile: exactly the failure mode the SURFACES list above already guards against.
  ...[CLASSIFY_SOURCE, CLASSIFY_GENERATED].map((name) => ({
    name,
    content: () => read(name),
    openMarker: CLOSED_LIST_MARKER,
  })),
  // PR #3071 R1 (non-blocking, PRE-EXISTING): the generated plan-task SKILL restatement was
  // missing here while `SURFACES` above already checked that same file. The asymmetry is the
  // bug — mt#4141 added the source-AND-generated pair for /classify-before-deferring and did
  // not backfill it for /plan-task, so a category added canonically could diverge in the copy
  // an agent actually reads and only the classify surfaces would have caught it.
  {
    name: PLAN_TASK_GENERATED,
    content: () => read(PLAN_TASK_GENERATED),
    openMarker: CLOSED_LIST_MARKER,
  },
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
