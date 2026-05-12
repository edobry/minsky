import { describe, expect, it } from "bun:test";
import {
  BUNDLE_BOOT_SMOKE_CHECK_NAME,
  BUNDLE_BOOT_SMOKE_OVERRIDE_ENV,
  evaluateBundleBootSmokePresence,
  evaluateCheckRunsPresence,
  parseBundleBootSmokeResponse,
  parseCheckRunsResponse,
} from "./require-review-before-merge";

// Shared error string fixture — used in both mt#1309 and mt#1787 test groups
// to drive parser-failure assertions. Extracted to dodge no-magic-string-duplication.
const EMPTY_RESPONSE_ERR = "gh api returned empty response";

describe("parseCheckRunsResponse (mt#1309)", () => {
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });

  it("returns count from total_count when present", () => {
    const result = parseCheckRunsResponse(ok('{"total_count":2,"check_runs":[]}'));
    expect(result).toEqual({ ok: true, count: 2 });
  });

  it("falls back to check_runs.length when total_count is missing", () => {
    const result = parseCheckRunsResponse(ok('{"check_runs":[{"id":1},{"id":2},{"id":3}]}'));
    expect(result).toEqual({ ok: true, count: 3 });
  });

  it("returns count=0 when total_count is 0 (the webhook-miss case)", () => {
    const result = parseCheckRunsResponse(ok('{"total_count":0,"check_runs":[]}'));
    expect(result).toEqual({ ok: true, count: 0 });
  });

  it("returns failure when gh api exits non-zero", () => {
    const result = parseCheckRunsResponse({
      exitCode: 1,
      stdout: "",
      stderr: "rate limit exceeded",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("exited 1");
      expect(result.error).toContain("rate limit");
    }
  });

  it("returns failure with placeholder stderr when stderr is empty", () => {
    const result = parseCheckRunsResponse({ exitCode: 1, stdout: "", stderr: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("(no stderr)");
    }
  });

  it("returns failure when stdout is empty (zero exit)", () => {
    const result = parseCheckRunsResponse(ok(""));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("empty response");
    }
  });

  it("returns failure when stdout is not valid JSON", () => {
    const result = parseCheckRunsResponse(ok("not-json{{"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("failed to parse");
    }
  });

  it("returns failure when JSON is not an object (array)", () => {
    const result = parseCheckRunsResponse(ok("[1,2,3]"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // arrays still hit the "missing total_count and check_runs[]" path
      expect(result.error).toBeDefined();
    }
  });

  it("returns failure when JSON is null", () => {
    const result = parseCheckRunsResponse(ok("null"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not an object");
    }
  });

  it("returns failure when neither total_count nor check_runs is present", () => {
    const result = parseCheckRunsResponse(ok('{"message":"Not Found"}'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("missing total_count");
    }
  });

  it("returns failure with a distinct timeout reason when execSync times out", () => {
    const result = parseCheckRunsResponse({
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("timed out");
    }
  });

  it("timeout is detected even when stderr carries a message", () => {
    const result = parseCheckRunsResponse({
      exitCode: 1,
      stdout: "",
      stderr: "killed",
      timedOut: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("timed out");
      expect(result.error).toContain("killed");
    }
  });

  it("treats total_count as authoritative even when check_runs.length disagrees (pagination case)", () => {
    // GitHub returns total_count=42 with only 1 item when ?per_page=1.
    // The parser must trust total_count, not check_runs.length.
    const result = parseCheckRunsResponse(
      ok('{"total_count":42,"check_runs":[{"id":1,"name":"build"}]}')
    );
    expect(result).toEqual({ ok: true, count: 42 });
  });
});

describe("evaluateCheckRunsPresence (mt#1309)", () => {
  const pr = "855";
  const headSha = "3f1b048c486e1f49f26db71836b86b3ee4eb026d";
  const okWith = (count: number) => ({ ok: true as const, count });
  const failWith = (error: string) => ({ ok: false as const, error });

  it("allows merge when at least one check_run fired", () => {
    const result = evaluateCheckRunsPresence(okWith(2), pr, headSha);
    expect(result.deny).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("allows merge with a single check_run", () => {
    expect(evaluateCheckRunsPresence(okWith(1), pr, headSha).deny).toBe(false);
  });

  it("denies merge when zero check_runs fired (the webhook-miss class)", () => {
    const result = evaluateCheckRunsPresence(okWith(0), pr, headSha);
    expect(result.deny).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it("webhook-miss denial reason names mt#1309 and PR #763 lineage", () => {
    const result = evaluateCheckRunsPresence(okWith(0), pr, headSha);
    expect(result.reason).toContain("mt#1309");
    expect(result.reason).toContain("PR #763");
  });

  it("webhook-miss denial reason points at the empty-commit recovery path", () => {
    const result = evaluateCheckRunsPresence(okWith(0), pr, headSha);
    expect(result.reason).toContain("empty commit");
    expect(result.reason).toContain("noFiles");
    expect(result.reason).toContain("noStage");
  });

  it("webhook-miss denial reason references /review-pr step 7a as the bypass-merge fallback", () => {
    const result = evaluateCheckRunsPresence(okWith(0), pr, headSha);
    expect(result.reason).toContain("/review-pr step 7a");
  });

  it("webhook-miss denial reason includes the short HEAD sha for triage", () => {
    const result = evaluateCheckRunsPresence(okWith(0), pr, headSha);
    expect(result.reason).toContain(headSha.slice(0, 7));
  });

  it("webhook-miss denial reason includes the PR number", () => {
    const result = evaluateCheckRunsPresence(okWith(0), "9999", headSha);
    expect(result.reason).toContain("#9999");
  });

  it("denies merge with a distinct reason on API failure (not the webhook-miss text)", () => {
    const result = evaluateCheckRunsPresence(
      failWith("gh api exited 1: 502 Bad Gateway"),
      pr,
      headSha
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("Unable to query CI check_runs");
    expect(result.reason).toContain("gh api transport/parse failure");
    expect(result.reason).not.toContain("mt#1309 / PR #763 lineage");
    expect(result.reason).not.toContain("empty commit");
  });

  it("API-failure denial reason embeds the parser error verbatim", () => {
    const result = evaluateCheckRunsPresence(failWith(EMPTY_RESPONSE_ERR), pr, headSha);
    expect(result.reason).toContain(EMPTY_RESPONSE_ERR);
  });

  it("API-failure denial reason still references /review-pr step 7a as the last-resort fallback", () => {
    const result = evaluateCheckRunsPresence(
      failWith("gh api exited 401: bad credentials"),
      pr,
      headSha
    );
    expect(result.reason).toContain("/review-pr step 7a");
  });

  it("API-failure denial reason includes the PR number and short HEAD sha", () => {
    const result = evaluateCheckRunsPresence(
      failWith("gh api exited 1: connection refused"),
      "9999",
      headSha
    );
    expect(result.reason).toContain("#9999");
    expect(result.reason).toContain(headSha.slice(0, 7));
  });
});

// ---------------------------------------------------------------------------
// Bundle-boot smoke check (mt#1787)
// ---------------------------------------------------------------------------

describe("parseBundleBootSmokeResponse (mt#1787)", () => {
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
  const checkRun = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      check_runs: [
        {
          name: BUNDLE_BOOT_SMOKE_CHECK_NAME,
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/edobry/minsky/runs/1",
          ...overrides,
        },
      ],
    });

  it("extracts a successful matching check_run", () => {
    const result = parseBundleBootSmokeResponse(ok(checkRun()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const [first] = result.runs;
      expect(result.runs).toHaveLength(1);
      expect(first?.name).toBe(BUNDLE_BOOT_SMOKE_CHECK_NAME);
      expect(first?.conclusion).toBe("success");
    }
  });

  it("filters out check_runs with non-matching names (defensive)", () => {
    const body = JSON.stringify({
      check_runs: [
        { name: "build", status: "completed", conclusion: "success" },
        {
          name: BUNDLE_BOOT_SMOKE_CHECK_NAME,
          status: "completed",
          conclusion: "failure",
        },
      ],
    });
    const result = parseBundleBootSmokeResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const [first] = result.runs;
      expect(result.runs).toHaveLength(1);
      expect(first?.conclusion).toBe("failure");
    }
  });

  it("returns empty runs array when API has no matching check_runs", () => {
    const result = parseBundleBootSmokeResponse(ok('{"check_runs":[]}'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runs).toEqual([]);
    }
  });

  it("returns null conclusion when the run is still in progress", () => {
    const body = checkRun({ status: "in_progress", conclusion: null });
    const result = parseBundleBootSmokeResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const [first] = result.runs;
      expect(first?.status).toBe("in_progress");
      expect(first?.conclusion).toBeNull();
    }
  });

  it("returns failure when gh api exits non-zero", () => {
    const result = parseBundleBootSmokeResponse({
      exitCode: 1,
      stdout: "",
      stderr: "rate limit exceeded",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("exited 1");
      expect(result.error).toContain("rate limit");
    }
  });

  it("returns failure with timeout reason when execSync times out", () => {
    const result = parseBundleBootSmokeResponse({
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("timed out");
    }
  });

  it("returns failure when stdout is empty", () => {
    const result = parseBundleBootSmokeResponse(ok(""));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("empty response");
    }
  });

  it("returns failure when JSON is not an object", () => {
    const result = parseBundleBootSmokeResponse(ok("null"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not an object");
    }
  });

  it("returns failure when check_runs[] is missing", () => {
    const result = parseBundleBootSmokeResponse(ok("{}"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("missing check_runs");
    }
  });
});

describe("evaluateBundleBootSmokePresence (mt#1787)", () => {
  const pr = "1234";
  const headSha = "abcdef0123456789abcdef0123456789abcdef01";
  const okWith = (
    runs: Array<{
      name?: string;
      status?: string;
      conclusion?: string | null;
      htmlUrl?: string | null;
    }>
  ) => ({
    ok: true as const,
    runs: runs.map((r) => ({
      name: r.name ?? BUNDLE_BOOT_SMOKE_CHECK_NAME,
      status: r.status ?? "completed",
      conclusion: r.conclusion ?? null,
      htmlUrl: r.htmlUrl ?? null,
    })),
  });
  const failWith = (error: string) => ({ ok: false as const, error });

  it("allows merge when at least one run concluded success", () => {
    const result = evaluateBundleBootSmokePresence(
      okWith([{ status: "completed", conclusion: "success" }]),
      pr,
      headSha
    );
    expect(result.deny).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("allows merge when one of multiple runs succeeded (latest re-run wins)", () => {
    const result = evaluateBundleBootSmokePresence(
      okWith([
        { status: "completed", conclusion: "failure" },
        { status: "completed", conclusion: "success" },
      ]),
      pr,
      headSha
    );
    expect(result.deny).toBe(false);
  });

  it("denies when no matching check_run exists (workflow didn't fire)", () => {
    const result = evaluateBundleBootSmokePresence(okWith([]), pr, headSha);
    expect(result.deny).toBe(true);
    expect(result.reason).toContain(BUNDLE_BOOT_SMOKE_CHECK_NAME);
    expect(result.reason).toContain("mt#1787");
    expect(result.reason).toContain(BUNDLE_BOOT_SMOKE_OVERRIDE_ENV);
  });

  it("missing-check denial reason includes PR number and short HEAD sha", () => {
    const result = evaluateBundleBootSmokePresence(okWith([]), pr, headSha);
    expect(result.reason).toContain(`#${pr}`);
    expect(result.reason).toContain(headSha.slice(0, 7));
  });

  it("missing-check denial reason names the rebase / webhook-wake recovery paths", () => {
    const result = evaluateBundleBootSmokePresence(okWith([]), pr, headSha);
    expect(result.reason).toContain("rebase");
    expect(result.reason).toContain("noFiles");
  });

  it("denies when the only run is still in progress", () => {
    const result = evaluateBundleBootSmokePresence(
      okWith([{ status: "in_progress", conclusion: null }]),
      pr,
      headSha
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("in_progress");
    expect(result.reason).toContain("mt#1787");
  });

  it("denies when the only run is queued (still pre-completion)", () => {
    const result = evaluateBundleBootSmokePresence(
      okWith([{ status: "queued", conclusion: null }]),
      pr,
      headSha
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("queued");
  });

  it("denies when run completed with failure conclusion", () => {
    const result = evaluateBundleBootSmokePresence(
      okWith([
        {
          status: "completed",
          conclusion: "failure",
          htmlUrl: "https://github.com/edobry/minsky/runs/9",
        },
      ]),
      pr,
      headSha
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("failure");
    expect(result.reason).toContain("https://github.com/edobry/minsky/runs/9");
    expect(result.reason).toContain("did not boot cleanly");
  });

  it("denies when run completed with cancelled / timed_out / neutral conclusions", () => {
    for (const conclusion of ["cancelled", "timed_out", "neutral", "action_required"]) {
      const result = evaluateBundleBootSmokePresence(
        okWith([{ status: "completed", conclusion }]),
        pr,
        headSha
      );
      expect(result.deny).toBe(true);
      expect(result.reason).toContain(conclusion);
    }
  });

  it("denies with API-failure reason on parse failure (distinct from check-missing)", () => {
    const result = evaluateBundleBootSmokePresence(
      failWith("gh api exited 1: 502 Bad Gateway"),
      pr,
      headSha
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("Unable to query bundle-boot-smoke");
    expect(result.reason).toContain("gh api transport/parse failure");
    expect(result.reason).toContain(BUNDLE_BOOT_SMOKE_OVERRIDE_ENV);
  });

  it("API-failure denial reason embeds the parser error verbatim", () => {
    const result = evaluateBundleBootSmokePresence(failWith(EMPTY_RESPONSE_ERR), pr, headSha);
    expect(result.reason).toContain(EMPTY_RESPONSE_ERR);
  });
});
