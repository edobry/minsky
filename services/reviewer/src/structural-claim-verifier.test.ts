import { describe, it, expect } from "bun:test";
import {
  countDeclarationForms,
  extractDeclaredIdentifiers,
  extractDuplicateDeclarationClaim,
  countHeadingOccurrences,
  extractQuotedHeadings,
  extractDuplicateSectionClaim,
  extractStructuralClaim,
  extractMissingSubjectClaim,
  matchPathsForFileRef,
  applyStructuralClaimVerification,
  fetchAndApplyStructuralClaimVerification,
} from "./structural-claim-verifier";
import type {
  StructuralClaimDowngradeAuditEntry,
  DuplicateDeclarationDowngradeAuditEntry,
  DuplicateSectionDowngradeAuditEntry,
  MissingSubjectDowngradeAuditEntry,
} from "./structural-claim-verifier";
import type { ReviewToolCall } from "./output-tools";

/**
 * Narrow an audit entry to the duplicate-declaration variant. mt#3520 widened
 * `StructuralClaimDowngradeAuditEntry` into a `claimClass`-discriminated union, so reading
 * `.identifier` off the union no longer typechecks — assert the class, then narrow.
 */
function asDeclarationEntry(
  entry: StructuralClaimDowngradeAuditEntry | undefined
): DuplicateDeclarationDowngradeAuditEntry {
  expect(entry?.claimClass).toBe("duplicate-declaration");
  return entry as DuplicateDeclarationDowngradeAuditEntry;
}

/** Sibling of `asDeclarationEntry` for the duplicate-section variant. */
function asSectionEntry(
  entry: StructuralClaimDowngradeAuditEntry | undefined
): DuplicateSectionDowngradeAuditEntry {
  expect(entry?.claimClass).toBe(DUPLICATE_SECTION_CLASS);
  return entry as DuplicateSectionDowngradeAuditEntry;
}

const TEST_FILE = "services/reviewer/src/prompt.test.ts";

// The two identifiers from the real mt#3245 origin incident (PR #2325, mt#2575 instance 5) —
// named once here and interpolated everywhere below to avoid magic-string duplication.
const ID_1 = "DOES_NOT_COVER_H2_HEADING";
const ID_2 = "MT3001_SPEC_EXCERPT";
const DUPLICATE_IDENTIFIER_ERROR_SUMMARY = "Duplicate identifier error";

function blockingFinding(
  file: string,
  summary: string,
  details: string,
  overrides: Partial<{ line: number }> = {}
): ReviewToolCall {
  return {
    name: "submit_finding",
    args: {
      severity: "BLOCKING",
      file,
      line: overrides.line ?? 1406,
      summary,
      details,
    },
  };
}

function nonBlockingFinding(file: string, summary: string, details: string): ReviewToolCall {
  return {
    name: "submit_finding",
    args: { severity: "NON-BLOCKING", file, line: 10, summary, details },
  };
}

function specVerification(criterion: string, status: "Met" | "Not Met" | "N/A"): ReviewToolCall {
  return {
    name: "submit_spec_verification",
    args: { criterion, status, evidence: "some/file.ts:1-5" },
  };
}

// ---------------------------------------------------------------------------
// countDeclarationForms — the "occurrences are not declarations" primitive
// ---------------------------------------------------------------------------

