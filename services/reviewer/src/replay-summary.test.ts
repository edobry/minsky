/**
 * Unit tests for the pure helpers in replay-summary.ts.
 *
 * The aggregate helpers (buildAttemptResult, aggregateSummary) are exercised
 * indirectly by the replay scripts; this file pins down the severity-inflation
 * helpers added in mt#1465 (parseFindingsFromBody, detectSeverityInflation)
 * because they encode the diagnostic metric the replay corpus is measured on.
 */

import { describe, expect, test } from "bun:test";
import { detectSeverityInflation, parseFindingsFromBody, type FlatFinding } from "./replay-summary";

describe("parseFindingsFromBody", () => {
  test("returns empty array on empty body", () => {
    expect(parseFindingsFromBody("")).toEqual([]);
    expect(parseFindingsFromBody("   ")).toEqual([]);
  });

  test("parses single BLOCKING finding with file and line", () => {
    const body = "**[BLOCKING]** src/foo.ts:42 — bad thing";
    expect(parseFindingsFromBody(body)).toEqual([
      { file: "src/foo.ts", severity: "BLOCKING", line: 42 },
    ]);
  });

  test("parses NON-BLOCKING and PRE-EXISTING severities", () => {
    const body = "**[NON-BLOCKING]** src/a.ts:10 — nit\n**[PRE-EXISTING]** src/b.ts:20 — old issue";
    const findings = parseFindingsFromBody(body);
    expect(findings).toHaveLength(2);
    expect(findings[0]?.severity).toBe("NON-BLOCKING");
    expect(findings[1]?.severity).toBe("PRE-EXISTING");
  });

  test("parses finding without line number", () => {
    const body = "**[BLOCKING]** src/foo.ts — broad concern";
    expect(parseFindingsFromBody(body)).toEqual([{ file: "src/foo.ts", severity: "BLOCKING" }]);
  });

  test("parses multiple findings across multi-line body", () => {
    const body = `### Findings

- **[BLOCKING]** src/foo.ts:1 — first
- **[NON-BLOCKING]** src/bar.ts:2 — second
- **[BLOCKING]** docs/spec.md:3 — third
`;
    const findings = parseFindingsFromBody(body);
    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.file)).toEqual(["src/foo.ts", "src/bar.ts", "docs/spec.md"]);
  });

  test("ignores severity markers without a file path", () => {
    const body = "Conclusion: **[BLOCKING]** above are the issues.";
    expect(parseFindingsFromBody(body)).toEqual([]);
  });

  test("case-insensitive severity matching", () => {
    const body = "**[blocking]** src/foo.ts:1 — case test";
    expect(parseFindingsFromBody(body)).toEqual([
      { file: "src/foo.ts", severity: "BLOCKING", line: 1 },
    ]);
  });

  test("parses bare [SEVERITY] without bold wrappers (production format)", () => {
    // Real production reviewer-bot bodies (pre-mt#1395 prose path, also some
    // post-mt#1395 composed bodies) emit `[BLOCKING]` without surrounding `**`.
    const body =
      "Findings\n\n[BLOCKING] src/adapters/mcp/shared.ts:171-176 — over-broad guard\n[NON-BLOCKING] src/foo.ts:42 — minor nit\n[PRE-EXISTING] src/bar.ts:10 — old issue";
    const findings = parseFindingsFromBody(body);
    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.severity)).toEqual(["BLOCKING", "NON-BLOCKING", "PRE-EXISTING"]);
    expect(findings.map((f) => f.file)).toEqual([
      "src/adapters/mcp/shared.ts",
      "src/foo.ts",
      "src/bar.ts",
    ]);
  });

  test("parses line-range citations (171-176) into line + lineEnd (PR #920 R1#2)", () => {
    // Real bot bodies cite ranges, not single lines. Pre-PR-#920-R1 the
    // parser ran parseInt on the whole "171-176" capture, returning 171
    // and discarding the range — misleading false-precision data. Now both
    // ends are captured.
    const body = "[BLOCKING] src/foo.ts:171-176 — broad concern over multiple lines";
    const findings = parseFindingsFromBody(body);
    expect(findings).toEqual([
      { file: "src/foo.ts", severity: "BLOCKING", line: 171, lineEnd: 176 },
    ]);
  });

  test("single-line citations omit lineEnd (PR #920 R1#2)", () => {
    const body = "[BLOCKING] src/foo.ts:42 — single-line concern";
    const findings = parseFindingsFromBody(body);
    expect(findings).toEqual([{ file: "src/foo.ts", severity: "BLOCKING", line: 42 }]);
    // Explicit assertion that lineEnd is absent (not just undefined-via-spread).
    expect(findings[0]).not.toHaveProperty("lineEnd");
  });

  test("parses extensionless and dotfile paths (PR #920 R1#1)", () => {
    // Pre-PR-#920-R1 the file regex required a literal dot-extension,
    // silently dropping Dockerfile, Makefile, .env, .gitignore, etc.
    const body = [
      "[BLOCKING] Dockerfile:12 — security issue",
      "[NON-BLOCKING] Makefile:5 — minor target",
      "[BLOCKING] .env:1 — leaked secret",
      "[NON-BLOCKING] .eslintrc.json:3 — config drift",
      "[BLOCKING] LICENSE — license incompatibility",
    ].join("\n");
    const findings = parseFindingsFromBody(body);
    expect(findings.map((f) => f.file)).toEqual([
      "Dockerfile",
      "Makefile",
      ".env",
      ".eslintrc.json",
      "LICENSE",
    ]);
  });

  test("rejects one-sided bold wrappers (PR #920 R1)", () => {
    // Same balance enforcement as mt#1486: stray `**[BLOCKING]` (no close)
    // or `[BLOCKING]**` (no open) must NOT be parsed as findings.
    const body = "**[BLOCKING] src/foo.ts:42 — stray open\n[BLOCKING]** src/bar.ts:5 — stray close";
    expect(parseFindingsFromBody(body)).toEqual([]);
  });

  test("parses ASCII hyphen separator (PR #920 R2)", () => {
    // Real bodies may use ASCII '-' instead of em-dash due to typing
    // variation or Markdown rendering. Pre-PR-#920-R2 the regex hardcoded
    // U+2014 em-dash and missed these.
    const body = "[BLOCKING] src/foo.ts:42 - bad thing\n[BLOCKING] LICENSE - incompatible terms";
    const findings = parseFindingsFromBody(body);
    expect(findings).toHaveLength(2);
    expect(findings[0]?.file).toBe("src/foo.ts");
    expect(findings[1]?.file).toBe("LICENSE");
  });

  test("parses en-dash separator (PR #920 R2)", () => {
    const body = "[BLOCKING] src/foo.ts:42 – en-dash variant";
    expect(parseFindingsFromBody(body)).toEqual([
      { file: "src/foo.ts", severity: "BLOCKING", line: 42 },
    ]);
  });

  test("preserves ASCII hyphens inside path names (PR #920 R2)", () => {
    // task-spec-fetch.ts is a common shape; the dash-boundary alternative
    // requires whitespace around the dash to disambiguate from path-internal
    // hyphens.
    const body = "[BLOCKING] services/reviewer/src/task-spec-fetch.ts:42 — broken";
    expect(parseFindingsFromBody(body)).toEqual([
      {
        file: "services/reviewer/src/task-spec-fetch.ts",
        severity: "BLOCKING",
        line: 42,
      },
    ]);
  });

  test("parses with bullet/list prefix (PR #920 R2)", () => {
    const body =
      "- [BLOCKING] src/foo.ts:1 — bulleted finding\n* **[BLOCKING]** src/bar.ts:5 — asterisk bullet";
    const findings = parseFindingsFromBody(body);
    expect(findings).toHaveLength(2);
    expect(findings[0]?.file).toBe("src/foo.ts");
    expect(findings[1]?.file).toBe("src/bar.ts");
  });

  test("does NOT match incidental mid-line [BLOCKING] in prose (PR #920 R2)", () => {
    // Pre-PR-#920-R2 the regex matched [BLOCKING] anywhere on the line.
    // Now: anchored to start-of-line (with optional bullet).
    const body = "narrative paragraph mentions [BLOCKING] tag in passing — text";
    expect(parseFindingsFromBody(body)).toEqual([]);
  });
});

