// Tests for the duplicate-signature scan's pure surfaces (mt#3722).
//
// The SQL body needs a live database and is exercised by the guard canary
// (registry.ts, `expects: "calibration"`) plus the live verification in this
// task's PR. What IS testable without one — the LIKE escaping, the excerpt
// bounds, and the rendered warning's growth behaviour — is tested here, and the
// warning's bound is the one that matters most: it is injected context, so an
// unbounded render is a real cost paid on every fire.

import { describe, test, expect } from "bun:test";
import {
  escapeLike,
  excerptAround,
  buildSignatureWarning,
  MAX_REPORTED_MATCHES,
  type ScanResult,
  type SignatureMatch,
} from "./duplicate-signature-scan";

function match(taskId: string, token = "GET /api/sweeps", excerpt = "a line"): SignatureMatch {
  return {
    taskId,
    title: `title for ${taskId}`,
    status: "TODO",
    token: { text: token, rule: "route" },
    excerpt,
  };
}

function result(matches: SignatureMatch[], dropped: string[] = []): ScanResult {
  return {
    matches,
    tokensTried: [{ text: "GET /api/sweeps", rule: "route" }],
    tokensDroppedAsUbiquitous: dropped,
  };
}

describe("escapeLike", () => {
  test("escapes the LIKE wildcards so an underscore is not a single-char match", () => {
    // `task_specs` must not match `taskXspecs`. This is the case that made the
    // escaping necessary — snake_case identifiers are a whole token rule.
    expect(escapeLike("task_specs")).toBe("task\\_specs");
  });

  test("escapes percent and backslash", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });

  test("leaves an ordinary path untouched", () => {
    expect(escapeLike("src/cockpit/routes/sweeps.ts")).toBe("src/cockpit/routes/sweeps.ts");
  });
});

describe("excerptAround", () => {
  test("returns the whole line containing the token", () => {
    const content = "first line\nthe token GET /api/sweeps is here\nthird line";
    expect(excerptAround(content, "GET /api/sweeps")).toBe("the token GET /api/sweeps is here");
  });

  test("matches case-insensitively, mirroring the ILIKE that found the row", () => {
    expect(excerptAround("A line with get /api/sweeps in it", "GET /api/sweeps")).toBe(
      "A line with get /api/sweeps in it"
    );
  });

  test("truncates a very long line", () => {
    const long = `${"x".repeat(400)} GET /api/sweeps`;
    const out = excerptAround(long, "GET /api/sweeps");
    expect(out.length).toBe(200);
    expect(out.endsWith("...")).toBe(true);
  });

  test("returns empty when the token is absent", () => {
    expect(excerptAround("nothing here", "GET /api/sweeps")).toBe("");
  });

  test("handles a token on the first line with no preceding newline", () => {
    expect(excerptAround("GET /api/sweeps on line one\nmore", "GET /api/sweeps")).toBe(
      "GET /api/sweeps on line one"
    );
  });
});

describe("buildSignatureWarning", () => {
  test("names the matched task, its status, and the token", () => {
    const text = buildSignatureWarning(result([match("mt#3575")]));
    expect(text).toContain("mt#3575");
    expect(text).toContain("TODO");
    expect(text).toContain("GET /api/sweeps");
  });

  test("carries the guard-id header and an imperative directive", () => {
    // `guard-feedback-authoring.mdc`: header, quoted evidence, directive, and
    // the branch under which not acting is correct.
    const text = buildSignatureWarning(result([match("mt#3575")]));
    expect(text).toContain("[duplicate-signature-scan]");
    expect(text).toContain("Open each task above and read its spec");
    expect(text).toContain("If it genuinely does not overlap");
  });

  test("advertises no override to the agent", () => {
    // The override is the OPERATOR's, catalogued in CLAUDE.md. Offering it here
    // hands the agent an exit from work it is being asked to do.
    const text = buildSignatureWarning(result([match("mt#3575")]));
    expect(text).not.toContain("MINSKY_SKIP");
  });

  test("caps the rendered matches and STATES the overflow", () => {
    const many = Array.from({ length: MAX_REPORTED_MATCHES + 4 }, (_, i) =>
      match(`mt#${1000 + i}`)
    );
    const text = buildSignatureWarning(result(many));

    expect(text).toContain("mt#1000");
    // The 6th match onward is not rendered...
    expect(text).not.toContain(`mt#${1000 + MAX_REPORTED_MATCHES}`);
    // ...but the drop is never silent.
    expect(text).toContain("and 4 more");
  });

  test("stays inside its declared attentionCost ceiling at worst case", () => {
    // The registry declares denialMessageSizeChars: 2000 for this guard. Worst
    // case is MAX_REPORTED_MATCHES matches each carrying a full-length excerpt.
    const worst = Array.from({ length: MAX_REPORTED_MATCHES + 10 }, (_, i) =>
      match(`mt#${2000 + i}`, "GET /api/some/long/route/name", "y".repeat(200))
    );
    const text = buildSignatureWarning(result(worst, ["src/cockpit", "packages/domain"]));
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  test("names tokens dropped as ubiquitous rather than hiding them", () => {
    const text = buildSignatureWarning(result([match("mt#3575")], ["src/cockpit"]));
    expect(text).toContain("Not searched");
    expect(text).toContain("src/cockpit");
  });
});