describe("countDeclarationForms", () => {
  it("counts a single const declaration, not a later usage", () => {
    const content = [
      `const ${ID_1} = "## Does NOT cover";`,
      "",
      "// ... 1400 lines later ...",
      `expect(prompt).toContain(${ID_1});`,
    ].join("\n");
    expect(countDeclarationForms(content, ID_1)).toBe(1);
  });

  it("counts two genuine const declarations", () => {
    const content = ["const FOO_BAR = 1;", "// later, re-declared", "const FOO_BAR = 2;"].join(
      "\n"
    );
    expect(countDeclarationForms(content, "FOO_BAR")).toBe(2);
  });

  it("does not count import/property/string mentions as declarations", () => {
    const content = [
      "import { FOO_BAR } from './constants';",
      "const obj = { FOO_BAR: 1 };",
      'const msg = "FOO_BAR is not a real declaration here";',
    ].join("\n");
    expect(countDeclarationForms(content, "FOO_BAR")).toBe(0);
  });

  it("counts each of the seven declaration forms", () => {
    expect(countDeclarationForms("const X = 1;", "X")).toBe(1);
    expect(countDeclarationForms("let X = 1;", "X")).toBe(1);
    expect(countDeclarationForms("var X = 1;", "X")).toBe(1);
    expect(countDeclarationForms("function X() {}", "X")).toBe(1);
    expect(countDeclarationForms("class X {}", "X")).toBe(1);
    expect(countDeclarationForms("type X = string;", "X")).toBe(1);
    expect(countDeclarationForms("interface X {}", "X")).toBe(1);
  });

  it("handles export/async/generator/type-annotation prefixes", () => {
    expect(countDeclarationForms("export const X: number = 1;", "X")).toBe(1);
    expect(countDeclarationForms("export async function X() {}", "X")).toBe(1);
    expect(countDeclarationForms("export function* X() {}", "X")).toBe(1);
    expect(countDeclarationForms("export default class X {}", "X")).toBe(1);
  });

  // PR #2334 R1 review: the modifier tolerance claim below was checked against this exact
  // module rather than assumed true — the pattern already tolerates any keyword preceding
  // "class"/"function" (the `\b` anchor only cares what immediately precedes the keyword
  // itself), so `abstract class` was already counted correctly before this test existed.
  // Added as verification evidence, not a behavior change.
  it("tolerates an `abstract` modifier before class (verified, not just asserted)", () => {
    expect(countDeclarationForms("abstract class X {}", "X")).toBe(1);
    expect(countDeclarationForms("export abstract class X {}", "X")).toBe(1);
  });

  it("counts a declare-ambient function declaration", () => {
    expect(countDeclarationForms("declare function X(): void;", "X")).toBe(1);
  });

  // PR #2334 R1 review, genuine finding: without stripping comments/strings first, a
  // doc-comment or string/template literal that merely QUOTES a declaration-shaped excerpt
  // inflated the count — dangerous because inflation only ever moves toward PRESERVING
  // BLOCKING (declarationCount > 1), i.e. toward keeping a false claim posted. Fixed via
  // stripCommentsAndStrings; these are the regression tests for that fix.
  it("does not count a declaration-shaped excerpt quoted inside a comment", () => {
    const content = ["/**", " * Example: const FOO = 1;", " */", "const FOO = 1;"].join("\n");
    expect(countDeclarationForms(content, "FOO")).toBe(1);
  });

  it("does not count a declaration-shaped excerpt quoted inside a string or template literal", () => {
    const stringContent = 'const msg = "const FOO = 1; const FOO = 2;"; const FOO = 1;';
    expect(countDeclarationForms(stringContent, "FOO")).toBe(1);

    const templateContent = "const X = `const FOO = 1;`;\nconst FOO = 1;";
    expect(countDeclarationForms(templateContent, "FOO")).toBe(1);
  });

  it("does not partial-match a longer identifier that shares a prefix", () => {
    const content = "const FOO_BAR_EXTENDED = 1;";
    expect(countDeclarationForms(content, "FOO_BAR")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// extractDeclaredIdentifiers / extractDuplicateDeclarationClaim
// ---------------------------------------------------------------------------

describe("extractDeclaredIdentifiers", () => {
  it("extracts an identifier from an embedded declaration-shaped excerpt", () => {
    const text = `The file defines \`const ${ID_1} = "## Does NOT cover";\` twice.`;
    expect(extractDeclaredIdentifiers(text)).toEqual([ID_1]);
  });

  it("does NOT extract a bare backtick-quoted identifier used only as a lexical anchor", () => {
    // "after `const OTHER_NAME`)" has no trailing "=" — it is a location reference,
    // not a declaration excerpt. This is exactly the shape that caused the original
    // incident's finding to name the wrong identifier when naively extracted.
    const text = "occurs earlier in the file (near the top, after `const OTHER_NAME`), and...";
    expect(extractDeclaredIdentifiers(text)).toEqual([]);
  });

  it("dedupes repeated mentions of the same identifier", () => {
    const text = [
      `declares \`const ${ID_2} = ...\``,
      `and re-declares \`const ${ID_2} = ...\` again`,
    ].join(" ");
    expect(extractDeclaredIdentifiers(text)).toEqual([ID_2]);
  });
});

describe("extractDuplicateDeclarationClaim", () => {
  it("returns null when no duplicate-marker trigger phrase is present", () => {
    const result = extractDuplicateDeclarationClaim(
      "const FOO = 1 is fine",
      "no issue here, just a mention of `const FOO = 1;`"
    );
    expect(result).toBeNull();
  });

  it("returns null when zero identifiers can be extracted", () => {
    const result = extractDuplicateDeclarationClaim(
      "Duplicate declaration detected",
      "Something is declared twice but no code excerpt is quoted."
    );
    expect(result).toBeNull();
  });

  it("returns null when multiple distinct identifiers are extracted (ambiguous)", () => {
    const result = extractDuplicateDeclarationClaim(
      "Duplicate declaration",
      "Both `const FOO = 1;` and `const BAR = 2;` are declared twice."
    );
    expect(result).toBeNull();
  });

  it("returns the single identifier for a real duplicate-identifier claim", () => {
    const result = extractDuplicateDeclarationClaim(
      DUPLICATE_IDENTIFIER_ERROR_SUMMARY,
      "The file defines `const FOO_BAR = 1;` twice, causing a duplicate-identifier error."
    );
    expect(result).toBe("FOO_BAR");
  });

  it("matches a non-breaking-hyphen dash variant in the trigger phrase (observed GPT-5 output)", () => {
    // U+2011 NON-BREAKING HYPHEN, as observed in production reviewer output.
    const result = extractDuplicateDeclarationClaim(
      "Duplicate ‑identifier issue",
      "The file defines `const FOO_BAR = 1;` twice, a TypeScript duplicate‑identifier error."
    );
    expect(result).toBe("FOO_BAR");
  });
});

// ---------------------------------------------------------------------------
// applyStructuralClaimVerification — the pure demotion pass
// ---------------------------------------------------------------------------

describe("applyStructuralClaimVerification", () => {
  // Real PR #2325 finding text (mt#2575 instance 5 / mt#3245 origin), lightly
  // ASCII-normalized (ellipsis and non-breaking hyphens replaced with ASCII
  // equivalents) — all matching-relevant structure (the backtick-quoted
  // declaration excerpt with "=", the backtick-quoted lexical anchor WITHOUT
  // "=", and the trigger phrasing) is preserved verbatim.
  const R1_SUMMARY =
    "Duplicate carve-out test block and constant re-declaration create TypeScript duplicate-identifier error";
  const R1_DETAILS = [
    `The file defines \`const ${ID_1} = "## Does NOT cover";\` twice and`,
    "appears to include the entire mt#3217 carve-out describe block twice. The first",
    "declaration occurs earlier in the file (near the top, after `const",
    "PRE_EXISTING_MOVE_MIGRATION_PHRASE`), and a second identical declaration is present",
    'again starting around this added block (`describe(\'carve-out ("Does NOT cover") spec',
    "verification instruction (mt#3217)', ...)`). Duplicate top-level `const` identifiers in",
    "the same module will cause a TypeScript compile-time error and will fail `bun",
    "test`/typechecking. Additionally, duplicating the whole describe suite doubles test",
    "definitions and increases brittleness.",
  ].join(" ");

  const R2_SUMMARY = [
    `Duplicate \`${ID_2}\` constant and duplicated carve-out describe block -`,
    "TypeScript duplicate-identifier error and doubled tests",
  ].join(" ");
  const R2_DETAILS = [
    `The file defines \`const ${ID_2} = ...;\` twice - once in the first`,
    "carve-out describe block (mt#3217) and again in a second, duplicated carve-out",
    "describe block near the end of the file. Duplicate top-level `const` identifiers in",
    "the same module will cause a TypeScript duplicate-identifier error at compile time,",
    "breaking `bun test`/typechecking. The duplicated describe suite also doubles the",
    "same tests, increasing brittleness and runtime. Evidence: the block declares `const",
    `${ID_2} = ...\` and a second, duplicated block re-declares \`const`,
    `${ID_2} = ...\` again - creating a duplicate identifier.`,
  ].join(" ");

  it("AT1: replays PR #2325 R1 (DOES_NOT_COVER_H2_HEADING) — demoted, reason recorded", () => {
    // Actual current file content: ONE declaration, ONE usage ~1400 lines away — the
    // exact shape that fooled the reviewer into counting occurrences as declarations.
    const fileContent = [
      `const ${ID_1} = "## Does NOT cover";`,
      ...Array(1388).fill("// filler line"),
      `expect(prompt).toContain(${ID_1}); // usage, not a declaration`,
    ].join("\n");

    const toolCalls: ReviewToolCall[] = [blockingFinding(TEST_FILE, R1_SUMMARY, R1_DETAILS)];
    const result = applyStructuralClaimVerification(toolCalls, new Map([[TEST_FILE, fileContent]]));

    expect(result.downgrades).toHaveLength(1);
    expect(asDeclarationEntry(result.downgrades[0]).identifier).toBe(ID_1);
    expect(asDeclarationEntry(result.downgrades[0]).declarationCount).toBe(1);
    expect(result.downgrades[0]?.reason).toContain("structural-claim-verification");
    const finding = result.toolCalls[0];
    expect(finding?.name).toBe("submit_finding");
    if (finding?.name === "submit_finding") {
      expect(finding.args.severity).toBe("NON-BLOCKING");
      expect(finding.args.summary).toContain("[duplicate-declaration-unverified]");
      expect(finding.args.details).toContain("structural-claim-verification");
    }
  });

  it("AT1: replays PR #2325 R2 (MT3001_SPEC_EXCERPT) — demoted, reason recorded", () => {
    const fileContent = [
      `const ${ID_2} = \`## Covers\\n...\\n## Does NOT cover\\n...\`;`,
      ...Array(20).fill("// filler line"),
      `expect(prompt).toContain(${ID_2}); // usage, not a declaration`,
    ].join("\n");

    const toolCalls: ReviewToolCall[] = [
      blockingFinding(TEST_FILE, R2_SUMMARY, R2_DETAILS, { line: 1406 }),
    ];
    const result = applyStructuralClaimVerification(toolCalls, new Map([[TEST_FILE, fileContent]]));

    expect(result.downgrades).toHaveLength(1);
    expect(asDeclarationEntry(result.downgrades[0]).identifier).toBe(ID_2);
    expect(asDeclarationEntry(result.downgrades[0]).declarationCount).toBe(1);
    const finding = result.toolCalls[0];
    if (finding?.name === "submit_finding") {
      expect(finding.args.severity).toBe("NON-BLOCKING");
    } else {
      throw new Error("expected a submit_finding tool call");
    }
  });

  it("preserves BLOCKING for a genuinely duplicated identifier (recall guard)", () => {
    const seededDetails =
      "The file defines `const REAL_DUPLICATE = 1;` twice - this will cause a TypeScript " +
      "duplicate-identifier compile error.";
    const fileContent = [
      "const REAL_DUPLICATE = 1;",
      "// ... later in the same file ...",
      "const REAL_DUPLICATE = 2; // genuinely re-declared",
    ].join("\n");

    const toolCalls: ReviewToolCall[] = [
      blockingFinding(TEST_FILE, DUPLICATE_IDENTIFIER_ERROR_SUMMARY, seededDetails),
    ];
    const result = applyStructuralClaimVerification(toolCalls, new Map([[TEST_FILE, fileContent]]));

    expect(result.downgrades).toHaveLength(0);
    expect(result.toolCalls).toEqual(toolCalls);
  });

  it("leaves an unrelated finding class untouched (design/correctness)", () => {
    const toolCalls: ReviewToolCall[] = [
      blockingFinding(
        "src/domain/foo.ts",
        "Off-by-one error in loop bound",
        "The loop uses `<=` where `<` is correct, causing an extra iteration."
      ),
      nonBlockingFinding("src/domain/bar.ts", "Consider renaming", "Minor naming nit."),
      specVerification("Feature X works", "Met"),
    ];
    const result = applyStructuralClaimVerification(toolCalls, new Map());

    expect(result.downgrades).toHaveLength(0);
    expect(result.toolCalls).toEqual(toolCalls);
  });

  it("leaves the finding untouched when the file's current content could not be fetched", () => {
    const toolCalls: ReviewToolCall[] = [blockingFinding(TEST_FILE, R1_SUMMARY, R1_DETAILS)];
    // File not present in the map at all (fetch failed / 404).
    const result = applyStructuralClaimVerification(toolCalls, new Map());

    expect(result.downgrades).toHaveLength(0);
    expect(result.toolCalls).toEqual(toolCalls);
  });

  it("leaves the finding untouched when the map explicitly records null (fetch failed)", () => {
    const toolCalls: ReviewToolCall[] = [blockingFinding(TEST_FILE, R1_SUMMARY, R1_DETAILS)];
    const result = applyStructuralClaimVerification(toolCalls, new Map([[TEST_FILE, null]]));

    expect(result.downgrades).toHaveLength(0);
    expect(result.toolCalls).toEqual(toolCalls);
  });
});

// ---------------------------------------------------------------------------
// fetchAndApplyStructuralClaimVerification — the async I/O wrapper
// ---------------------------------------------------------------------------

/** Small standalone duplicate-declaration details excerpt for the async-wrapper tests below. */
function detailsExcerpt(): string {
  return `The file defines \`const ${ID_1} = "## Does NOT cover";\` twice, a duplicate-identifier error.`;
}

describe("fetchAndApplyStructuralClaimVerification", () => {
  it("never calls the fetcher when no finding makes a duplicate-declaration claim", async () => {
    let calls = 0;
    const toolCalls: ReviewToolCall[] = [
      blockingFinding(
        "src/domain/foo.ts",
        "Off-by-one error",
        "Unrelated correctness issue, no duplicate claim here."
      ),
      specVerification("Feature X works", "Met"),
    ];
    const result = await fetchAndApplyStructuralClaimVerification(toolCalls, async () => {
      calls++;
      return null;
    });

    expect(calls).toBe(0);
    expect(result.downgrades).toHaveLength(0);
    expect(result.toolCalls).toEqual(toolCalls);
  });

  it("fetches only the files a duplicate-declaration claim cites and demotes correctly", async () => {
    const fileContent = `const ${ID_1} = "## Does NOT cover";\n${"// usage far below\n".repeat(50)}expect(prompt).toContain(${ID_1});`;
    const fetched: string[] = [];

    const toolCalls: ReviewToolCall[] = [
      blockingFinding(TEST_FILE, DUPLICATE_IDENTIFIER_ERROR_SUMMARY, detailsExcerpt()),
      specVerification("Unrelated criterion", "Met"),
    ];
    const result = await fetchAndApplyStructuralClaimVerification(toolCalls, async (path) => {
      fetched.push(path);
      return fileContent;
    });

    expect(fetched).toEqual([TEST_FILE]);
    expect(result.downgrades).toHaveLength(1);
    expect(asDeclarationEntry(result.downgrades[0]).identifier).toBe(ID_1);
  });

  it("treats a thrown fetcher error as unfetchable and preserves BLOCKING", async () => {
    const toolCalls: ReviewToolCall[] = [
      blockingFinding(TEST_FILE, DUPLICATE_IDENTIFIER_ERROR_SUMMARY, detailsExcerpt()),
    ];
    const result = await fetchAndApplyStructuralClaimVerification(toolCalls, async () => {
      throw new Error("network error");
    });

    expect(result.downgrades).toHaveLength(0);
    expect(result.toolCalls).toEqual(toolCalls);
  });
});

// ---------------------------------------------------------------------------
// duplicate-SECTION class (mt#3520 — mt#2575 instance 6, PR #2498)
// ---------------------------------------------------------------------------

const SKILL_SOURCE_FILE = ".minsky/skills/plan-task/skill.ts";
const GATE_P_HEADING = "#### Gate criterion (p) — First-party decision-record check";
const STEP_4_HEADING = "### Step 4: Act on gate results";

/**
 * The real R1 finding from PR #2498 (review 4832326740), reconstructed from its posted text.
 * Note it quotes TWO headings — the one it claims is duplicated AND a neighbouring landmark —
 * which is why the section class verifies the whole quoted set rather than demanding exactly one.
 */
const PR2498_SUMMARY =
  "Gate (p) section is duplicated in the source skill (appears twice), breaking the " +
  "append-only manifest and tests";
const PR2498_DETAILS = [
  `The heading \`${GATE_P_HEADING}\` appears twice in \`${SKILL_SOURCE_FILE}\`:`,
  "once immediately after gate (o) and again later before the",
  `\`${STEP_4_HEADING}\` section repeats.`,
  "This duplication violates the append-only gate-letter manifest and will cause",
  "parseGates to return two (p) entries.",
].join(" ");

/** The section claim class, named once (custom/no-magic-string-duplication). */
const DUPLICATE_SECTION_CLASS = "duplicate-section";

/**
 * A skill source in this repo carries its whole markdown body inside a TypeScript template
 * literal, so the headings below live INSIDE a string — the shape that makes
 * `stripCommentsAndStrings` the wrong pre-pass for this class.
 */
function skillSourceContent(gatePHeadingLines: string[]): string {
  return [
    'import { defineSkill } from "../../../packages/domain/src/definitions/factories";',
    "",
    "export default defineSkill({",
    '  name: "plan-task",',
    "  content: `",
    "#### Gate criterion (o) — Problem-statement verification",
    "",
    "Prose about gate (o).",
    "",
    ...gatePHeadingLines,
    "",
    STEP_4_HEADING,
    "",
    "Prose about step 4.",
    "`,",
    "});",
  ].join("\n");
}

const SOURCE_WITH_ONE_GATE_P = skillSourceContent([GATE_P_HEADING, "", "Prose about gate (p)."]);
const SOURCE_WITH_TWO_GATE_P = skillSourceContent([
  GATE_P_HEADING,
  "",
  "Prose about gate (p).",
  "",
  GATE_P_HEADING,
  "",
  "An actual duplicate.",
]);

describe("countHeadingOccurrences", () => {
  it("counts a heading that lives inside a TypeScript template literal", () => {
    expect(countHeadingOccurrences(SOURCE_WITH_ONE_GATE_P, GATE_P_HEADING)).toBe(1);
    expect(countHeadingOccurrences(SOURCE_WITH_ONE_GATE_P, STEP_4_HEADING)).toBe(1);
  });

  it("counts 2 when the heading genuinely repeats", () => {
    expect(countHeadingOccurrences(SOURCE_WITH_TWO_GATE_P, GATE_P_HEADING)).toBe(2);
  });

  it("does not count prose that mentions the heading text without the # prefix", () => {
    const content = ["Gate criterion (p) — First-party decision-record check", "", "prose"].join(
      "\n"
    );
    expect(countHeadingOccurrences(content, GATE_P_HEADING)).toBe(0);
  });

  it("normalizes dash variants and extra whitespace on both sides", () => {
    const asciiHyphenClaim = "####  Gate criterion (p) - First-party decision-record check";
    expect(countHeadingOccurrences(SOURCE_WITH_ONE_GATE_P, asciiHyphenClaim)).toBe(1);
  });
});

describe("extractQuotedHeadings / extractDuplicateSectionClaim", () => {
  it("extracts both headings quoted by the real PR #2498 finding", () => {
    const headings = extractQuotedHeadings(`${PR2498_SUMMARY}\n${PR2498_DETAILS}`);
    expect(headings).toHaveLength(2);
    expect(headings[0]).toContain("Gate criterion (p)");
    expect(headings[1]).toContain("Step 4");
  });

  it("returns the quoted headings for a duplicate-section claim", () => {
    expect(extractDuplicateSectionClaim(PR2498_SUMMARY, PR2498_DETAILS)).toHaveLength(2);
  });

  it("returns null when no trigger phrase is present", () => {
    const details = `The heading \`${GATE_P_HEADING}\` is well written and clear.`;
    expect(extractDuplicateSectionClaim("Nice heading", details)).toBeNull();
  });

  it("returns null when the claim quotes no heading", () => {
    expect(
      extractDuplicateSectionClaim("Duplicate section detected", "Something appears twice here.")
    ).toBeNull();
  });
});

describe("extractStructuralClaim dispatch", () => {
  it("routes a declaration-shaped finding to the declaration class even when it says 'appears twice'", () => {
    const claim = extractStructuralClaim(
      DUPLICATE_IDENTIFIER_ERROR_SUMMARY,
      `The identifier appears twice: \`const ${ID_1} = "x";\``
    );
    expect(claim?.claimClass).toBe("duplicate-declaration");
    expect(claim?.subjects).toEqual([ID_1]);
  });

  it("routes a heading-shaped finding to the section class", () => {
    const claim = extractStructuralClaim(PR2498_SUMMARY, PR2498_DETAILS);
    expect(claim?.claimClass).toBe(DUPLICATE_SECTION_CLASS);
    expect(claim?.subjects).toHaveLength(2);
  });
});

describe("applyStructuralClaimVerification — duplicate-section class", () => {
  it("demotes the real PR #2498 finding when every quoted heading appears once", () => {
    const toolCalls: ReviewToolCall[] = [
      blockingFinding(SKILL_SOURCE_FILE, PR2498_SUMMARY, PR2498_DETAILS, { line: 882 }),
    ];
    const result = applyStructuralClaimVerification(
      toolCalls,
      new Map([[SKILL_SOURCE_FILE, SOURCE_WITH_ONE_GATE_P]])
    );

    expect(result.downgrades).toHaveLength(1);
    const entry = asSectionEntry(result.downgrades[0]);
    expect(entry.file).toBe(SKILL_SOURCE_FILE);
    expect(entry.headings).toHaveLength(2);
    expect(entry.headings.every((h) => h.occurrenceCount === 1)).toBe(true);

    const finding = result.toolCalls[0];
    expect(finding?.name).toBe("submit_finding");
    if (finding?.name === "submit_finding") {
      expect(finding.args.severity).toBe("NON-BLOCKING");
      expect(finding.args.summary).toContain("[duplicate-section-unverified]");
    }
  });

  it("preserves BLOCKING when one quoted heading genuinely appears twice", () => {
    const toolCalls: ReviewToolCall[] = [
      blockingFinding(SKILL_SOURCE_FILE, PR2498_SUMMARY, PR2498_DETAILS, { line: 882 }),
    ];
    const result = applyStructuralClaimVerification(
      toolCalls,
      new Map([[SKILL_SOURCE_FILE, SOURCE_WITH_TWO_GATE_P]])
    );

    expect(result.downgrades).toHaveLength(0);
    expect(result.toolCalls).toEqual(toolCalls);
  });

  it("preserves BLOCKING when the file content is unavailable", () => {
    const toolCalls: ReviewToolCall[] = [
      blockingFinding(SKILL_SOURCE_FILE, PR2498_SUMMARY, PR2498_DETAILS, { line: 882 }),
    ];
    const result = applyStructuralClaimVerification(
      toolCalls,
      new Map([[SKILL_SOURCE_FILE, null]])
    );

    expect(result.downgrades).toHaveLength(0);
    expect(result.toolCalls).toEqual(toolCalls);
  });

  it("leaves a NON-BLOCKING duplicate-section finding untouched", () => {
    const toolCalls: ReviewToolCall[] = [
      nonBlockingFinding(SKILL_SOURCE_FILE, PR2498_SUMMARY, PR2498_DETAILS),
    ];
    const result = applyStructuralClaimVerification(
      toolCalls,
      new Map([[SKILL_SOURCE_FILE, SOURCE_WITH_ONE_GATE_P]])
    );

    expect(result.downgrades).toHaveLength(0);
    expect(result.toolCalls).toEqual(toolCalls);
  });

  it("fetches the cited file for a section claim and demotes end-to-end", async () => {
    const toolCalls: ReviewToolCall[] = [
      blockingFinding(SKILL_SOURCE_FILE, PR2498_SUMMARY, PR2498_DETAILS, { line: 882 }),
      specVerification("gate letters remain append-only", "Met"),
    ];
    const fetched: string[] = [];
    const result = await fetchAndApplyStructuralClaimVerification(toolCalls, async (path) => {
      fetched.push(path);
      return SOURCE_WITH_ONE_GATE_P;
    });

    expect(fetched).toEqual([SKILL_SOURCE_FILE]);
    expect(result.downgrades).toHaveLength(1);
    expect(asSectionEntry(result.downgrades[0]).claimClass).toBe(DUPLICATE_SECTION_CLASS);
  });
});

// ---------------------------------------------------------------------------
// missing-subject class (mt#4042) — an absence claim disproven by presence
// ---------------------------------------------------------------------------

/**
 * Narrow an audit entry to the missing-subject variant, mirroring the two helpers above.
 */
function asMissingSubjectEntry(
  entry: StructuralClaimDowngradeAuditEntry | undefined
): MissingSubjectDowngradeAuditEntry {
  expect(entry?.claimClass).toBe("missing-subject");
  return entry as MissingSubjectDowngradeAuditEntry;
}

const DETECTOR_DOC_FILE = "docs/architecture/hooks/flakiness-control-detector.md";
const RULE_BARE_NAME = "hook-observers.mdc";
const RULE_REAL_PATH = ".minsky/rules/hook-observers.mdc";
const RULE_COMPILED_PATH = ".cursor/rules/hook-observers.mdc";
const RULE_CONSTRUCTED_PATH = "docs/architecture/hook-observers.mdc";

/**
 * VERBATIM from PR #2909's R4 review (2026-08-12), the originating incident. Copied rather than
 * paraphrased on purpose: mt#3520 recorded that a paraphrased fixture would have skipped its own
 * originating finding, because the real text names more subjects than a summary of it does.
 */
const PR2909_SUMMARY = "Index entry missing in hook-observers.mdc as required by the spec";
const PR2909_DETAILS = [
  "The spec's Success Criteria require “The detector is documented in `hook-observers.mdc`",
  "alongside its siblings, and the source rule is recompiled in the same PR.” This new doc",
  "file's header claims an index entry exists — “Index entry: `hook-observers.mdc`.”",
  "However, there is no `docs/architecture/hook-observers.mdc` file in the repo",
  "(`read_file: not_found`), and the `docs/architecture/hooks/` directory listing contains no",
  "`hook-observers.mdc` either. Evidence:",
  "",
  "- `docs/architecture/hook-observers.mdc` — not found (read attempt failed with `not_found`).",
].join("\n");

/** The repo tree as it actually stood at PR #2909's head e507968d, for the two rule paths. */
const TREE_AT_PR2909_HEAD = [
  ".minsky/rules/hook-observers.mdc",
  ".cursor/rules/hook-observers.mdc",
  "docs/architecture/hooks/flakiness-control-detector.md",
  "CLAUDE.md",
];

describe("extractMissingSubjectClaim", () => {
  it("extracts both the bare name and the constructed path from the real PR #2909 finding", () => {
    expect(extractMissingSubjectClaim(PR2909_SUMMARY, PR2909_DETAILS)).toEqual([
      RULE_BARE_NAME,
      RULE_CONSTRUCTED_PATH,
    ]);
  });

  it("returns null without a trigger phrase, even when a file is quoted", () => {
    expect(
      extractMissingSubjectClaim("Style nit", "Consider renaming `src/foo/bar.ts` for clarity.")
    ).toBeNull();
  });

  it("returns null when the trigger fires but nothing file-shaped is quoted", () => {
    expect(
      extractMissingSubjectClaim(
        "Permission missing",
        "The App does not hold `checks:write`, so `read_file` is not present in the tool set."
      )
    ).toBeNull();
  });

  it("does not treat a quoted directory as a file reference", () => {
    expect(
      extractMissingSubjectClaim("Missing", "The `docs/architecture/hooks/` listing has no entry.")
    ).toBeNull();
  });
});

describe("matchPathsForFileRef", () => {
  it("resolves a bare filename by basename anywhere in the tree", () => {
    expect(matchPathsForFileRef(RULE_BARE_NAME, TREE_AT_PR2909_HEAD)).toEqual([
      RULE_REAL_PATH,
      RULE_COMPILED_PATH,
    ]);
  });

  it("takes an explicit path at face value and does not fall back to basename", () => {
    expect(matchPathsForFileRef(RULE_CONSTRUCTED_PATH, TREE_AT_PR2909_HEAD)).toEqual([]);
  });

  it("matches a root-level file with no directory prefix", () => {
    expect(matchPathsForFileRef("CLAUDE.md", TREE_AT_PR2909_HEAD)).toEqual(["CLAUDE.md"]);
  });

  it("does not match a suffix that is not a path segment boundary", () => {
    expect(matchPathsForFileRef("observers.mdc", TREE_AT_PR2909_HEAD)).toEqual([]);
  });
});

describe("applyStructuralClaimVerification — missing-subject class", () => {
  it("demotes the real PR #2909 finding once the bare name resolves", () => {
    const toolCalls: ReviewToolCall[] = [
      blockingFinding(DETECTOR_DOC_FILE, PR2909_SUMMARY, PR2909_DETAILS, { line: 1 }),
    ];
    const resolved = new Map<string, readonly string[]>([
      [RULE_BARE_NAME, [RULE_REAL_PATH, RULE_COMPILED_PATH]],
      [RULE_CONSTRUCTED_PATH, []],
    ]);

    const result = applyStructuralClaimVerification(toolCalls, new Map(), resolved);

    const finding = result.toolCalls[0];
    expect(finding?.name).toBe("submit_finding");
    if (finding?.name !== "submit_finding") throw new Error("expected submit_finding");
    expect(finding.args.severity).toBe("NON-BLOCKING");
    expect(finding.args.summary).toContain("[missing-subject-unverified]");
    expect(finding.args.details).toContain(RULE_REAL_PATH);

    const entry = asMissingSubjectEntry(result.downgrades[0]);
    expect(entry.subjects).toEqual([
      { subject: RULE_BARE_NAME, resolvedPaths: [RULE_REAL_PATH, RULE_COMPILED_PATH] },
      { subject: RULE_CONSTRUCTED_PATH, resolvedPaths: [] },
    ]);
  });

  it("preserves BLOCKING when no quoted subject resolves (the claim may be true)", () => {
    const toolCalls: ReviewToolCall[] = [
      blockingFinding(DETECTOR_DOC_FILE, PR2909_SUMMARY, PR2909_DETAILS, { line: 1 }),
    ];
    const resolved = new Map<string, readonly string[]>([
      [RULE_BARE_NAME, []],
      [RULE_CONSTRUCTED_PATH, []],
    ]);

    const result = applyStructuralClaimVerification(toolCalls, new Map(), resolved);

    expect(result.downgrades).toHaveLength(0);
    expect(result.toolCalls).toEqual(toolCalls);
  });

  it("preserves BLOCKING when the resolver never ran (no entry in the map)", () => {
    const toolCalls: ReviewToolCall[] = [
      blockingFinding(DETECTOR_DOC_FILE, PR2909_SUMMARY, PR2909_DETAILS, { line: 1 }),
    ];

    const result = applyStructuralClaimVerification(toolCalls, new Map());

    expect(result.downgrades).toHaveLength(0);
    expect(result.toolCalls).toEqual(toolCalls);
  });

  it("leaves a NON-BLOCKING absence finding alone", () => {
    const toolCalls: ReviewToolCall[] = [
      nonBlockingFinding(DETECTOR_DOC_FILE, PR2909_SUMMARY, PR2909_DETAILS),
    ];
    const resolved = new Map<string, readonly string[]>([[RULE_BARE_NAME, [RULE_REAL_PATH]]]);

    const result = applyStructuralClaimVerification(toolCalls, new Map(), resolved);

    expect(result.downgrades).toHaveLength(0);
    expect(result.toolCalls).toEqual(toolCalls);
  });
});

describe("fetchAndApplyStructuralClaimVerification — missing-subject wiring", () => {
  it("resolves each quoted subject against the listing and demotes end-to-end", async () => {
    const toolCalls: ReviewToolCall[] = [
      blockingFinding(DETECTOR_DOC_FILE, PR2909_SUMMARY, PR2909_DETAILS, { line: 1 }),
    ];
    const asked: string[] = [];

    const result = await fetchAndApplyStructuralClaimVerification(
      toolCalls,
      async () => {
        throw new Error("the content fetcher must not be called for a missing-subject claim");
      },
      async (fileRef) => {
        asked.push(fileRef);
        return matchPathsForFileRef(fileRef, TREE_AT_PR2909_HEAD);
      }
    );

    expect(asked).toEqual([RULE_BARE_NAME, RULE_CONSTRUCTED_PATH]);
    expect(result.downgrades).toHaveLength(1);
    expect(asMissingSubjectEntry(result.downgrades[0]).file).toBe(DETECTOR_DOC_FILE);
  });

  it("preserves BLOCKING when the resolver throws", async () => {
    const toolCalls: ReviewToolCall[] = [
      blockingFinding(DETECTOR_DOC_FILE, PR2909_SUMMARY, PR2909_DETAILS, { line: 1 }),
    ];

    const result = await fetchAndApplyStructuralClaimVerification(
      toolCalls,
      async () => null,
      async () => {
        throw new Error("tree listing unavailable");
      }
    );

    expect(result.downgrades).toHaveLength(0);
    expect(result.toolCalls).toEqual(toolCalls);
  });

  it("never fires the class when no resolver is supplied", async () => {
    const toolCalls: ReviewToolCall[] = [
      blockingFinding(DETECTOR_DOC_FILE, PR2909_SUMMARY, PR2909_DETAILS, { line: 1 }),
    ];

    const result = await fetchAndApplyStructuralClaimVerification(toolCalls, async () => null);

    expect(result.downgrades).toHaveLength(0);
    expect(result.toolCalls).toEqual(toolCalls);
  });
});
