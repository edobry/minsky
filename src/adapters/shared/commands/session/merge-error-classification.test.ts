/**
 * Tests for `classifyOctokitOriginReadError` (mt#2888, PR #2018 R1 fix).
 *
 * `classifyMergeError` (mt#2890, tested in
 * workflow-commands-merge-error-classification.test.ts) uses a BROAD
 * substring/regex match ("rate limit" anywhere in the message, a bare
 * "(HTTP 5xx)" anywhere) tuned for `session.pr.merge`'s narrow job:
 * distinguishing a real merge conflict from a GitHub degradation mislabeled
 * as one. Reusing that broad matcher at the three read-path sites
 * (`session.pr.checks`, `session.pr.wait-for-review`,
 * `forge.check_runs_list`) created a NEW risk those sites didn't have
 * before: an already domain-typed error (ResourceNotFoundError,
 * ValidationError, or any other message that merely happens to CONTAIN the
 * substring "rate limit" for unrelated reasons) would get silently
 * reclassified into a transport-error shape, discarding its original type.
 *
 * `classifyOctokitOriginReadError` closes that gap with a TIGHT match on
 * `handleOctokitError`'s (github-error-handler.ts) exact headline text —
 * these tests pin that precision.
 */
import { describe, test, expect } from "bun:test";
import { classifyOctokitOriginReadError } from "./merge-error-classification";
import { ResourceNotFoundError, ValidationError, MinskyError } from "@minsky/domain/errors/index";

describe("classifyOctokitOriginReadError — precision (mt#2888 PR #2018 R1)", () => {
  test("matches handleOctokitError's exact rate-limit headline", () => {
    const err = new MinskyError(
      "GitHub Rate Limit Exceeded\n\nYou've hit GitHub's API rate limit.\n\n..."
    );
    expect(classifyOctokitOriginReadError(err)).toEqual({ kind: "rate-limit" });
  });

  test("matches handleOctokitError's exact degraded(5xx) headline and extracts the status", () => {
    const err = new MinskyError(
      "GitHub API degraded/unavailable (HTTP 503)\n\nGitHub's API returned a server error..."
    );
    expect(classifyOctokitOriginReadError(err)).toEqual({ kind: "degraded", status: "503" });
  });

  test("REGRESSION: a domain-typed ResourceNotFoundError whose message merely CONTAINS 'rate limit' is NOT reclassified", () => {
    // Contrived but exactly the class of bug PR #2018 R1 flagged: a
    // completely unrelated domain error whose message happens to mention
    // "rate limit" (e.g. describing a DIFFERENT internal throttle, not a
    // GitHub API failure) must classify as "other" so callers preserve its
    // original type instead of wrapping it into a transport-error shape.
    const err = new ResourceNotFoundError(
      "Session 'my-session' not found (internal rate limit tracker had no entry)"
    );
    expect(classifyOctokitOriginReadError(err)).toEqual({ kind: "other" });
    // And the type itself survives untouched — this is what callers check.
    expect(err).toBeInstanceOf(ResourceNotFoundError);
  });

  test("REGRESSION: a domain-typed ValidationError whose message merely CONTAINS '(HTTP 5' is NOT reclassified", () => {
    const err = new ValidationError("Invalid --since timestamp: '(HTTP 500-ish looking value)'");
    expect(classifyOctokitOriginReadError(err)).toEqual({ kind: "other" });
    expect(err).toBeInstanceOf(ValidationError);
  });

  test("a generic MinskyError NOT produced by handleOctokitError (no matching headline) classifies as 'other'", () => {
    const err = new MinskyError("Failed to get session PR checks: some unrelated failure");
    expect(classifyOctokitOriginReadError(err)).toEqual({ kind: "other" });
  });

  test("a plain string error is never misclassified", () => {
    expect(classifyOctokitOriginReadError("rate limit exceeded somewhere unrelated")).toEqual({
      kind: "other",
    });
  });
});
