/**
 * Tests for the coverage-claim path detection core (mt#4426).
 *
 * Every discrimination here is a measured false-positive class or a measured
 * true positive from the repo corpus — not an invented case. The corpus figures
 * the cases are drawn from: 429 unique cited paths, 111 non-resolving, 2 real.
 *
 * @see .minsky/hooks/coverage-claim-path.ts
 */
import { describe, test, expect } from "bun:test";
import {
  extractCommentRegions,
  candidatePathsFor,
  findUnresolvedCoverageClaims,
} from "./coverage-claim-path";

/** An existence check over an explicit set — the injected seam, no fs, no spyOn. */
function existsIn(paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

const NOTHING_EXISTS = existsIn([]);

/** FP class 2's worked case: cited from a service, resolving only under that service. */
const SERVICE_LOCAL_SCRIPT = "scripts/reconcile-schema.ts";
const SERVICE_LOCAL_SCRIPT_RESOLVED = `services/reviewer/${SERVICE_LOCAL_SCRIPT}`;

describe("extractCommentRegions", () => {
  test("a URL inside a string literal is not read as a line comment", () => {
    // The reason this is a scanner and not a regex: `//` in `https://` is the
    // single most common way a naive comment-stripper mis-fires.
    const source = `const endpoint = "https://example.com/covered by scripts/nope.ts";`;

    expect(extractCommentRegions(source)).toEqual([]);
  });

  test("line and block comments are both captured, with their starting lines", () => {
    const source = ["const a = 1;", "// first", "/* second", "   continues */"].join("\n");

    const regions = extractCommentRegions(source);

    expect(regions.map((r) => r.line)).toEqual([2, 3]);
    expect(regions[0]?.text.trim()).toBe("first");
    expect(regions[1]?.text.trim()).toBe("second\n   continues");
  });
});

describe("candidatePathsFor", () => {
  test("prefers the citing file's package root over the repo root (FP class 2)", () => {
    // `services/reviewer/scripts/reconcile-schema.ts` exists; the repo-root
    // `scripts/reconcile-schema.ts` does not. Resolving against the repo root
    // first manufactures the miss.
    const candidates = candidatePathsFor(SERVICE_LOCAL_SCRIPT, "services/reviewer/src/thing.ts");

    expect(candidates[0]).toBe(`services/reviewer/src/${SERVICE_LOCAL_SCRIPT}`);
    expect(candidates).toContain(SERVICE_LOCAL_SCRIPT_RESOLVED);
    expect(candidates[candidates.length - 1]).toBe(SERVICE_LOCAL_SCRIPT);
    expect(candidates.indexOf(SERVICE_LOCAL_SCRIPT_RESOLVED)).toBeLessThan(
      candidates.indexOf(SERVICE_LOCAL_SCRIPT)
    );
  });
});

describe("findUnresolvedCoverageClaims — AT1/AT2: the three measured false-positive classes", () => {
  test("AT2: a transcripts/ path does not yield a bogus scripts/ claim (FP class 1, the largest)", () => {
    // The substring trap: `transcripts/` CONTAINS `scripts/`. This is the single
    // largest measured FP class and is invisible on inspection, which is why it
    // is pinned by its own test per the spec's AT2.
    const source = [
      "/**",
      " * Coverage is exercised in packages/domain/src/transcripts/turns.ts.",
      " */",
    ].join("\n");

    const findings = findUnresolvedCoverageClaims(
      source,
      "packages/domain/src/other.ts",
      (p) =>
        // The real file exists; the phantom `scripts/turns.ts` does not.
        p === "packages/domain/src/transcripts/turns.ts"
    );

    expect(findings).toEqual([]);
  });

  test("AT2: the substring guard holds even when the real path is absent entirely", () => {
    // Stronger form: if the matcher were producing `scripts/turns.ts` at all,
    // it would fire here, because nothing resolves. A pass proves the token was
    // never extracted rather than merely resolved away.
    const source = "// Coverage is exercised in packages/domain/src/transcripts/turns.ts.";

    const findings = findUnresolvedCoverageClaims(source, "a.ts", NOTHING_EXISTS);

    expect(findings.map((f) => f.citedPath)).not.toContain("scripts/turns.ts");
  });

  test("FP class 2: a service-local script resolves against its own package root", () => {
    const source = "// Kept in sync by scripts/reconcile-schema.ts — see also that convention.";

    const findings = findUnresolvedCoverageClaims(
      source,
      "services/reviewer/src/schema.ts",
      existsIn([SERVICE_LOCAL_SCRIPT_RESOLVED])
    );

    expect(findings).toEqual([]);
  });

  test("FP class 3a: a fixture path in CODE is not a comment claim", () => {
    // `scripts/gone.ts` and `scripts/verify-something.ts` live in test-fixture
    // string literals. Comment-scoping is what removes them.
    const source = `const changed = [{ filename: "scripts/gone.ts", status: "removed" }];`;

    expect(findUnresolvedCoverageClaims(source, "a.test.ts", NOTHING_EXISTS)).toEqual([]);
  });

  test("FP class 3b: an illustrative path in a COMMENT is not a claim without a claim phrase", () => {
    // Comment-scoping alone does NOT remove these — measured: `scripts/foo.ts`,
    // `scripts/x.ts` and `scripts/moved.ts` all sit in comments. The claim-phrase
    // conjunct is what removes them, which is why both conjuncts exist.
    const source = [
      "// depth (e.g. `scripts/foo.ts`, `scripts/migrations/backfill.ts`) that is not",
      "// both interpreter-prefixed invocation (`bun ./scripts/x.ts`) and direct",
    ].join("\n");

    expect(findUnresolvedCoverageClaims(source, "a.ts", NOTHING_EXISTS)).toEqual([]);
  });
});

describe("findUnresolvedCoverageClaims — AT3: the measured true positives", () => {
  test("AT3: an @see citing a deleted script fires (live instance)", () => {
    // scripts/consolidate-evaluation-stream-logs.ts:28 — the cited script was
    // removed when mt#4197 retired the policy-coverage detector.
    const source =
      " * @see scripts/consolidate-policy-coverage-logs.ts — the mt#3393 precedent this mirrors";

    const findings = findUnresolvedCoverageClaims(
      `/**\n${source}\n */`,
      "scripts/consolidate-evaluation-stream-logs.ts",
      NOTHING_EXISTS
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.citedPath).toBe("scripts/consolidate-policy-coverage-logs.ts");
    expect(findings[0]?.claimPhrase).toBe("@see");
  });

  test("AT3: a BACKTICKED convention citation fires — inline code spans are not elided", () => {
    // scripts/calibrate-epic-decomposition-staleness.ts:29. This is the case
    // that decides the Rung-1 deviation: applying prose-style code-span elision
    // here would suppress this real finding and remove no false class.
    const source = " * the existing `scripts/cleanup-tasks-embeddings-uuid-orphans.ts` convention.";

    const findings = findUnresolvedCoverageClaims(
      `/**\n${source}\n */`,
      "scripts/calibrate-epic-decomposition-staleness.ts",
      NOTHING_EXISTS
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.citedPath).toBe("scripts/cleanup-tasks-embeddings-uuid-orphans.ts");
  });

  test("AT3: the mt#4413 case — a header citing a verify script that never existed", () => {
    const source = [
      "/**",
      " * AT4/AT5 coverage for mt#3816 is exercised in scripts/verify-setup-local-http.ts.",
      " */",
    ].join("\n");

    const findings = findUnresolvedCoverageClaims(
      source,
      "src/setup-local-http.test.ts",
      NOTHING_EXISTS
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.citedPath).toBe("scripts/verify-setup-local-http.ts");
    expect(findings[0]?.claimPhrase).toBe("exercised in");
    expect(findings[0]?.context).toContain("exercised in");
  });

  test("a claim whose path DOES resolve is not a finding", () => {
    const source = "// Coverage is exercised in scripts/verify-setup-local-http.ts.";

    const findings = findUnresolvedCoverageClaims(
      source,
      "src/setup-local-http.test.ts",
      existsIn(["scripts/verify-setup-local-http.ts"])
    );

    expect(findings).toEqual([]);
  });

  test("a claim phrase must precede the path within the window, not merely appear in the file", () => {
    // Guards the conjunct itself: a claim phrase 400 chars earlier does not
    // govern this path, and treating it as governing would re-admit class 3.
    const filler = "x".repeat(400);
    const source = `// covered by something else. ${filler} and separately scripts/unrelated.ts`;

    expect(findUnresolvedCoverageClaims(source, "a.ts", NOTHING_EXISTS)).toEqual([]);
  });

  test("a file naming itself is not a claim about somewhere else", () => {
    const source = "// @see scripts/self.ts — this file.";

    expect(findUnresolvedCoverageClaims(source, "scripts/self.ts", NOTHING_EXISTS)).toEqual([]);
  });
});
