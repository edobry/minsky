// mt#4248: the principal's knowledge surface — guidance presence, and ledger consistency.
//
// The shipped mechanism is PROSE (see `docs/rules-rationale/principal-context.md`
// §Enforcement tier for why: whether a term needed a gloss for a given reader is a
// judgement about a person, not a property of the text). So this file does NOT assert
// that any message obeyed the rule. It asserts two things a test CAN settle:
//
//   1. PRESENCE (`describe` #1) — the guidance is on every surface an agent actually
//      reads it from. `principal-context` is `alwaysApply: true`, so it compiles into
//      CLAUDE.md, AGENTS.md AND .cursor/rules/ — a source-only assertion passes on a
//      stale compile, which is the failure mode
//      tests/domain/plan-task-halt-citation.test.ts already guards against for its own
//      rule. Same shape, same reason.
//
//   2. LEDGER CONSISTENCY (`describe` #2) — derived, not hardcoded. The rule's
//      counter-case walk-through claims `MCP` and `subagent` are CONFIRMED-KNOWN. That
//      claim is only true while those terms are in the doc's confirmed-known list, and
//      the two live in different files. So the list is parsed out of the doc at run time
//      and the claim checked against it, rather than both being asserted independently
//      and allowed to drift apart.
//
// The phrases pinned in #1 ARE the policy — the asymmetry, the gloss default, the
// class-distinction from §Plain-language first — not incidental prose around it.
// Deliberately brittle for the same reason the halt-citation manifest is: softening any
// of them should require touching this file, which puts the change in front of a human.

/* eslint-disable custom/no-real-fs-in-tests -- this test's PURPOSE is to verify the
   generated artifacts on disk carry the same guidance as their source, so it must read
   the real files. */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");

const read = (relPath: string): string => readFileSync(join(REPO_ROOT, relPath), "utf8") as string;

/**
 * Whitespace-normalized read. The markers below are full clauses rather than short noun
 * phrases, so they wrap — and where a line break falls is a function of prettier and the
 * 100-char width, not of the policy. A raw `toContain` would fail on a REWRAP, which is a
 * false positive that teaches the next author to delete the test.
 */
const readFlat = (relPath: string): string => read(relPath).replace(/\s+/g, " ");

const RULE_SOURCE = ".minsky/rules/principal-context.mdc";
const RATIONALE_DOC = "docs/rules-rationale/principal-context.md";

/** Every surface an agent reads this guidance from: the source plus its compiled outputs. */
const SURFACES = [RULE_SOURCE, "CLAUDE.md", "AGENTS.md", ".cursor/rules/principal-context.mdc"];

// The calibration target. "Less jargon" is the wrong reading and the one to guard against.
const EDGE_MARKER = "at the edge of his knowledge";
// The asymmetry — the load-bearing half, and the one easiest to get backwards.
const ASYMMETRY_MARKER = "Absence of a question is not evidence of knowledge";
// The UNKNOWN default. Without this the rule states a target and prescribes no action.
const GLOSS_MARKER = "a short inline gloss";
// Over-explaining is a real cost — the counterweight that keeps the gloss default from
// degrading into glossing everything.
const OVER_EXPLAIN_MARKER = "Over-explaining is a real cost, not a safe default";
// The class-distinction: a future reader must not think the older rule already covers this.
const PLAIN_LANGUAGE_MARKER = "user-preferences.mdc §Plain-language first";

describe("the knowledge-surface guidance is present on every surface (mt#4248)", () => {
  for (const surface of SURFACES) {
    test(`${surface} states the calibration target and the asymmetry`, () => {
      const content = readFlat(surface);
      expect(content).toContain(EDGE_MARKER);
      expect(content).toContain(ASYMMETRY_MARKER);
      expect(content).toContain(OVER_EXPLAIN_MARKER);
    });

    test(`${surface} states the default-gloss rule for UNKNOWN terms`, () => {
      expect(readFlat(surface)).toContain(GLOSS_MARKER);
    });

    test(`${surface} distinguishes this class from §Plain-language first`, () => {
      const content = readFlat(surface);
      expect(content).toContain(PLAIN_LANGUAGE_MARKER);
      // Naming the rule is not enough — it must say the older rule does NOT cover this.
      expect(content).toContain("It would not have caught `Mach-O`");
    });

    test(`${surface} carries the seeded confirmed gaps`, () => {
      const content = readFlat(surface);
      expect(content).toContain("Mach-O");
      expect(content).toContain("strings(1)");
      expect(content).toContain("2026-08-18");
    });
  }
});

// --- Ledger consistency (derived, not hardcoded) ------------------------------------

