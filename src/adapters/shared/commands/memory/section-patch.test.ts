import { describe, expect, test } from "bun:test";
import { patchSection } from "./section-patch";

/** A family-root shape: the exact structure mt#3602 exists to make patchable. */
const FAMILY_ROOT = `# Confabulated strategic frame

Intro prose that must not move.

## Recurrences

**R1 (2026-05-08):** first instance.

**R2 (2026-05-12):** second instance.

## How to apply

1. Do the thing.

## Cross-references

- mem#367
`;

describe("patchSection — append", () => {
  test("AT1: the full diff is exactly the added paragraph", () => {
    const added = "**R3 (2026-08-03):** third instance.";
    const result = patchSection({
      content: FAMILY_ROOT,
      section: "## Recurrences",
      text: added,
      mode: "append",
    });

    // The strongest form of the criterion: reconstruct the original by
    // removing exactly the inserted lines, and assert byte-equality.
    const before = FAMILY_ROOT.split("\n");
    const after = result.split("\n");
    expect(after.length).toBe(before.length + 2); // one blank separator + one line

    const insertedAt = after.findIndex((l) => l === added);
    expect(insertedAt).toBeGreaterThan(-1);
    const withoutInsertion = [...after];
    withoutInsertion.splice(insertedAt - 1, 2); // the blank + the added line
    expect(withoutInsertion.join("\n")).toBe(FAMILY_ROOT);
  });

  test("lands after the section's last content line, before the next heading", () => {
    const result = patchSection({
      content: FAMILY_ROOT,
      section: "Recurrences",
      text: "**R3:** third.",
      mode: "append",
    });
    const lines = result.split("\n");
    const addedIdx = lines.indexOf("**R3:** third.");
    const r2Idx = lines.indexOf("**R2 (2026-05-12):** second instance.");
    const nextHeadingIdx = lines.indexOf("## How to apply");

    expect(addedIdx).toBeGreaterThan(r2Idx);
    expect(addedIdx).toBeLessThan(nextHeadingIdx);
  });

  test("accepts the section name with or without leading hashes", () => {
    const withHashes = patchSection({
      content: FAMILY_ROOT,
      section: "## Recurrences",
      text: "x",
      mode: "append",
    });
    const without = patchSection({
      content: FAMILY_ROOT,
      section: "Recurrences",
      text: "x",
      mode: "append",
    });
    expect(withHashes).toBe(without);
  });

  test("a deeper subsection does not end the section early", () => {
    const nested = `## Recurrences

**R1:** one.

### R1 detail

Detail prose.

## Next section

after
`;
    const result = patchSection({
      content: nested,
      section: "## Recurrences",
      text: "**R2:** two.",
      mode: "append",
    });
    const lines = result.split("\n");
    expect(lines.indexOf("**R2:** two.")).toBeGreaterThan(lines.indexOf("Detail prose."));
    expect(lines.indexOf("**R2:** two.")).toBeLessThan(lines.indexOf("## Next section"));
  });

  test("appends into an empty section without a leading blank run", () => {
    const empty = "## Recurrences\n\n## Next\n";
    const result = patchSection({
      content: empty,
      section: "## Recurrences",
      text: "**R1:** first.",
      mode: "append",
    });
    expect(result).toBe("## Recurrences\n**R1:** first.\n\n## Next\n");
  });

  test("AT5: a ~10KB record round-trips byte-identically outside the target section", () => {
    const filler = Array.from({ length: 200 }, (_, i) => `Filler line ${i} of untouched prose.`);
    const big = [
      "# Big record",
      "",
      ...filler,
      "",
      "## Recurrences",
      "",
      "**R1:** one.",
      "",
      "## Tail",
      "",
      ...filler,
      "",
    ].join("\n");
    expect(big.length).toBeGreaterThan(10_000);

    const result = patchSection({
      content: big,
      section: "## Recurrences",
      text: "**R2:** two.",
      mode: "append",
    });

    // Everything before the target heading, and everything from the next
    // heading onward, must be byte-identical.
    const head = big.slice(0, big.indexOf("## Recurrences"));
    expect(result.startsWith(head)).toBe(true);
    const tail = big.slice(big.indexOf("## Tail"));
    expect(result.endsWith(tail)).toBe(true);
  });

  test("CRLF line endings survive the splice", () => {
    const crlf = "## Recurrences\r\n\r\n**R1:** one.\r\n\r\n## Next\r\n";
    const result = patchSection({
      content: crlf,
      section: "## Recurrences",
      text: "**R2:** two.",
      mode: "append",
    });
    expect(result).toContain("**R1:** one.\r\n");
    expect(result).toContain("## Next\r\n");
  });
});

describe("patchSection — prepend and replace", () => {
  test("prepend inserts directly under the heading", () => {
    const result = patchSection({
      content: FAMILY_ROOT,
      section: "## Recurrences",
      text: "**R0:** earliest.",
      mode: "prepend",
    });
    const lines = result.split("\n");
    expect(lines.indexOf("**R0:** earliest.")).toBeLessThan(
      lines.indexOf("**R1 (2026-05-08):** first instance.")
    );
  });

  test("replace swaps the body and leaves neighbouring sections intact", () => {
    const result = patchSection({
      content: FAMILY_ROOT,
      section: "## Recurrences",
      text: "\nrewritten.\n",
      mode: "replace",
    });
    expect(result).toContain("rewritten.");
    expect(result).not.toContain("**R1 (2026-05-08):** first instance.");
    expect(result).toContain("## How to apply");
    expect(result).toContain("1. Do the thing.");
    expect(result).toContain("Intro prose that must not move.");
  });
});

describe("patchSection — loud failures", () => {
  test("AT2: a missing section throws and names the available headings", () => {
    expect(() =>
      patchSection({
        content: FAMILY_ROOT,
        section: "## Nonexistent",
        text: "x",
        mode: "append",
      })
    ).toThrow(/Section "## Nonexistent" not found.*Available headings.*Recurrences/s);
  });

  test("AT3: a duplicated section throws with the line numbers, and patches nothing", () => {
    const dup = "## Recurrences\n\na\n\n## Recurrences\n\nb\n";
    expect(() =>
      patchSection({ content: dup, section: "## Recurrences", text: "x", mode: "append" })
    ).toThrow(/ambiguous — it appears 2 times \(line 1, line 5\)/);
  });

  test("a record with no headings at all reports that, not a heading list", () => {
    expect(() =>
      patchSection({ content: "just prose\n", section: "Recurrences", text: "x", mode: "append" })
    ).toThrow(/contains no markdown headings/);
  });

  test("a heading matching only as a prefix is not treated as the section", () => {
    const near = "## Recurrences and notes\n\nbody\n";
    expect(() =>
      patchSection({ content: near, section: "## Recurrences", text: "x", mode: "append" })
    ).toThrow(/not found/);
  });
});
