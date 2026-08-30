import { describe, expect, test } from "bun:test";

import {
  classifyRecord,
  correctedRefs,
  elideQuotations,
  planToken,
  type PlanEntry,
} from "./rederive-memory-associations";

/**
 * Fixtures are VERBATIM from the two live records that motivated mt#4765, not paraphrases.
 * Both are `quoted-only`: each names a task inside a markdown code span while DISCUSSING the
 * extractor's behaviour, and the shipped write path minted a permanent association from it.
 */
const MEM_1340_FIRING_LINE = "- `Retire when mt#1541 ships.` → HIT";
const MEM_1340_PROSE = [
  "- **mem#386** (`eba0d69d`) — `## Budget`'s second retirement condition named an extension to a",
  "  DELETED detector (mt#1541 CLOSED, deleted by mt#4197); replacement condition written.",
].join("\n");
const MEM_1208_FIRING_SENTENCE =
  "mem#484 matched `retire when mt#2056 ships` — a sentence in which mem#484 **quotes a " +
  "different memory's** budget criterion while narrating an incident.";

describe("elideQuotations", () => {
  test("blanks an inline code span but preserves length and newlines", () => {
    const input = "before `retire when mt#1.` after\nsecond line";
    const out = elideQuotations(input);
    expect(out.length).toBe(input.length);
    expect(out.split("\n").length).toBe(2);
    expect(out).toContain("before ");
    expect(out).not.toContain("mt#1");
  });

  test("blanks a fenced block including backticks inside it", () => {
    const input = ["prose", "```", "retire when mt#7 ships", "```", "tail"].join("\n");
    expect(elideQuotations(input)).not.toContain("mt#7");
    expect(elideQuotations(input)).toContain("prose");
    expect(elideQuotations(input)).toContain("tail");
  });

  test("blanks to EOF on an unterminated fence rather than matching nothing", () => {
    const input = ["prose", "```", "retire when mt#7 ships"].join("\n");
    expect(elideQuotations(input)).not.toContain("mt#7");
  });

  test("blanks a blockquote line", () => {
    expect(elideQuotations("> retire when mt#8 ships")).not.toContain("mt#8");
  });

  test("leaves ordinary prose untouched", () => {
    const input = "Budget: retire when mt#9 ships.";
    expect(elideQuotations(input)).toBe(input);
  });

  test("does not JOIN tokens across an elided span (would manufacture a match)", () => {
    // Blanking to spaces would turn this into `Retire when      mt#7777 ships`, which the
    // extractor DOES match — inventing a grounding the raw text never had. The filler must
    // break the whitespace run.
    const input = "Retire when `an aside` mt#7777 ships.";
    const elided = elideQuotations(input);
    expect(elided.length).toBe(input.length);
    expect(elided).not.toMatch(/when\s+mt#7777/);
  });
});

describe("elision cannot manufacture a grounding (regression)", () => {
  test("a ref the raw text never derives is not promoted to grounded by elision", () => {
    const content = "Retire when `an aside` mt#7777 ships.";
    // Raw derives nothing here — the span breaks the clause — so the stored ref is
    // not-derivable, NOT grounded. Spaces-as-filler reported `grounded` for exactly this shape.
    const c = classifyRecord({ storedRefs: ["mt#7777"], content });
    expect(c.refs).toEqual([{ ref: "mt#7777", verdict: "not-derivable" }]);
    expect(c.unstoredGrounded).toEqual([]);
  });
});

describe("classifyRecord — discrimination control (mt#4765 AT2, AT3)", () => {
  test("mem#1340's firing line classifies quoted-only, not grounded", () => {
    const c = classifyRecord({
      storedRefs: ["mt#1541"],
      content: `${MEM_1340_FIRING_LINE}\n${MEM_1340_PROSE}`,
    });
    expect(c.refs).toEqual([{ ref: "mt#1541", verdict: "quoted-only" }]);
  });

  test("mem#1340's ordinary prose mention alone yields no ref at all", () => {
    // The bare prose naming mt#1541 is not a retirement clause in any pattern, quoted or not.
    const c = classifyRecord({ storedRefs: ["mt#1541"], content: MEM_1340_PROSE });
    expect(c.refs).toEqual([{ ref: "mt#1541", verdict: "not-derivable" }]);
  });

  test("a genuine unquoted retirement clause classifies grounded — the opposite verdict", () => {
    const c = classifyRecord({
      storedRefs: ["mt#4321"],
      content: "## Budget\n\nRetire when mt#4321 ships.",
    });
    expect(c.refs).toEqual([{ ref: "mt#4321", verdict: "grounded" }]);
  });

  test("one record, one true ref and one quoted ref, judged independently (mem#1208 shape)", () => {
    const c = classifyRecord({
      storedRefs: ["mt#2056", "mt#4454"],
      content: `${MEM_1208_FIRING_SENTENCE}\n\nBudget: retire when mt#4454 ships.`,
    });
    expect(c.refs).toEqual([
      { ref: "mt#2056", verdict: "quoted-only" },
      { ref: "mt#4454", verdict: "grounded" },
    ]);
    expect(correctedRefs(c)).toEqual(["mt#4454"]);
  });

  test("the description is scanned too, matching the read path's haystack", () => {
    const c = classifyRecord({
      storedRefs: ["mt#1709"],
      content: "body with no clause",
      description: "Tracking: mt#1709",
    });
    expect(c.refs).toEqual([{ ref: "mt#1709", verdict: "grounded" }]);
  });

  test("reports a grounded ref the record does not store (recall gap)", () => {
    const c = classifyRecord({
      storedRefs: [],
      content: "Retire when mt#5555 ships.",
    });
    expect(c.unstoredGrounded).toEqual(["mt#5555"]);
  });
});

describe("correctedRefs", () => {
  test("drops only quoted-only refs; not-derivable is preserved", () => {
    // not-derivable is ambiguous by construction — a stored ref may be an author DECLARATION,
    // which is byte-identical to a derived one. Dropping it would delete real associations.
    const c = classifyRecord({
      storedRefs: ["mt#2056", "mt#9998"],
      content: `${MEM_1208_FIRING_SENTENCE}\n\nnothing about mt#9998 here`,
    });
    expect(c.refs.map((r) => r.verdict)).toEqual(["quoted-only", "not-derivable"]);
    expect(correctedRefs(c)).toEqual(["mt#9998"]);
  });
});

describe("planToken", () => {
  const entry: PlanEntry = {
    id: "a",
    shortId: "mem#1",
    name: "n",
    before: ["mt#1", "mt#2"],
    after: ["mt#2"],
    dropped: ["mt#1"],
  };

  test("is stable across entry ordering", () => {
    const other: PlanEntry = { ...entry, id: "b", shortId: "mem#2" };
    expect(planToken([entry, other])).toBe(planToken([other, entry]));
  });

  test("changes when the change set changes", () => {
    expect(planToken([entry])).not.toBe(planToken([{ ...entry, after: [] }]));
  });

  test("an empty plan has a stable token", () => {
    expect(planToken([])).toBe(planToken([]));
  });
});
