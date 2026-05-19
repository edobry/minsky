import { describe, expect, it } from "bun:test";
import {
  BUNDLE_BOOT_SMOKE_CHECK_NAME,
  BUNDLE_BOOT_SMOKE_OVERRIDE_ENV,
  REQUIRED_CHECKS_OVERRIDE_ENV,
  evaluateBundleBootSmokePresence,
  evaluateCheckRunsPresence,
  evaluateRequiredChecksStatus,
  parseAllCheckRunsResponse,
  parseBranchProtectionResponse,
  parseBundleBootSmokeResponse,
  parseCheckRunsResponse,
  pickLatestRunByName,
} from "./require-review-before-merge";

// Shared fixtures — used across mt#1309, mt#1787, and mt#1938 test groups.
// Extracted to dodge custom/no-magic-string-duplication.
const EMPTY_RESPONSE_ERR = "gh api returned empty response";
// Second required-check name from branch protection. The bare string also
// appears in test bodies; centralising it avoids drift if branch protection
// changes the canonical name later.
const REQUIRED_CHECK_PLACEHOLDER_TESTS = "Prevent Placeholder Tests";
// Repeated mock error string for the API-failure-path tests.
const GH_API_502_ERROR = "gh api exited 1: 502 Bad Gateway";

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
    const result = evaluateCheckRunsPresence(failWith(GH_API_502_ERROR), pr, headSha);
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

  it("matches the workflow-prefixed name shape `<workflow> / bundle-boot-smoke` (PR #1083 NON-BLOCKING)", () => {
    const body = JSON.stringify({
      check_runs: [
        {
          name: `Bundle Boot Smoke / ${BUNDLE_BOOT_SMOKE_CHECK_NAME}`,
          status: "completed",
          conclusion: "success",
        },
      ],
    });
    const result = parseBundleBootSmokeResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]?.conclusion).toBe("success");
    }
  });

  it("does NOT match check_runs whose name only contains the bare token (defensive cap)", () => {
    const body = JSON.stringify({
      check_runs: [
        { name: "not-bundle-boot-smoke", status: "completed", conclusion: "success" },
        { name: "bundle-boot-smoke-extra", status: "completed", conclusion: "success" },
      ],
    });
    const result = parseBundleBootSmokeResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runs).toEqual([]);
    }
  });

  it("captures startedAt and completedAt timestamps from the API response", () => {
    const body = checkRun({
      started_at: "2026-05-12T20:59:08Z",
      completed_at: "2026-05-12T20:59:40Z",
    });
    const result = parseBundleBootSmokeResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runs[0]?.startedAt).toBe("2026-05-12T20:59:08Z");
      expect(result.runs[0]?.completedAt).toBe("2026-05-12T20:59:40Z");
    }
  });

  it("sorts runs latest-first by completedAt descending (PR #1083 BLOCKING)", () => {
    const body = JSON.stringify({
      check_runs: [
        {
          name: BUNDLE_BOOT_SMOKE_CHECK_NAME,
          status: "completed",
          conclusion: "success",
          completed_at: "2026-05-12T10:00:00Z",
        },
        {
          name: BUNDLE_BOOT_SMOKE_CHECK_NAME,
          status: "completed",
          conclusion: "failure",
          completed_at: "2026-05-12T11:00:00Z",
        },
        {
          name: BUNDLE_BOOT_SMOKE_CHECK_NAME,
          status: "completed",
          conclusion: "success",
          completed_at: "2026-05-12T09:00:00Z",
        },
      ],
    });
    const result = parseBundleBootSmokeResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runs).toHaveLength(3);
      expect(result.runs.map((r) => r.completedAt)).toEqual([
        "2026-05-12T11:00:00Z",
        "2026-05-12T10:00:00Z",
        "2026-05-12T09:00:00Z",
      ]);
    }
  });

  it("falls back to startedAt when completedAt is missing (in_progress runs)", () => {
    const body = JSON.stringify({
      check_runs: [
        {
          name: BUNDLE_BOOT_SMOKE_CHECK_NAME,
          status: "completed",
          conclusion: "success",
          completed_at: "2026-05-12T10:00:00Z",
        },
        {
          name: BUNDLE_BOOT_SMOKE_CHECK_NAME,
          status: "in_progress",
          conclusion: null,
          started_at: "2026-05-12T11:00:00Z",
        },
      ],
    });
    const result = parseBundleBootSmokeResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // in_progress run sorted first because its startedAt > completed run's completedAt
      expect(result.runs[0]?.status).toBe("in_progress");
      expect(result.runs[1]?.conclusion).toBe("success");
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
  // Helper builds a parse result where runs are already sorted latest-first
  // (the parser does this; eval relies on `runs[0]` being most recent).
  const okWith = (
    runs: Array<{
      name?: string;
      status?: string;
      conclusion?: string | null;
      htmlUrl?: string | null;
      startedAt?: string | null;
      completedAt?: string | null;
    }>
  ) => ({
    ok: true as const,
    runs: runs.map((r) => ({
      name: r.name ?? BUNDLE_BOOT_SMOKE_CHECK_NAME,
      status: r.status ?? "completed",
      conclusion: r.conclusion ?? null,
      htmlUrl: r.htmlUrl ?? null,
      startedAt: r.startedAt ?? null,
      completedAt: r.completedAt ?? null,
    })),
  });
  const failWith = (error: string) => ({ ok: false as const, error });

  it("allows merge when the only run concluded success", () => {
    const result = evaluateBundleBootSmokePresence(
      okWith([{ status: "completed", conclusion: "success" }]),
      pr,
      headSha
    );
    expect(result.deny).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("allows merge when latest succeeded over an earlier failure (latest-wins, success direction)", () => {
    const result = evaluateBundleBootSmokePresence(
      okWith([
        { status: "completed", conclusion: "success" }, // latest (runs[0])
        { status: "completed", conclusion: "failure" }, // earlier
      ]),
      pr,
      headSha
    );
    expect(result.deny).toBe(false);
  });

  it("DENIES when latest is failure even if an earlier run succeeded (PR #1083 R1 BLOCKING — recency)", () => {
    const result = evaluateBundleBootSmokePresence(
      okWith([
        { status: "completed", conclusion: "failure" }, // latest re-run
        { status: "completed", conclusion: "success" }, // earlier
      ]),
      pr,
      headSha
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("Latest");
    expect(result.reason).toContain("failure");
    expect(result.reason).toContain("did not boot cleanly");
  });

  it("DENIES when latest is in_progress even if an earlier run succeeded (PR #1083 R1 BLOCKING — recency)", () => {
    const result = evaluateBundleBootSmokePresence(
      okWith([
        { status: "in_progress", conclusion: null }, // latest re-run, still running
        { status: "completed", conclusion: "success" }, // earlier
      ]),
      pr,
      headSha
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("in_progress");
    expect(result.reason).toContain("Wait for the latest run");
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
    const result = evaluateBundleBootSmokePresence(failWith(GH_API_502_ERROR), pr, headSha);
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

// ---------------------------------------------------------------------------
// Required-checks status enforcement (mt#1938)
// ---------------------------------------------------------------------------

describe("parseBranchProtectionResponse (mt#1938)", () => {
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });

  it("extracts required-check contexts and enforce_admins from a real response shape", () => {
    const body = JSON.stringify({
      required_status_checks: {
        contexts: ["build", REQUIRED_CHECK_PLACEHOLDER_TESTS],
        checks: [
          { context: "build", app_id: 15368 },
          { context: REQUIRED_CHECK_PLACEHOLDER_TESTS, app_id: 15368 },
        ],
      },
      enforce_admins: { enabled: false },
    });
    const result = parseBranchProtectionResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requiredChecks).toEqual(["build", REQUIRED_CHECK_PLACEHOLDER_TESTS]);
      expect(result.enforceAdmins).toBe(false);
    }
  });

  it("reads enforce_admins=true when the nested object has enabled:true", () => {
    const body = JSON.stringify({
      required_status_checks: { contexts: ["build"] },
      enforce_admins: { enabled: true },
    });
    const result = parseBranchProtectionResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.enforceAdmins).toBe(true);
    }
  });

  it("accepts the bare-bool enforce_admins shape (defensive)", () => {
    const body = JSON.stringify({
      required_status_checks: { contexts: ["build"] },
      enforce_admins: true,
    });
    const result = parseBranchProtectionResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.enforceAdmins).toBe(true);
    }
  });

  it("defaults enforceAdmins to false when the field is absent", () => {
    const body = JSON.stringify({ required_status_checks: { contexts: [] } });
    const result = parseBranchProtectionResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.enforceAdmins).toBe(false);
    }
  });

  it("returns an empty contexts array when no required checks are configured", () => {
    const body = JSON.stringify({
      required_status_checks: { contexts: [] },
      enforce_admins: { enabled: true },
    });
    const result = parseBranchProtectionResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requiredChecks).toEqual([]);
    }
  });

  it("returns failure when BOTH contexts and checks are missing", () => {
    const result = parseBranchProtectionResponse(ok('{"enforce_admins":{"enabled":true}}'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("required_status_checks.contexts");
      expect(result.error).toContain(".checks");
    }
  });

  it("derives requiredChecks from checks[] when contexts is absent (newer API shape)", () => {
    const body = JSON.stringify({
      required_status_checks: {
        checks: [
          { context: "build", app_id: 15368 },
          { context: REQUIRED_CHECK_PLACEHOLDER_TESTS, app_id: 15368 },
        ],
      },
      enforce_admins: { enabled: false },
    });
    const result = parseBranchProtectionResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requiredChecks).toEqual(["build", REQUIRED_CHECK_PLACEHOLDER_TESTS]);
    }
  });

  it("derives requiredChecks from checks[] when contexts is an empty array", () => {
    const body = JSON.stringify({
      required_status_checks: {
        contexts: [],
        checks: [{ context: "build", app_id: 15368 }],
      },
    });
    const result = parseBranchProtectionResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requiredChecks).toEqual(["build"]);
    }
  });

  it("dedupes when the same name appears in both contexts[] and checks[]", () => {
    const body = JSON.stringify({
      required_status_checks: {
        contexts: ["build"],
        checks: [
          { context: "build", app_id: 15368 },
          { context: REQUIRED_CHECK_PLACEHOLDER_TESTS, app_id: 15368 },
        ],
      },
    });
    const result = parseBranchProtectionResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requiredChecks).toEqual(["build", REQUIRED_CHECK_PLACEHOLDER_TESTS]);
    }
  });

  it("filters non-string context values defensively in checks[]", () => {
    const body = JSON.stringify({
      required_status_checks: {
        checks: [
          { context: "build", app_id: 15368 },
          { context: null, app_id: 15368 },
          { app_id: 15368 },
          { context: 42, app_id: 15368 },
        ],
      },
    });
    const result = parseBranchProtectionResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requiredChecks).toEqual(["build"]);
    }
  });

  it("returns failure on transport error (non-zero exit)", () => {
    const result = parseBranchProtectionResponse({
      exitCode: 1,
      stdout: "",
      stderr: "404 Not Found",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("404");
    }
  });

  it("returns failure on timeout with a distinct timed-out prefix", () => {
    const result = parseBranchProtectionResponse({
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
    const result = parseBranchProtectionResponse(ok(""));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("empty response");
    }
  });

  it("returns failure when stdout is not valid JSON", () => {
    const result = parseBranchProtectionResponse(ok("{not-json"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("failed to parse");
    }
  });
});

describe("parseAllCheckRunsResponse (mt#1938)", () => {
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });

  it("parses every check_run into the flat list (no name filtering)", () => {
    const body = JSON.stringify({
      total_count: 3,
      check_runs: [
        { name: "build", status: "completed", conclusion: "success" },
        { name: REQUIRED_CHECK_PLACEHOLDER_TESTS, status: "completed", conclusion: "success" },
        { name: BUNDLE_BOOT_SMOKE_CHECK_NAME, status: "completed", conclusion: "success" },
      ],
    });
    const result = parseAllCheckRunsResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runs).toHaveLength(3);
      expect(result.runs.map((r) => r.name)).toEqual([
        "build",
        REQUIRED_CHECK_PLACEHOLDER_TESTS,
        BUNDLE_BOOT_SMOKE_CHECK_NAME,
      ]);
      expect(result.totalCount).toBe(3);
    }
  });

  it("extracts total_count from the response (truncation guardrail input)", () => {
    const body = JSON.stringify({
      total_count: 250,
      check_runs: [{ name: "build", status: "completed", conclusion: "success" }],
    });
    const result = parseAllCheckRunsResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.totalCount).toBe(250);
      expect(result.runs).toHaveLength(1);
    }
  });

  it("falls back to runs.length for totalCount when total_count is absent", () => {
    const body = JSON.stringify({
      check_runs: [
        { name: "build", status: "completed", conclusion: "success" },
        { name: REQUIRED_CHECK_PLACEHOLDER_TESTS, status: "completed", conclusion: "success" },
      ],
    });
    const result = parseAllCheckRunsResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.totalCount).toBe(2);
    }
  });

  it("captures startedAt, completedAt, and htmlUrl when present", () => {
    const body = JSON.stringify({
      check_runs: [
        {
          name: "build",
          status: "completed",
          conclusion: "failure",
          started_at: "2026-05-19T12:00:00Z",
          completed_at: "2026-05-19T12:05:00Z",
          html_url: "https://github.com/edobry/minsky/runs/123",
        },
      ],
    });
    const result = parseAllCheckRunsResponse(ok(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const [first] = result.runs;
      expect(first?.startedAt).toBe("2026-05-19T12:00:00Z");
      expect(first?.completedAt).toBe("2026-05-19T12:05:00Z");
      expect(first?.htmlUrl).toBe("https://github.com/edobry/minsky/runs/123");
    }
  });

  it("returns empty runs[] when check_runs is empty", () => {
    const result = parseAllCheckRunsResponse(ok('{"check_runs":[]}'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runs).toEqual([]);
    }
  });

  it("returns failure when check_runs is missing from response", () => {
    const result = parseAllCheckRunsResponse(ok("{}"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("missing check_runs");
    }
  });

  it("returns failure on transport / parse errors with distinct messages", () => {
    expect(parseAllCheckRunsResponse({ exitCode: 1, stdout: "", stderr: "boom" }).ok).toBe(false);
    expect(parseAllCheckRunsResponse(ok("")).ok).toBe(false);
    expect(parseAllCheckRunsResponse(ok("null")).ok).toBe(false);
  });
});

