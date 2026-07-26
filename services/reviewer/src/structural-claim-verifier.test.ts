import { describe, it, expect } from "bun:test";
import {
  countDeclarationForms,
  extractDeclaredIdentifiers,
  extractDuplicateDeclarationClaim,
  applyStructuralClaimVerification,
  fetchAndApplyStructuralClaimVerification,
} from "./structural-claim-verifier";
import type { ReviewToolCall } from "./output-tools";

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
    expect(result.downgrades[0]?.identifier).toBe(ID_1);
    expect(result.downgrades[0]?.declarationCount).toBe(1);
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
    expect(result.downgrades[0]?.identifier).toBe(ID_2);
    expect(result.downgrades[0]?.declarationCount).toBe(1);
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
    expect(result.downgrades[0]?.identifier).toBe(ID_1);
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
