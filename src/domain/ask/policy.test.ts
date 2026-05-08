/* eslint-disable custom/no-real-fs-in-tests -- test infrastructure: temp dirs for hermetic policy file-loading tests */
/**
 * Tests for policy source loading and coverage decisions.
 *
 * Five coverage scenarios per the spec:
 *   1. CLAUDE.md "auto-approve formatter commits" → covered for authorization.approve
 *   2. CLAUDE.md without authority keyword → NOT covered (name-match alone is insufficient)
 *   3. Project rule with `policy:` block → covered
 *   4. Task spec with explicit "permitted" clause → covered
 *   5. No matching source → uncovered
 *
 * The loadClaudeMd / loadProjectRules sections use a real temp dir because
 * those functions read from disk directly (no DI seam); the coverage tests
 * pass PolicyText[] inline and need no filesystem access.
 */

import { describe, expect, it, beforeEach, afterEach, test } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { isCovered, loadClaudeMd, loadProjectRules, loadTaskSpec } from "./policy";
import type { Ask } from "./types";
import { safeTruncate } from "../../utils/safe-truncate";

// ---------------------------------------------------------------------------
// Shared constants (avoid magic-string-duplication warnings)
// ---------------------------------------------------------------------------

const KIND_AUTH_APPROVE: Ask["kind"] = "authorization.approve";
const KIND_DIR_DECIDE: Ask["kind"] = "direction.decide";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Minimal valid Ask fixture. Does NOT use `as` casts — only required fields. */
function makeAsk(kind: Ask["kind"], title = "test ask"): Ask {
  return {
    id: "test-ask-001",
    kind,
    classifierVersion: "v1",
    requestor: "test-agent:proc:abc123",
    state: "classified",
    title,
    question: `Please ${kind.split(".")[1] ?? kind} this action.`,
    createdAt: new Date().toISOString(),
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// Tests: isCovered — coverage decision
// ---------------------------------------------------------------------------

describe("isCovered", () => {
  it("covers an authorization.approve Ask when CLAUDE.md has auto-approve formatter commits", () => {
    const ask = makeAsk(KIND_AUTH_APPROVE, "Approve formatter commits");
    const sources = [
      {
        source: "CLAUDE.md",
        content: `
# Auto-approvals

- auto-approve formatter commits: commits that only change formatting are pre-approved
  and do not require manual review.
`,
      },
    ];

    const result = isCovered(ask, sources);

    expect(result.covered).toBe(true);
    expect(result.citation).toBeDefined();
    expect(result.citation?.source).toBe("CLAUDE.md");
    expect(result.citation?.quote).toBeTruthy();
  });

  it("does NOT cover when the policy text only name-matches without an authority keyword", () => {
    // "be careful with commits" — mentions commits but has no authority keyword
    const ask = makeAsk(KIND_AUTH_APPROVE, "Approve commit action");
    const sources = [
      {
        source: "CLAUDE.md",
        content: `
# Commit guidelines

Be careful with commits: always review changes before committing.
Never commit secrets or credentials.
`,
      },
    ];

    const result = isCovered(ask, sources);

    expect(result.covered).toBe(false);
    expect(result.citation).toBeUndefined();
  });

  it("covers when a project rule has a `policy:` block naming the action", () => {
    const ask = makeAsk(KIND_AUTH_APPROVE, "Approve lint fixes");
    const sources = [
      {
        source: ".claude/rules/lint-policy.md",
        content: `
# Lint policy

policy: auto-approve lint fixes when the diff contains only whitespace and
formatting changes. No manual review required.
`,
      },
    ];

    const result = isCovered(ask, sources);

    expect(result.covered).toBe(true);
    expect(result.citation?.source).toBe(".claude/rules/lint-policy.md");
  });

  it("covers when a task spec has an explicit 'permitted' clause", () => {
    const ask = makeAsk(KIND_AUTH_APPROVE, "Approve test runner");
    const specSources = loadTaskSpec(`
## Constraints

The following steps are permitted: approve and run the test suite at any time.
Reformatting staged files is also allowed.
`);

    const result = isCovered(ask, specSources);

    expect(result.covered).toBe(true);
    expect(result.citation?.source).toBe("task-spec");
  });

  it("is uncovered when no source matches", () => {
    const ask = makeAsk(KIND_DIR_DECIDE, "Decide on database migration strategy");
    const sources = [
      {
        source: "CLAUDE.md",
        content: `
# Project guidelines

This project follows clean architecture principles.
`,
      },
    ];

    const result = isCovered(ask, sources);

    expect(result.covered).toBe(false);
  });

  it("returns covered=false for empty sources array", () => {
    const ask = makeAsk(KIND_AUTH_APPROVE);
    const result = isCovered(ask, []);
    expect(result.covered).toBe(false);
  });

  it("stops on the first matching source and returns its citation", () => {
    const ask = makeAsk(KIND_AUTH_APPROVE, "Approve build step");
    const sources = [
      {
        source: "first.md",
        content: "auto-approve build steps that only compile TypeScript files.",
      },
      {
        source: "second.md",
        content: "all build steps are permitted without review.",
      },
    ];

    const result = isCovered(ask, sources);

    expect(result.covered).toBe(true);
    expect(result.citation?.source).toBe("first.md");
  });
});

// ---------------------------------------------------------------------------
// Tests: loadClaudeMd
// ---------------------------------------------------------------------------

describe("loadClaudeMd", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ask-policy-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loads CLAUDE.md from the workspace root", async () => {
    const content = "# Auto-approve\n\nauto-approve formatter commits.";
    await writeFile(join(tmpDir, "CLAUDE.md"), content, "utf-8");

    const sources = await loadClaudeMd(tmpDir);

    expect(sources).toHaveLength(1);
    expect(sources[0]?.source).toBe("CLAUDE.md");
    expect(sources[0]?.content).toBe(content);
  });

  it("returns empty array when CLAUDE.md does not exist", async () => {
    const sources = await loadClaudeMd(tmpDir);
    expect(sources).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: loadProjectRules
// ---------------------------------------------------------------------------

describe("loadProjectRules", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ask-policy-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loads rules from .claude/rules/*.md", async () => {
    const rulesDir = join(tmpDir, ".claude", "rules");
    await mkdir(rulesDir, { recursive: true });
    await writeFile(
      join(rulesDir, "ci-policy.md"),
      "policy: CI runs are permitted without manual approval.",
      "utf-8"
    );

    const sources = await loadProjectRules(tmpDir);

    expect(sources.length).toBeGreaterThanOrEqual(1);
    const ruleSource = sources.find((s) => s.source.includes("ci-policy.md"));
    expect(ruleSource).toBeDefined();
    expect(ruleSource?.content).toContain("permitted");
  });

  it("returns empty array when no rule files exist", async () => {
    const sources = await loadProjectRules(tmpDir);
    expect(sources).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: loadTaskSpec
// ---------------------------------------------------------------------------

describe("loadTaskSpec", () => {
  it("returns a single-element array for non-empty content", () => {
    const spec = "## Constraints\n\nAll test runs are permitted.";
    const sources = loadTaskSpec(spec);

    expect(sources).toHaveLength(1);
    expect(sources[0]?.source).toBe("task-spec");
    expect(sources[0]?.content).toBe(spec);
  });

  it("returns empty array for null", () => {
    expect(loadTaskSpec(null)).toHaveLength(0);
  });

  it("returns empty array for undefined", () => {
    expect(loadTaskSpec(undefined)).toHaveLength(0);
  });

  it("returns empty array for empty string", () => {
    expect(loadTaskSpec("")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Surrogate-pair safety regression tests (mt#1615)
// ---------------------------------------------------------------------------

function hasUnpairedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function jsonRoundtrips(s: string): boolean {
  try {
    const encoded = JSON.stringify({ s });
    const decoded = JSON.parse(encoded) as { s: string };
    return decoded.s === s;
  } catch {
    return false;
  }
}

// Mirror of the patched truncateQuote() in policy.ts
function truncateQuote(text: string, maxLength = 200): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${safeTruncate(trimmed, maxLength - 3, "head")}...`;
}

describe("policy truncateQuote — surrogate safety (mt#1615)", () => {
  const EMOJIS = ["🔍", "🚀", "🎯", "🤖"];
  const MAX_QUOTE_LEN = 200;

  test("quote truncated at 200 is surrogate-safe", () => {
    const prefix = "a".repeat(198);
    const quote = `${prefix}🔍 more policy text`;
    const result = truncateQuote(quote, MAX_QUOTE_LEN);
    expect(hasUnpairedSurrogate(result)).toBe(false);
    expect(jsonRoundtrips(result)).toBe(true);
    expect(result.endsWith("...")).toBe(true);
  });

  test("every cut length 0..200 on emoji quote produces valid UTF-16", () => {
    const quote = EMOJIS.join("").repeat(30); // 240 code units
    for (let n = 3; n <= MAX_QUOTE_LEN; n++) {
      const result = truncateQuote(quote, n);
      expect(hasUnpairedSurrogate(result)).toBe(false);
      expect(jsonRoundtrips(result)).toBe(true);
    }
  });

  test("short quote returned unchanged (trimmed)", () => {
    const quote = "  Use safeTruncate 🔍  ";
    const result = truncateQuote(quote);
    expect(result).toBe(quote.trim());
    expect(hasUnpairedSurrogate(result)).toBe(false);
  });

  test("all four spec emojis at the 200-char boundary", () => {
    for (const emoji of EMOJIS) {
      const quote = `${"a".repeat(198) + emoji}extra`;
      const result = truncateQuote(quote, MAX_QUOTE_LEN);
      expect(hasUnpairedSurrogate(result)).toBe(false);
      expect(jsonRoundtrips(result)).toBe(true);
    }
  });
});