describe("pickLatestRunByName (mt#1938)", () => {
  it("returns undefined when no run matches the name", () => {
    const result = pickLatestRunByName([], "build");
    expect(result).toBeUndefined();
  });

  it("matches exact name", () => {
    const runs = [
      {
        name: "build",
        status: "completed",
        conclusion: "success",
        htmlUrl: null,
        startedAt: null,
        completedAt: null,
      },
    ];
    const result = pickLatestRunByName(runs, "build");
    expect(result?.name).toBe("build");
  });

  it("matches workflow-prefixed name shape `<workflow> / <jobName>`", () => {
    const runs = [
      {
        name: "CI / build",
        status: "completed",
        conclusion: "success",
        htmlUrl: null,
        startedAt: null,
        completedAt: null,
      },
    ];
    const result = pickLatestRunByName(runs, "build");
    expect(result?.name).toBe("CI / build");
  });

  it("does NOT match check names that merely contain the bare token", () => {
    const runs = [
      {
        name: "build-extra",
        status: "completed",
        conclusion: "success",
        htmlUrl: null,
        startedAt: null,
        completedAt: null,
      },
      {
        name: "not-build",
        status: "completed",
        conclusion: "success",
        htmlUrl: null,
        startedAt: null,
        completedAt: null,
      },
    ];
    const result = pickLatestRunByName(runs, "build");
    expect(result).toBeUndefined();
  });

  it("picks the latest run by completedAt when multiple match", () => {
    const runs = [
      {
        name: "build",
        status: "completed",
        conclusion: "success",
        htmlUrl: null,
        startedAt: null,
        completedAt: "2026-05-19T10:00:00Z",
      },
      {
        name: "build",
        status: "completed",
        conclusion: "failure",
        htmlUrl: null,
        startedAt: null,
        completedAt: "2026-05-19T11:00:00Z",
      },
    ];
    const result = pickLatestRunByName(runs, "build");
    expect(result?.conclusion).toBe("failure");
    expect(result?.completedAt).toBe("2026-05-19T11:00:00Z");
  });

  it("falls back to startedAt when completedAt is missing", () => {
    const runs = [
      {
        name: "build",
        status: "completed",
        conclusion: "success",
        htmlUrl: null,
        startedAt: null,
        completedAt: "2026-05-19T10:00:00Z",
      },
      {
        name: "build",
        status: "in_progress",
        conclusion: null,
        htmlUrl: null,
        startedAt: "2026-05-19T11:00:00Z",
        completedAt: null,
      },
    ];
    const result = pickLatestRunByName(runs, "build");
    expect(result?.status).toBe("in_progress");
  });
});