const CONFIRMED_KNOWN_HEADING = "**Confirmed known**";
const CONFIRMED_KNOWN_CLOSE = "This list is illustrative";

/**
 * The confirmed-known terms, read out of the rationale doc at run time — never hardcoded
 * here, so adding or removing one is checked against its consumers rather than requiring
 * this file to be updated in lockstep.
 */
function confirmedKnownTerms(): string[] {
  const content = read(RATIONALE_DOC);
  const heading = content.indexOf(CONFIRMED_KNOWN_HEADING);
  expect(heading).toBeGreaterThanOrEqual(0);

  // Skip the INTRO SENTENCE, not just the heading. It cites the source conversation as
  // `mt#4220`, and a window opened at the heading swept that backticked id in as a term —
  // caught by the negative control, which showed `mt#4220` sitting in the parsed list. A
  // floor assertion ("at least five terms") passes just as happily on a list padded with
  // ids, so the window has to start where the terms actually do: after the blank line
  // that ends the intro.
  const listStart = content.indexOf("\n\n", heading);
  expect(listStart).toBeGreaterThanOrEqual(0);
  const rest = content.slice(listStart);

  const end = rest.indexOf(CONFIRMED_KNOWN_CLOSE);
  // Fail-closed: a reworded closing sentence fails loudly here rather than silently
  // widening the window and sweeping in unrelated backticked terms from later sections.
  expect(end).toBeGreaterThanOrEqual(0);

  return [...rest.slice(0, end).matchAll(/`([^`]+)`/g)]
    .map((m) => m[1] ?? "")
    .filter((term) => term.length > 0);
}

describe("the ledger is seeded and internally consistent (mt#4248)", () => {
  test("the rationale doc records both confirmed gaps with their date and signal", () => {
    // Whitespace-normalized because prettier ALIGNS markdown table columns on commit, so an
    // exact-string match on a table row passes standalone and fails in pre-commit — which is
    // exactly how this test first failed. Column padding is formatter output, not policy.
    const doc = readFlat(RATIONALE_DOC);
    expect(doc).toContain("| `Mach-O` | 2026-08-18 |");
    expect(doc).toContain("| `strings(1)` | 2026-08-18 |");
    // The seeding rule: an entry earns its place by a quotable signal, never by inference.
    expect(readFlat(RATIONALE_DOC)).toContain("Seeded from EXPLICIT evidence only");
  });

  test("at least five confirmed-known terms are recorded from the principal's own usage", () => {
    // Five is the spec's floor, asserted as a floor rather than an exact count so that
    // appending a newly-evidenced term does not fail the test that guards the list.
    expect(confirmedKnownTerms().length).toBeGreaterThanOrEqual(5);
  });

  test("the counter-case walk-through only claims terms the ledger actually confirms", () => {
    // The tuning check: `React`, `MCP` and `subagent` must produce NO gloss. Two of the
    // three are claimed CONFIRMED-KNOWN, and that claim lives in a different section from
    // the list backing it. Remove either from the ledger and the walk-through silently
    // starts asserting something false — this is what catches that.
    const known = confirmedKnownTerms();
    expect(known).toContain("MCP");
    expect(known).toContain("subagent");

    // `React` is deliberately NOT on the list — it is carried by tier 2 (his working
    // vocabulary) alone. That asymmetry is the whole reason tier 2 exists, so pin it:
    // if `React` ever gets added to the ledger, the walk-through's argument for tier 2
    // loses its worked example and needs rewriting.
    expect(known).not.toContain("React");
  });

  test("the rule names tier 2, without which the counter-case would gloss React", () => {
    const content = readFlat(RULE_SOURCE);
    expect(content).toContain("His working vocabulary");
    // Tier 2 is about TERMS and must not read as a competence profile (failure mode 3).
    expect(content).toContain("One question is one term, never a profile");
  });

  test("the decay path is stated: an asked-about term becomes known once explained", () => {
    expect(readFlat(RATIONALE_DOC)).toContain("A gap closes on explanation");
  });

  test("the transcript-derivation feasibility note is recorded with its verdict", () => {
    const doc = readFlat(RATIONALE_DOC);
    expect(doc).toContain("agent_transcript_turns");
    // The verdict must carry the finding that makes it actionable, not just "feasible".
    expect(doc).toContain("The filtering is the build, not the query");
    // mt#4264 re-verified this figure against the fixed script: 99.0% -> 99.1% as the
    // 25-most-recent-transcript window moved (not a correction to the measurement itself).
    expect(doc).toContain("99.1% of the column's characters are agent-authored");
  });
});