describe("detectSeverityInflation", () => {
  test("returns zero counts when current attempt has no findings", () => {
    const result = detectSeverityInflation([], []);
    expect(result.currentBlockingCount).toBe(0);
    expect(result.inflatedFindings).toEqual([]);
    expect(result.inflationRate).toBe(0);
  });

  test("returns zero inflation when prior reviews are empty", () => {
    const current: FlatFinding[] = [{ file: "src/foo.ts", severity: "BLOCKING" }];
    const result = detectSeverityInflation(current, []);
    expect(result.currentBlockingCount).toBe(1);
    expect(result.inflatedFindings).toEqual([]);
    expect(result.inflationRate).toBe(0);
  });

  test("flags BLOCKING when prior review had NON-BLOCKING on same file", () => {
    const prior: FlatFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 10 }];
    const current: FlatFinding[] = [{ file: "src/foo.ts", severity: "BLOCKING", line: 42 }];
    const result = detectSeverityInflation(current, prior);
    expect(result.inflatedFindings).toEqual([
      { file: "src/foo.ts", severity: "BLOCKING", line: 42 },
    ]);
    expect(result.inflationRate).toBe(1);
  });

  test("flags BLOCKING when prior review had PRE-EXISTING on same file", () => {
    const prior: FlatFinding[] = [{ file: "src/foo.ts", severity: "PRE-EXISTING" }];
    const current: FlatFinding[] = [{ file: "src/foo.ts", severity: "BLOCKING" }];
    const result = detectSeverityInflation(current, prior);
    expect(result.inflatedFindings).toHaveLength(1);
    expect(result.inflationRate).toBe(1);
  });

  test("does not flag BLOCKING when prior review also had BLOCKING on same file", () => {
    const prior: FlatFinding[] = [{ file: "src/foo.ts", severity: "BLOCKING" }];
    const current: FlatFinding[] = [{ file: "src/foo.ts", severity: "BLOCKING" }];
    const result = detectSeverityInflation(current, prior);
    expect(result.inflatedFindings).toEqual([]);
    expect(result.inflationRate).toBe(0);
  });

  test("does not count NON-BLOCKING findings in the current attempt", () => {
    const prior: FlatFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING" }];
    const current: FlatFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING" }];
    const result = detectSeverityInflation(current, prior);
    expect(result.currentBlockingCount).toBe(0);
    expect(result.inflatedFindings).toEqual([]);
    expect(result.inflationRate).toBe(0);
  });

  test("partial inflation: 1 of 2 current BLOCKING findings is inflated", () => {
    const prior: FlatFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING" }];
    const current: FlatFinding[] = [
      { file: "src/foo.ts", severity: "BLOCKING" }, // inflated
      { file: "src/bar.ts", severity: "BLOCKING" }, // genuinely new, not inflated
    ];
    const result = detectSeverityInflation(current, prior);
    expect(result.currentBlockingCount).toBe(2);
    expect(result.inflatedFindings).toHaveLength(1);
    expect(result.inflatedFindings[0]?.file).toBe("src/foo.ts");
    expect(result.inflationRate).toBe(0.5);
  });

  test("multiple prior reviews aggregate into the file allowlist", () => {
    const prior: FlatFinding[] = [
      { file: "src/a.ts", severity: "NON-BLOCKING" },
      { file: "src/b.ts", severity: "BLOCKING" },
      { file: "src/c.ts", severity: "PRE-EXISTING" },
    ];
    const current: FlatFinding[] = [
      { file: "src/a.ts", severity: "BLOCKING" }, // inflated (was NON-BLOCKING)
      { file: "src/b.ts", severity: "BLOCKING" }, // not inflated (was BLOCKING)
      { file: "src/c.ts", severity: "BLOCKING" }, // inflated (was PRE-EXISTING)
    ];
    const result = detectSeverityInflation(current, prior);
    expect(result.inflatedFindings.map((f) => f.file).sort()).toEqual(["src/a.ts", "src/c.ts"]);
  });
});
