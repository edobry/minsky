// URL-query-parameter symbol exclusion — ADR-034 exclusion round 6 (mt#4157).
//
// A separate file rather than another block in
// `code-mechanism-assertion-detector.test.ts`, which sits at the 1500-line
// `max-lines` ERROR ceiling: adding this block inline put it at 1503 and broke
// the build. Same answer the repo reaches every time (mt#3262, mt#3692,
// mt#4115): extract, do not raise the ceiling.
//
// Scope: `isUrlQueryParameterMention` and its effect through the real
// `detectCodeMechanismAssertion` path. The detector's other suites stay where
// they are.

import { describe, test, expect } from "bun:test";
import {
  isUrlQueryParameterMention,
  detectCodeMechanismAssertion,
} from "./code-mechanism-assertion-detector";

describe("mt#4157 — URL-query-parameter symbol exclusion (ADR-034 round 6)", () => {
  // The verbatim tail of the 2026-08-14T judged input. Claude Code's own
  // spend-limit banner, pasted into the transcript: `cc_cli_limit_message` is a
  // query-parameter VALUE, and the record paired it with the nearby words
  // "limit" and "raise" as predicates. Nobody claimed anything about it.
  const BANNER =
    "You've hit your monthly spend limit · raise it at " +
    "claude.ai/settings/usage?from=cc_cli_limit_message";

  test("AT1: the cc_cli_limit_message record produces no claim on that token", () => {
    const result = detectCodeMechanismAssertion(BANNER, "");
    expect(result.claims.map((c) => c.symbol)).not.toContain("cc_cli_limit_message");
  });

  test("AT2 (over-suppression control): the ci_run_view_log record still fires", () => {
    // Ground-truth confirmed, not judged: a later turn in the same corpus
    // records the agent's own correction — "I called `ci_run_view_log` a CLI bug
    // without reading it." Any tune that loses this claim has failed, which is
    // why it is pinned here rather than left to the calibration corpus.
    const result = detectCodeMechanismAssertion(
      "The `ci_run_view_log` CLI rejects its own positional arg as a string — a real CLI bug.",
      ""
    );
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain("ci_run_view_log");
  });

  test("a token named in prose AND in a URL still fires — the exclusion needs EVERY occurrence", () => {
    // This is the property that keeps the exclusion from swallowing real claims:
    // an agent who links to a doc and then asserts something about the same
    // identifier has made a claim, and the link does not excuse it.
    const result = detectCodeMechanismAssertion(
      "See docs.example.com/x?from=session_pr_drive — `session_pr_drive` returns the merged head.",
      ""
    );
    expect(result.claims.map((c) => c.symbol)).toContain("session_pr_drive");
  });

  test("a query-shaped fragment with no URL head is NOT treated as a URL", () => {
    // `?from=` alone is not a link. Requiring a host-or-path head keeps the
    // predicate from excluding identifiers in ordinary prose that happens to
    // contain an equals sign after a question mark.
    expect(isUrlQueryParameterMention("some_symbol", "what about ?from=some_symbol")).toBe(false);
  });

  test("isUrlQueryParameterMention: host-headed and path-headed URLs both count", () => {
    expect(
      isUrlQueryParameterMention(
        "cc_cli_limit_message",
        "claude.ai/settings/usage?from=cc_cli_limit_message"
      )
    ).toBe(true);
    expect(isUrlQueryParameterMention("tok_value", "https://example.com/a/b?x=1&y=tok_value")).toBe(
      true
    );
    // Absent from the window entirely -> not an exclusion (no occurrence to judge).
    expect(isUrlQueryParameterMention("absent_token", "claude.ai/x?from=other_value")).toBe(false);
  });

  test("R1: a path-shaped fragment is not a URL — a slash alone no longer qualifies", () => {
    // PR #3031 R1 (non-blocking): the first cut accepted any head containing a
    // slash, so `src/foo?x=1` read as a URL and could suppress a real claim
    // about `some_symbol`. A head now needs a scheme or a dotted host.
    expect(isUrlQueryParameterMention("some_symbol", "see src/foo?x=some_symbol")).toBe(false);
    // A scheme still admits a dotless host, which is why the branch is kept.
    expect(isUrlQueryParameterMention("some_symbol", "http://localhost:3000/x?y=some_symbol")).toBe(
      true
    );
  });

  test("a path segment is left alone — round 6 is scoped to query parameters", () => {
    // Deliberate scope limit, not an oversight: no calibration record has fired
    // on a path segment, and ADR-034's subject is that predicates written ahead
    // of evidence are how the arms race runs. Pinned so a later widening is a
    // decision that breaks a test rather than a silent drift.
    expect(isUrlQueryParameterMention("usage_limits", "claude.ai/settings/usage_limits")).toBe(
      false
    );
  });
});
