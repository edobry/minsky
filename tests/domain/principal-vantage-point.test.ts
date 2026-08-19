// mt#4259: the principal as an evidence channel — guidance presence, and the tuning check.
//
// The shipped mechanism is PROSE (see `docs/rules-rationale/principal-context.md`
// §Enforcement tier for why: whether the agent's channels reach a subject directly is a
// judgement about that subject and that moment, not a property of any text). So this file
// does NOT assert that an investigation obeyed the rule. It asserts what a test CAN settle:
//
//   1. PRESENCE (`describe` #1/#2) — the guidance is on every surface an agent reads it
//      from. Both rules are `alwaysApply: true`, so each compiles into CLAUDE.md, AGENTS.md
//      AND .cursor/rules/ — a source-only assertion passes on a stale compile, which is the
//      failure mode tests/domain/principal-knowledge-surface.test.ts already guards for its
//      own rule. Same shape, same reason.
//
//   2. THE SPLIT HOLDS (`describe` #3) — the guidance deliberately lives in two rules (the
//      channel-selection trigger where the principal is modelled, the perceive-the-kind rule
//      where evidential warrant is modelled). That is only safe while each points at the
//      other, so the two pointers are pinned. Drop either and a reader arriving from one
//      direction gets half the rule.
//
//   3. THE TUNING CHECK (`describe` #4) — DERIVED, not hardcoded. The counter-case table is
//      parsed out of the rationale doc at run time and its verdicts are asserted to
//      discriminate in BOTH directions. A rule that routes every question to the principal
//      would burn the attention this project exists to conserve, so "does it still say no
//      to ordinary investigation?" is the property most worth pinning — and the one an
//      edit that reads as a harmless strengthening would break first.
//
// The phrases pinned below ARE the policy — the two-conjunct trigger, the counter-case, the
// cheapness asymmetry, the channel-kind floor — not incidental prose around it. Deliberately
// brittle for the same reason the knowledge-surface manifest is: softening any of them should
// require touching this file, which puts the change in front of a human.

/* eslint-disable custom/no-real-fs-in-tests -- this test's PURPOSE is to verify the
   generated artifacts on disk carry the same guidance as their source, so it must read
   the real files. */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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

const VANTAGE_RULE_SOURCE = ".minsky/rules/principal-context.mdc";
const MODALITY_RULE_SOURCE = ".minsky/rules/claim-confidence.mdc";
const RATIONALE_DOC = "docs/rules-rationale/principal-context.md";

/** Every surface an agent reads the vantage-point trigger from. */
const VANTAGE_SURFACES = [
  VANTAGE_RULE_SOURCE,
  "CLAUDE.md",
  "AGENTS.md",
  ".cursor/rules/principal-context.mdc",
];

/** Every surface an agent reads the modality-match rule from. */
const MODALITY_SURFACES = [
  MODALITY_RULE_SOURCE,
  "CLAUDE.md",
  "AGENTS.md",
  ".cursor/rules/claim-confidence.mdc",
];

// The inverted trigger. Note "not a last resort" — the failure was reaching him only after
// the indirect channels came back empty, so the ORDERING is the policy, not just the fact.
const FIRST_TIER_MARKER = "he is a first-tier source, not a";
// Conjunct 2, which does all the narrowing work. Without it conjunct 1 is nearly always true.
const INDIRECT_MARKER = "every channel you have reaches it only";
// The counter-case, stated in the rule itself rather than only in the rationale doc.
const COUNTER_CASE_MARKER =
  "When you can read the primary artifact yourself, he is NOT the channel — go read it.";
// Cheapness is the argument. Framed as politeness, the rule reads as optional courtesy.
const ASYMMETRY_MARKER = "Cheapness is the argument, not politeness";
// The rule must NOT be filed as a deferral: the incident's agent was never blocked.
const NOT_DEFERRAL_MARKER = "This is not the deferral shape";
// The floor for a decision-licensing negative.
const CHANNEL_KINDS_MARKER = "use ≥2 channels of DIFFERENT KINDS";
// The reciprocal pointer into mt#4248's half — asking well is asking in terms he need not decode.
const KNOWLEDGE_HALF_MARKER = "When you do ask, ask in terms he does not have to decode";