describe("evaluateRequiredChecksStatus (mt#1938)", () => {
  const pr = "1163";
  const headSha = "2e8973f454abc123def456789012345678901234";

  const okProtection = (
    requiredChecks: string[],
    enforceAdmins = false
  ): ReturnType<typeof parseBranchProtectionResponse> => ({
    ok: true,
    requiredChecks,
    enforceAdmins,
  });
  const failProtection = (error: string): ReturnType<typeof parseBranchProtectionResponse> => ({
    ok: false,
    error,
  });
  const okRuns = (
    runs: Array<{
      name: string;
      status?: string;
      conclusion?: string | null;
      htmlUrl?: string | null;
      startedAt?: string | null;
      completedAt?: string | null;
    }>,
    options: { totalCount?: number } = {}
  ): ReturnType<typeof parseAllCheckRunsResponse> => {
    const mapped = runs.map((r) => ({
      name: r.name,
      status: r.status ?? "completed",
      conclusion: r.conclusion ?? null,
      htmlUrl: r.htmlUrl ?? null,
      startedAt: r.startedAt ?? null,
      completedAt: r.completedAt ?? null,
    }));
    return {
      ok: true,
      runs: mapped,
      totalCount: options.totalCount ?? mapped.length,
    };
  };
  const failRuns = (error: string): ReturnType<typeof parseAllCheckRunsResponse> => ({
    ok: false,
    error,
  });

  it("allows when every required check concluded success", () => {
    const result = evaluateRequiredChecksStatus(
      okProtection(["build", REQUIRED_CHECK_PLACEHOLDER_TESTS]),
      okRuns([
        { name: "build", conclusion: "success" },
        { name: REQUIRED_CHECK_PLACEHOLDER_TESTS, conclusion: "success" },
      ]),
      pr,
      headSha
    );
    expect(result.deny).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("allows when no required checks are configured (no contract to enforce)", () => {
    const result = evaluateRequiredChecksStatus(
      okProtection([]),
      okRuns([{ name: "build", conclusion: "failure" }]),
      pr,
      headSha
    );
    expect(result.deny).toBe(false);
  });

  it("DENIES when a required check has zero matching runs (PR #1163 originating-class)", () => {
    const result = evaluateRequiredChecksStatus(
      okProtection(["build", REQUIRED_CHECK_PLACEHOLDER_TESTS]),
      okRuns([{ name: REQUIRED_CHECK_PLACEHOLDER_TESTS, conclusion: "success" }]),
      pr,
      headSha
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("build");
    expect(result.reason).toContain("no matching check_run");
    expect(result.reason).toContain("mt#1938");
  });

  it("DENIES when a required check concluded failure (THE originating-incident class)", () => {
    const result = evaluateRequiredChecksStatus(
      okProtection(["build", REQUIRED_CHECK_PLACEHOLDER_TESTS]),
      okRuns([
        { name: "build", conclusion: "failure", htmlUrl: "https://github.com/x/y/runs/9" },
        { name: REQUIRED_CHECK_PLACEHOLDER_TESTS, conclusion: "success" },
      ]),
      pr,
      headSha
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("build");
    expect(result.reason).toContain("concluded failure");
    expect(result.reason).toContain("https://github.com/x/y/runs/9");
    expect(result.reason).toContain(REQUIRED_CHECKS_OVERRIDE_ENV);
  });

  it("DENIES when latest run is in_progress (wait for completion)", () => {
    const result = evaluateRequiredChecksStatus(
      okProtection(["build"]),
      okRuns([{ name: "build", status: "in_progress", conclusion: null }]),
      pr,
      headSha
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("in_progress");
    expect(result.reason).toContain("Wait for the latest run");
  });

  it("DENIES when latest run is queued (wait for completion)", () => {
    const result = evaluateRequiredChecksStatus(
      okProtection(["build"]),
      okRuns([{ name: "build", status: "queued", conclusion: null }]),
      pr,
      headSha
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("queued");
  });

  it("applies latest-wins recency: later failure overrides earlier success", () => {
    const result = evaluateRequiredChecksStatus(
      okProtection(["build"]),
      okRuns([
        {
          name: "build",
          conclusion: "success",
          completedAt: "2026-05-19T10:00:00Z",
        },
        {
          name: "build",
          conclusion: "failure",
          completedAt: "2026-05-19T11:00:00Z",
        },
      ]),
      pr,
      headSha
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("concluded failure");
  });

  it("applies latest-wins recency: later success overrides earlier failure", () => {
    const result = evaluateRequiredChecksStatus(
      okProtection(["build"]),
      okRuns([
        {
          name: "build",
          conclusion: "failure",
          completedAt: "2026-05-19T10:00:00Z",
        },
        {
          name: "build",
          conclusion: "success",
          completedAt: "2026-05-19T11:00:00Z",
        },
      ]),
      pr,
      headSha
    );
    expect(result.deny).toBe(false);
  });

  it("matches workflow-prefixed check_run names like `CI / build`", () => {
    const result = evaluateRequiredChecksStatus(
      okProtection(["build"]),
      okRuns([{ name: "CI / build", conclusion: "success" }]),
      pr,
      headSha
    );
    expect(result.deny).toBe(false);
  });

  it("DENIES with API-failure reason when branch protection parse failed", () => {
    const result = evaluateRequiredChecksStatus(
      failProtection(GH_API_502_ERROR),
      okRuns([{ name: "build", conclusion: "success" }]),
      pr,
      headSha
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("branch protection");
    expect(result.reason).toContain("502");
    expect(result.reason).toContain(REQUIRED_CHECKS_OVERRIDE_ENV);
  });

  it("DENIES with API-failure reason when all-check-runs parse failed", () => {
    const result = evaluateRequiredChecksStatus(
      okProtection(["build"]),
      failRuns("gh api exited 1: rate limit exceeded"),
      pr,
      headSha
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("check_runs");
    expect(result.reason).toContain("rate limit");
    expect(result.reason).toContain(REQUIRED_CHECKS_OVERRIDE_ENV);
  });

  it("denial reason for missing-required-check names the empty-commit webhook-wake recovery", () => {
    const result = evaluateRequiredChecksStatus(okProtection(["build"]), okRuns([]), pr, headSha);
    expect(result.reason).toContain("noFiles");
    expect(result.reason).toContain("noStage");
  });

  it("denial reasons include the PR number and short HEAD sha", () => {
    const result = evaluateRequiredChecksStatus(
      okProtection(["build"]),
      okRuns([{ name: "build", conclusion: "failure" }]),
      pr,
      headSha
    );
    expect(result.reason).toContain(`#${pr}`);
    expect(result.reason).toContain(headSha.slice(0, 7));
  });

  it("DENIES on suspected pagination truncation (totalCount > runs.length)", () => {
    // GitHub reports 250 total runs but we only have 100 in the page. The
    // latest run for `build` could be on an unreturned page — gate cannot
    // safely conclude success.
    const result = evaluateRequiredChecksStatus(
      okProtection(["build"]),
      okRuns([{ name: "build", conclusion: "success" }], { totalCount: 250 }),
      pr,
      headSha
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("truncated");
    expect(result.reason).toContain("total_count=250");
    expect(result.reason).toContain("returned=1");
    expect(result.reason).toContain("pagination guardrail");
    expect(result.reason).toContain(REQUIRED_CHECKS_OVERRIDE_ENV);
  });

  it("ALLOWS when totalCount equals runs.length (no truncation suspected)", () => {
    const result = evaluateRequiredChecksStatus(
      okProtection(["build"]),
      okRuns([{ name: "build", conclusion: "success" }], { totalCount: 1 }),
      pr,
      headSha
    );
    expect(result.deny).toBe(false);
  });

  it("ALLOWS at the boundary: totalCount=100 with 100 returned runs", () => {
    // Edge: GitHub returns exactly 100 runs and reports total=100. No truncation.
    const oneRun = { name: "build", conclusion: "success" as const };
    const runs = Array.from({ length: 99 }, (_, i) => ({
      name: `build-${i}`,
      conclusion: "success" as const,
    }));
    runs.push(oneRun);
    const result = evaluateRequiredChecksStatus(
      okProtection(["build"]),
      okRuns(runs, { totalCount: 100 }),
      pr,
      headSha
    );
    expect(result.deny).toBe(false);
  });
});
