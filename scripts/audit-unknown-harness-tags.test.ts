/**
 * mt#4061 — the unknown-harness-tag sweep's decision core.
 *
 * The property under test throughout: the sweep NOMINATES a tag only when it is
 * shaped like harness markup AND the inventory does not already know it. Both
 * halves have a failure mode worth a test — nominating prose trains the reader
 * to skim the output, and missing a real family is the gap the sweep exists to
 * close.
 */
import { describe, test, expect } from "bun:test";
import { isUnknownTag, scanTurns, turnStartTags } from "./audit-unknown-harness-tags";

/** A tag no harness emits, so it is unknown by construction and stays that way. */
const NOVEL_TAG = "sandwich-mode";

function turn(text: string, conversationId = "c1") {
  return { conversationId, text };
}

describe("turnStartTags — conservatism mirrors the render surface", () => {
  test("a turn-start paired tag is found", () => {
    expect(turnStartTags(`<${NOVEL_TAG}>payload</${NOVEL_TAG}>`)).toEqual([NOVEL_TAG]);
  });

  test("a contiguous run of blocks is consumed, not just the first", () => {
    // The bash-mode family (mt#4058) arrives exactly this way — two blocks in
    // one turn — and a matcher that stopped at the first would have missed the
    // second half of the very family that motivated this sweep.
    expect(turnStartTags("<alpha-one>a</alpha-one><beta-two>b</beta-two>")).toEqual([
      "alpha-one",
      "beta-two",
    ]);
  });

  test("prose merely MENTIONING a tag mid-sentence is not a hit", () => {
    expect(turnStartTags(`I was reading about <${NOVEL_TAG}> tags today.`)).toEqual([]);
  });

  test("an unclosed tag is not a hit — this is what keeps CLI help text out", () => {
    // `<command>` appears 410 times in the corpus as CLI usage text with no
    // closing tag; requiring the pair is what excludes it structurally rather
    // than by name.
    expect(turnStartTags("<command> [options]")).toEqual([]);
  });

  test("a mismatched closing tag is not a pair", () => {
    expect(turnStartTags("<alpha-one>x</beta-two>")).toEqual([]);
  });

  test("attributes and whitespace padding on the opening tag are tolerated", () => {
    expect(turnStartTags('<alpha-one kind="slash">x</alpha-one>')).toEqual(["alpha-one"]);
    expect(turnStartTags("<alpha-one >x</alpha-one>")).toEqual(["alpha-one"]);
  });

  test("a JSX-style capitalized element is not a candidate", () => {
    expect(turnStartTags("<Card>use this primitive</Card>")).toEqual([]);
  });

  test("a leading comparison is not read as a tag", () => {
    expect(turnStartTags("<3 this design, keep it")).toEqual([]);
  });

  test("the per-turn run is bounded rather than unbounded", () => {
    const many = Array.from({ length: 30 }, (_, i) => `<t-${i}>x</t-${i}>`).join("");
    expect(turnStartTags(many).length).toBeLessThanOrEqual(8);
  });
});

describe("isUnknownTag — known and recorded-prose tags are not nominated", () => {
  test("a tag already in the inventory is not unknown", () => {
    expect(isUnknownTag("system-reminder")).toBe(false);
    expect(isUnknownTag("local-command-stdout")).toBe(false);
  });

  test("the bash-mode family added by mt#4058 is not re-nominated", () => {
    // This is the sweep's own regression check: the family it was filed over
    // must read as KNOWN now that the inventory carries it.
    expect(isUnknownTag("bash-input")).toBe(false);
    expect(isUnknownTag("bash-stdout")).toBe(false);
    expect(isUnknownTag("bash-stderr")).toBe(false);
  });

  test("the three recorded prose lookalikes are excluded by name as well", () => {
    // Belt and braces: the close-tag requirement already excludes CLI help
    // text, but a prose sample that happens to close its tag would slip past
    // shape alone.
    expect(isUnknownTag("command")).toBe(false);
    expect(isUnknownTag("command-digest")).toBe(false);
    expect(isUnknownTag("skill-name")).toBe(false);
  });

  test("a genuinely new tag IS nominated", () => {
    expect(isUnknownTag(NOVEL_TAG)).toBe(true);
  });
});

describe("scanTurns — the report a reader acts on", () => {
  test("corpus size is reported even when there are no findings", () => {
    // The load-bearing case: a clean report over an empty corpus and a clean
    // report over a real one must be distinguishable, or the sweep silently
    // degrades into a probe that cannot fail (mem#704). ADR-025 makes the
    // empty case reachable — the local JSONL is declared throw-away.
    const report = scanTurns([turn("just an ordinary message", "a"), turn("another", "b")]);
    expect(report.findings).toEqual([]);
    expect(report.conversationsScanned).toBe(2);
    expect(report.turnsExamined).toBe(2);
  });

  test("an empty corpus reports zeroes rather than looking like a clean scan", () => {
    expect(scanTurns([])).toEqual({
      conversationsScanned: 0,
      turnsExamined: 0,
      findings: [],
    });
  });

  test("occurrences and conversation spread are counted separately", () => {
    // One tag seen 3 times in 2 conversations is a different signal from one
    // seen 3 times in 1 — a family versus one operator's quirk.
    const report = scanTurns([
      turn(`<${NOVEL_TAG}>x</${NOVEL_TAG}>`, "a"),
      turn(`<${NOVEL_TAG}>y</${NOVEL_TAG}>`, "a"),
      turn(`<${NOVEL_TAG}>z</${NOVEL_TAG}>`, "b"),
    ]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      tag: NOVEL_TAG,
      occurrences: 3,
      conversations: 2,
    });
  });

  test("a finding carries a sample so markup-vs-prose is judgeable from the report", () => {
    const report = scanTurns([turn(`<${NOVEL_TAG}>the payload text</${NOVEL_TAG}>`)]);
    expect(report.findings[0]?.sample).toContain("the payload text");
  });

  test("newlines in the sample are escaped so one finding stays one row", () => {
    const report = scanTurns([turn(`<${NOVEL_TAG}>line one\nline two</${NOVEL_TAG}>`)]);
    expect(report.findings[0]?.sample).not.toContain("\n");
    expect(report.findings[0]?.sample).toContain("\\n");
  });

  test("findings are ordered most-frequent first", () => {
    const report = scanTurns([
      turn("<rare-tag>x</rare-tag>", "a"),
      turn("<common-tag>x</common-tag>", "a"),
      turn("<common-tag>x</common-tag>", "b"),
    ]);
    expect(report.findings.map((f) => f.tag)).toEqual(["common-tag", "rare-tag"]);
  });

  test("known tags are counted as turns examined but never nominated", () => {
    const report = scanTurns([turn("<system-reminder>injected</system-reminder>")]);
    expect(report.findings).toEqual([]);
    expect(report.turnsExamined).toBe(1);
  });
});