describe("the vantage-point guidance is present on every surface (mt#4259)", () => {
  for (const surface of VANTAGE_SURFACES) {
    test(`${surface} states the inverted trigger and its narrowing conjunct`, () => {
      const content = readFlat(surface);
      expect(content).toContain(FIRST_TIER_MARKER);
      expect(content).toContain(INDIRECT_MARKER);
    });

    test(`${surface} states the counter-case that keeps the trigger narrow`, () => {
      expect(readFlat(surface)).toContain(COUNTER_CASE_MARKER);
    });

    test(`${surface} argues from cost, and does not require the agent to be blocked`, () => {
      const content = readFlat(surface);
      expect(content).toContain(ASYMMETRY_MARKER);
      expect(content).toContain(NOT_DEFERRAL_MARKER);
    });

    test(`${surface} states the multi-channel floor for a decision-licensing negative`, () => {
      expect(readFlat(surface)).toContain(CHANNEL_KINDS_MARKER);
    });

    test(`${surface} routes back to the knowledge half when the probe is a question`, () => {
      // mt#4248 ships the state half of this model and forward-references this one. The
      // reciprocal pointer has to exist too: an agent that reaches him without the knowledge
      // model asks in terms he must decode, which reproduces the root from the other side.
      expect(readFlat(surface)).toContain(KNOWLEDGE_HALF_MARKER);
    });
  }
});

// The modality rule's own markers. The worked example is load-bearing: "check the channel can
// perceive the kind of thing you seek" is true and useless without one, which is why the
// incident's subject (a VISUAL behaviour) and probe (a TEXT search) are both pinned.
const MODALITY_MARKER = "check the channel can PERCEIVE that kind of thing";
const CANNOT_FAIL_MARKER =
  'A modality mismatch returns "not found" whether or not the thing exists';
const FALSIFIER_MARKER = "The falsifier for a rendered behaviour is a rendering";

describe("the modality-match rule is present on every surface (mt#4259)", () => {
  for (const surface of MODALITY_SURFACES) {
    test(`${surface} states the check and why a mismatch carries no information`, () => {
      const content = readFlat(surface);
      expect(content).toContain(MODALITY_MARKER);
      expect(content).toContain(CANNOT_FAIL_MARKER);
    });

    test(`${surface} carries the worked example, not just the principle`, () => {
      const content = readFlat(surface);
      // A VISUAL subject probed by a TEXT search — both halves, or the example proves nothing.
      expect(content).toContain("a VISUAL behaviour");
      expect(content).toContain("TEXT search for a rendered artifact");
      expect(content).toContain("`strings`");
      expect(content).toContain(FALSIFIER_MARKER);
    });
  }
});

describe("the two halves point at each other (mt#4259)", () => {
  // The guidance is deliberately split across two rules. That is only safe while each names
  // the other: an agent arriving at the trigger needs the modality check before it accepts a
  // zero, and an agent arriving at the modality check needs to know the principal is a kind
  // of channel. Asserted on the SOURCES, since CLAUDE.md contains both rules and so would
  // pass this trivially.
  test("the principal rule points at the modality rule", () => {
    expect(readFlat(VANTAGE_RULE_SOURCE)).toContain(
      "`claim-confidence.mdc §Before accepting a zero result`"
    );
  });

  test("the modality rule points back at the principal rule", () => {
    expect(readFlat(MODALITY_RULE_SOURCE)).toContain(
      "`principal-context.mdc §What Eugene can see`"
    );
  });
});

// --- The tuning check (derived, not hardcoded) ---------------------------------------

const COUNTER_CASE_OPEN = "The counter-case, run explicitly as the tuning check";
const COUNTER_CASE_CLOSE = "The first row is the one that matters";

interface CounterCaseRow {
  readonly investigation: string;
  readonly outcome: string;
}

/**
 * The counter-case table, parsed out of the rationale doc at run time — never restated here,
 * so a changed verdict is checked against its consumers rather than requiring this file to be
 * edited in lockstep. Prettier realigns markdown table columns on commit, so cells are
 * trimmed: column padding is formatter output, not policy.
 */
function counterCaseRows(): CounterCaseRow[] {
  const content = read(RATIONALE_DOC);
  const open = content.indexOf(COUNTER_CASE_OPEN);
  expect(open).toBeGreaterThanOrEqual(0);
  const close = content.indexOf(COUNTER_CASE_CLOSE, open);
  // Fail-closed: a reworded closing sentence fails loudly here rather than silently widening
  // the window and sweeping in rows from an unrelated table further down the document.
  expect(close).toBeGreaterThan(open);

  return (
    content
      .slice(open, close)
      .split("\n")
      .filter((line) => line.trim().startsWith("|"))
      .map((line) =>
        line
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((cell) => cell.trim())
      )
      // Drop the header row and the `| --- |` separator; keep only data rows.
      .filter(
        (cells) => cells.length >= 4 && !/^-+$/.test(cells[1] ?? "") && cells[0] !== "Investigation"
      )
      .map((cells) => ({ investigation: cells[0] ?? "", outcome: cells[cells.length - 1] ?? "" }))
  );
}

const isDoNotAsk = (row: CounterCaseRow): boolean => /do not ask/i.test(row.outcome);
const isAsk = (row: CounterCaseRow): boolean => !isDoNotAsk(row) && /\bask\b/i.test(row.outcome);

describe("the trigger is tuned, not maximal (mt#4259)", () => {
  test("the counter-case table discriminates in both directions", () => {
    const rows = counterCaseRows();
    // A table of only-ask rows is a rule that routes everything to the principal; a table of
    // only-do-not-ask rows is a rule that never reaches him. Both are mis-tunings, and a
    // presence assertion on the section heading would catch neither.
    expect(rows.filter(isDoNotAsk).length).toBeGreaterThanOrEqual(2);
    expect(rows.filter(isAsk).length).toBeGreaterThanOrEqual(1);
  });

  test("investigating a code path in this repo does NOT route to the principal", () => {
    // The spec's named counter-case, and the single row this whole rule is tuned against.
    const row = counterCaseRows().find((r) => /code path in this repo/i.test(r.investigation));
    expect(row).toBeDefined();
    expect(isDoNotAsk(row as CounterCaseRow)).toBe(true);
  });

  test("the doc states WHICH conjunct does the narrowing", () => {
    // Conjunct 1 is nearly always true — he has access to essentially everything here — so a
    // reader who takes conjunct 1 as the trigger reproduces the mis-tuning this guards against.
    expect(readFlat(RATIONALE_DOC)).toContain(
      'The narrowing work is done entirely by "your channels reach it only indirectly."'
    );
  });
});

describe("the enforcement tier and the home choice are on the record (mt#4259)", () => {
  test("the tier is stated as prose, with the reason the adjacent detectors cannot fire", () => {
    const doc = readFlat(RATIONALE_DOC);
    expect(doc).toContain("Enforcement tier: prose, stated rather than defaulted to");
    expect(doc).toContain("operator-deferral");
    expect(doc).toContain("ask-routing-deferral");
    // Not "we didn't get to it" — they cannot fire on a failure that emits no deferral prose.
    expect(doc).toContain("by construction");
  });

  test("the doc names a regression guard that actually exists", () => {
    const doc = readFlat(RATIONALE_DOC);
    const named = "tests/domain/principal-vantage-point.test.ts";
    expect(doc).toContain(named);
    // A doc naming a guard that was renamed or deleted is worse than naming none.
    expect(existsSync(join(REPO_ROOT, named))).toBe(true);
  });

  test("all three candidate homes were evaluated, not just the chosen one", () => {
    const doc = readFlat(RATIONALE_DOC);
    expect(doc).toContain("Where this landed, and the three homes evaluated");
    expect(doc).toContain("user-preferences.mdc §Probe before deferring` — rejected");
    expect(doc).toContain("claim-confidence.mdc` — chosen for the modality-match half only");
    expect(doc).toContain("research-sandwich` entry condition — ruled out");
    // The rejection of §Probe before deferring rests on this: the failure has no phrase, so
    // widening that rule's trigger list cannot reach it. Losing this sentence loses the argument.
    expect(doc).toContain("the failure has no phrase");
  });
});
