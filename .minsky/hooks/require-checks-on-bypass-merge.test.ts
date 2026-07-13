import { describe, expect, it } from "bun:test";
import {
  extractMergeTarget,
  parsePrViewResponse,
  dispatchBypassCheck,
  type ExecSyncResult,
  type MergeTarget,
  type PrInfoLookupResult,
} from "./require-checks-on-bypass-merge";
import { findGhApiPutMergeSegment } from "./block-subagent-bypass-merge";

// Shared test fixture — matches the canonical bypass-merge command form
// the agent uses for self-authored bot PRs (see feedback_gh_api_bypass.md).
const CANONICAL_BYPASS =
  "gh api -X PUT /repos/edobry/minsky/pulls/1234/merge -f merge_method=merge";
const CANONICAL_TARGET: MergeTarget = { owner: "edobry", repo: "minsky", prNumber: "1234" };
// Safe identifier shape used in audit/deny logs after PR #1176 R2 BLOCKING:
// `owner/repo#PR-number`. Centralized so the magic-string lint doesn't fire.
const CANONICAL_SAFE_IDENTIFIER = "edobry/minsky#1234";
// Empty check-runs response — used across multiple ALLOW-path tests as the
// inputs that produce a no-required-checks-firing or empty-runs scenario.
// Extracted to dodge custom/no-magic-string-duplication.
const EMPTY_CHECK_RUNS_RESPONSE = '{"total_count":0,"check_runs":[]}';
// Second required-check name; centralized to dodge magic-string-duplication.
const PLACEHOLDER_TESTS_CHECK_NAME = "Prevent Placeholder Tests";

// Common mock-builders for the dispatch tests.
const okExec = (stdout: string): ExecSyncResult => ({ exitCode: 0, stdout, stderr: "" });
const failExec = (stderr: string): ExecSyncResult => ({ exitCode: 1, stdout: "", stderr });

const okPrInfo = (
  headSha = "abcdef0123456789abcdef0123456789abcdef01",
  baseRefName = "main"
): PrInfoLookupResult => ({ ok: true, info: { headSha, baseRefName } });
const failPrInfo = (error: string): PrInfoLookupResult => ({ ok: false, error });

// Branch protection mocks — return shape parseBranchProtectionResponse consumes
const protectionWithChecks = (...checks: string[]) =>
  okExec(
    JSON.stringify({
      required_status_checks: { contexts: checks },
      enforce_admins: { enabled: false },
    })
  );
const protectionEmpty = () => okExec(JSON.stringify({ required_status_checks: { contexts: [] } }));

const runsWithConclusion = (name: string, conclusion: string, status = "completed") =>
  okExec(
    JSON.stringify({
      total_count: 1,
      check_runs: [{ name, status, conclusion }],
    })
  );
const runsAllGreen = (...names: string[]) =>
  okExec(
    JSON.stringify({
      total_count: names.length,
      check_runs: names.map((name) => ({
        name,
        status: "completed",
        conclusion: "success",
      })),
    })
  );

// Sentinel ExecSyncResults that the test should never see (mocks for fetchers
// that shouldn't be called on the path under test).
const unreachableExec: ExecSyncResult = {
  exitCode: 99,
  stdout: "UNREACHABLE",
  stderr: "this mock should not have been invoked",
};

describe("extractMergeTarget (mt#1951 R1)", () => {
  it("extracts owner/repo/PR-number from an absolute path", () => {
    expect(extractMergeTarget("gh api -X PUT /repos/edobry/minsky/pulls/1234/merge")).toEqual({
      owner: "edobry",
      repo: "minsky",
      prNumber: "1234",
    });
  });

  it("extracts from a relative path (no leading slash)", () => {
    expect(extractMergeTarget("gh api -X PUT repos/edobry/minsky/pulls/9999/merge")).toEqual({
      owner: "edobry",
      repo: "minsky",
      prNumber: "9999",
    });
  });

  it("extracts owner/repo for non-minsky repos", () => {
    expect(extractMergeTarget("gh api -X PUT /repos/acme/other-project/pulls/5/merge")).toEqual({
      owner: "acme",
      repo: "other-project",
      prNumber: "5",
    });
  });

  it("returns null on env-var URL forms (owner/repo hidden by shell expansion)", () => {
    expect(extractMergeTarget('gh api -X PUT "$URL_BASE/pulls/42/merge"')).toBeNull();
  });

  it("returns null when segment has no /pulls/<N>/merge subpath", () => {
    expect(extractMergeTarget("gh api repos/edobry/minsky/issues/1234")).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(extractMergeTarget("")).toBeNull();
  });

  it("handles multi-digit PR numbers", () => {
    expect(extractMergeTarget("gh api -X PUT repos/owner/repo/pulls/12345678/merge")).toEqual({
      owner: "owner",
      repo: "repo",
      prNumber: "12345678",
    });
  });

  it("strips surrounding double quotes", () => {
    expect(extractMergeTarget('"gh api -X PUT /repos/edobry/minsky/pulls/1234/merge"')).toEqual(
      CANONICAL_TARGET
    );
  });
});

describe("parsePrViewResponse (mt#1951 R1)", () => {
  it("extracts headRefOid and baseRefName from a healthy response", () => {
    const result = parsePrViewResponse(
      okExec(JSON.stringify({ headRefOid: "abc123", baseRefName: "main" }))
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.headSha).toBe("abc123");
      expect(result.info.baseRefName).toBe("main");
    }
  });

  it("handles non-main base branches", () => {
    const result = parsePrViewResponse(
      okExec(JSON.stringify({ headRefOid: "abc", baseRefName: "develop" }))
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.baseRefName).toBe("develop");
    }
  });

  it("returns failure on missing headRefOid", () => {
    const result = parsePrViewResponse(okExec(JSON.stringify({ baseRefName: "main" })));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("headRefOid");
    }
  });

  it("returns failure on missing baseRefName", () => {
    const result = parsePrViewResponse(okExec(JSON.stringify({ headRefOid: "abc" })));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("baseRefName");
    }
  });

  it("returns failure on non-zero exit", () => {
    const result = parsePrViewResponse(failExec("not found"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("exited 1");
      expect(result.error).toContain("not found");
    }
  });

  it("returns failure on timeout", () => {
    const result = parsePrViewResponse({
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

  it("returns failure on empty stdout", () => {
    const result = parsePrViewResponse(okExec(""));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("empty response");
    }
  });

  it("returns failure on non-JSON stdout", () => {
    const result = parsePrViewResponse(okExec("not-json"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("failed to parse");
    }
  });
});

describe("dispatchBypassCheck — surface and skip paths (mt#1951 R1)", () => {
  // Default fetchers that should NOT be invoked on skip paths
  const defaultInput = {
    overrideEnvValue: undefined,
    agentId: undefined,
    prInfoLookup: () => failPrInfo("should not be called"),
    branchProtectionFetch: () => unreachableExec,
    checkRunsFetch: () => unreachableExec,
  };

  it("skips when tool_name is not Bash or session_exec", () => {
    const result = dispatchBypassCheck({
      ...defaultInput,
      toolName: "Read",
      command: CANONICAL_BYPASS,
    });
    expect(result.kind).toBe("skip");
  });

  it("skips when agent_id indicates subagent context", () => {
    const result = dispatchBypassCheck({
      ...defaultInput,
      toolName: "Bash",
      agentId: "subagent-uuid-123",
      command: CANONICAL_BYPASS,
    });
    expect(result.kind).toBe("skip");
  });

  it("skips when command does not contain a bypass-merge segment", () => {
    const result = dispatchBypassCheck({
      ...defaultInput,
      toolName: "Bash",
      command: "gh pr view 1234 --json title",
    });
    expect(result.kind).toBe("skip");
  });

  it("skips on bash chains that don't include the bypass", () => {
    const result = dispatchBypassCheck({
      ...defaultInput,
      toolName: "Bash",
      command: "gh pr view 1 && gh pr checks 1",
    });
    expect(result.kind).toBe("skip");
  });

  it("fires on Bash tool with matching segment (non-skip path)", () => {
    const result = dispatchBypassCheck({
      ...defaultInput,
      toolName: "Bash",
      command: CANONICAL_BYPASS,
      prInfoLookup: () => okPrInfo(),
      branchProtectionFetch: () => protectionEmpty(),
      checkRunsFetch: () => okExec(EMPTY_CHECK_RUNS_RESPONSE),
    });
    expect(result.kind).toBe("skip"); // empty required-checks → no contract → allow
  });

  it("fires on session_exec tool with matching segment", () => {
    const result = dispatchBypassCheck({
      ...defaultInput,
      toolName: "mcp__minsky__session_exec",
      command: CANONICAL_BYPASS,
      prInfoLookup: () => okPrInfo(),
      branchProtectionFetch: () => protectionEmpty(),
      checkRunsFetch: () => okExec(EMPTY_CHECK_RUNS_RESPONSE),
    });
    expect(result.kind).toBe("skip");
  });
});

describe("dispatchBypassCheck — override path (mt#1951 R1)", () => {
  const baseInput = {
    toolName: "Bash" as const,
    command: CANONICAL_BYPASS,
    agentId: undefined,
    prInfoLookup: () => unreachableExec as unknown as PrInfoLookupResult, // should not be called
    branchProtectionFetch: () => unreachableExec,
    checkRunsFetch: () => unreachableExec,
  };

  it("honors override='1'", () => {
    const result = dispatchBypassCheck({ ...baseInput, overrideEnvValue: "1" });
    expect(result.kind).toBe("override");
    if (result.kind === "override") {
      expect(result.auditLine).toContain("MINSKY_SKIP_REQUIRED_CHECKS=1");
      expect(result.auditLine).toContain("required-checks gate skipped");
      // PR #1176 R2 BLOCKING: audit line MUST NOT echo the raw matched segment
      // (which can carry -H/--header secrets). It SHOULD use the safe parsed
      // identifier (owner/repo#PR).
      expect(result.auditLine).toContain(CANONICAL_SAFE_IDENTIFIER);
      // Raw-command-echo guard: `merge_method=merge` is a flag value present in
      // the test's command. If it ever appears in the audit line, that proves
      // the line is echoing matched-segment text — the PR #1176 R2 regression.
      expect(result.auditLine).not.toContain("merge_method=merge");
      expect(result.auditLine).not.toContain("-f");
    }
  });

  it("honors override='true' (case-insensitive)", () => {
    const result = dispatchBypassCheck({ ...baseInput, overrideEnvValue: "true" });
    expect(result.kind).toBe("override");
  });

  it("honors override='TRUE'", () => {
    const result = dispatchBypassCheck({ ...baseInput, overrideEnvValue: "TRUE" });
    expect(result.kind).toBe("override");
  });

  it("honors override='yes'", () => {
    const result = dispatchBypassCheck({ ...baseInput, overrideEnvValue: "yes" });
    expect(result.kind).toBe("override");
  });

  it("does NOT honor empty override", () => {
    const result = dispatchBypassCheck({
      ...baseInput,
      overrideEnvValue: "",
      prInfoLookup: () => okPrInfo(),
      branchProtectionFetch: () => protectionEmpty(),
      checkRunsFetch: () => okExec(EMPTY_CHECK_RUNS_RESPONSE),
    });
    expect(result.kind).not.toBe("override");
  });

  it("does NOT honor override='0' or other non-matching values", () => {
    const result = dispatchBypassCheck({
      ...baseInput,
      overrideEnvValue: "0",
      prInfoLookup: () => okPrInfo(),
      branchProtectionFetch: () => protectionEmpty(),
      checkRunsFetch: () => okExec(EMPTY_CHECK_RUNS_RESPONSE),
    });
    expect(result.kind).not.toBe("override");
  });
});

describe("dispatchBypassCheck — deny-on-failure (mt#1951 R1 BLOCKING #3)", () => {
  const baseInput = {
    toolName: "Bash" as const,
    overrideEnvValue: undefined,
    agentId: undefined,
    branchProtectionFetch: () => unreachableExec,
    checkRunsFetch: () => unreachableExec,
    prInfoLookup: () => unreachableExec as unknown as PrInfoLookupResult,
  };

  it("DENIES when segment is bypass-shaped but owner/repo cannot be parsed (env-var URL)", () => {
    const result = dispatchBypassCheck({
      ...baseInput,
      command: 'gh api -X PUT "$VAR_HIDDEN_BASE/pulls/42/merge"',
      prInfoLookup: () => unreachableExec as unknown as PrInfoLookupResult,
    });
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("could not parse owner/repo/PR-number");
      expect(result.reason).toContain("MINSKY_SKIP_REQUIRED_CHECKS");
      // PR #1176 R2 BLOCKING: deny reason MUST NOT echo a token unique to the
      // matched command (the env-var name). Static descriptive text like
      // "$URL_BASE/pulls/N/merge" (example syntax in the help message) is OK,
      // but `VAR_HIDDEN_BASE` (a string only present in THIS test's command)
      // appearing in the reason would prove raw-command echo.
      expect(result.reason).not.toContain("VAR_HIDDEN_BASE");
    }
  });

  it("PR #1176 R2 BLOCKING — denial does not echo `-H Authorization` headers in matched command", () => {
    // If a future bypass command (operator or agent) included an inline auth
    // header, the deny path MUST NOT log the raw command. This test guards
    // against the regression class by simulating a command with a sensitive
    // header alongside the env-var URL form that triggers the deny path.
    const sensitiveCommand =
      'gh api -X PUT -H "Authorization: Bearer GHP_SECRETSECRETSECRET" "$VAR_HIDDEN_BASE/pulls/42/merge"';
    const result = dispatchBypassCheck({
      ...baseInput,
      command: sensitiveCommand,
      prInfoLookup: () => unreachableExec as unknown as PrInfoLookupResult,
    });
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).not.toContain("Authorization");
      expect(result.reason).not.toContain("Bearer");
      expect(result.reason).not.toContain("GHP_SECRETSECRETSECRET");
      expect(result.reason).not.toContain("VAR_HIDDEN_BASE");
    }
  });

  it("PR #1176 R2 BLOCKING — override audit-line does not echo `-H Authorization` headers", () => {
    const sensitiveCommand = `gh api -X PUT -H "Authorization: Bearer GHP_SECRETSECRETSECRET" /repos/edobry/minsky/pulls/1234/merge`;
    const result = dispatchBypassCheck({
      ...baseInput,
      command: sensitiveCommand,
      overrideEnvValue: "1",
    });
    expect(result.kind).toBe("override");
    if (result.kind === "override") {
      expect(result.auditLine).not.toContain("Authorization");
      expect(result.auditLine).not.toContain("Bearer");
      expect(result.auditLine).not.toContain("GHP_SECRETSECRETSECRET");
      // But SHOULD still contain the parsed safe identifier:
      expect(result.auditLine).toContain(CANONICAL_SAFE_IDENTIFIER);
    }
  });

  it("DENIES when PR-info lookup fails (PR doesn't exist / gh transport failure)", () => {
    const result = dispatchBypassCheck({
      ...baseInput,
      command: CANONICAL_BYPASS,
      prInfoLookup: () => failPrInfo("gh pr view exited 1: not found"),
    });
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("could not resolve PR info");
      expect(result.reason).toContain(CANONICAL_SAFE_IDENTIFIER);
      expect(result.reason).toContain("not found");
      expect(result.reason).toContain("MINSKY_SKIP_REQUIRED_CHECKS");
    }
  });
});

describe("dispatchBypassCheck — red CI gate (mt#1951 R1 BLOCKING #1+#2)", () => {
  const baseInput = {
    toolName: "Bash" as const,
    command: CANONICAL_BYPASS,
    overrideEnvValue: undefined,
    agentId: undefined,
  };

  it("DENIES when a required check has failure conclusion", () => {
    const result = dispatchBypassCheck({
      ...baseInput,
      prInfoLookup: () => okPrInfo(),
      branchProtectionFetch: () => protectionWithChecks("build"),
      checkRunsFetch: () => runsWithConclusion("build", "failure"),
    });
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("build");
      expect(result.reason).toContain("failure");
      expect(result.reason).toContain("Bypass-merge denied");
    }
  });

  it("DENIES when a required check is in_progress", () => {
    const result = dispatchBypassCheck({
      ...baseInput,
      prInfoLookup: () => okPrInfo(),
      branchProtectionFetch: () => protectionWithChecks("build"),
      checkRunsFetch: () => runsWithConclusion("build", null as unknown as string, "in_progress"),
    });
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("in_progress");
    }
  });

  it("DENIES when a required check has no matching run", () => {
    const result = dispatchBypassCheck({
      ...baseInput,
      prInfoLookup: () => okPrInfo(),
      branchProtectionFetch: () => protectionWithChecks("build", PLACEHOLDER_TESTS_CHECK_NAME),
      checkRunsFetch: () => runsAllGreen("build"), // missing PLACEHOLDER_TESTS_CHECK_NAME
    });
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain(PLACEHOLDER_TESTS_CHECK_NAME);
      expect(result.reason).toContain("no matching check_run");
    }
  });

  it("uses the PR's baseRefName for branch-protection lookup (not hardcoded 'main')", () => {
    let lookupBranch: string | undefined;
    const result = dispatchBypassCheck({
      ...baseInput,
      prInfoLookup: () => okPrInfo("abc123", "develop"),
      branchProtectionFetch: (_owner, _repo, branch) => {
        lookupBranch = branch;
        return protectionEmpty();
      },
      checkRunsFetch: () => okExec(EMPTY_CHECK_RUNS_RESPONSE),
    });
    expect(lookupBranch).toBe("develop");
    expect(result.kind).toBe("skip"); // empty required-checks → allow
  });

  it("uses the parsed owner/repo for branch-protection lookup (not hardcoded 'edobry/minsky')", () => {
    let lookupOwner: string | undefined;
    let lookupRepo: string | undefined;
    const result = dispatchBypassCheck({
      ...baseInput,
      command: "gh api -X PUT /repos/acme/widget/pulls/5/merge",
      prInfoLookup: () => okPrInfo(),
      branchProtectionFetch: (owner, repo, _branch) => {
        lookupOwner = owner;
        lookupRepo = repo;
        return protectionEmpty();
      },
      checkRunsFetch: () => okExec(EMPTY_CHECK_RUNS_RESPONSE),
    });
    expect(lookupOwner).toBe("acme");
    expect(lookupRepo).toBe("widget");
    expect(result.kind).toBe("skip");
  });

  it("uses the parsed owner/repo + actual head sha for check-runs lookup", () => {
    let runsOwner: string | undefined;
    let runsRepo: string | undefined;
    let runsSha: string | undefined;
    const expectedSha = "deadbeefcafe1234567890abcdef0123456789ab";
    dispatchBypassCheck({
      ...baseInput,
      command: "gh api -X PUT /repos/acme/widget/pulls/5/merge",
      prInfoLookup: () => okPrInfo(expectedSha, "main"),
      branchProtectionFetch: () => protectionEmpty(),
      checkRunsFetch: (owner, repo, sha) => {
        runsOwner = owner;
        runsRepo = repo;
        runsSha = sha;
        return okExec(EMPTY_CHECK_RUNS_RESPONSE);
      },
    });
    expect(runsOwner).toBe("acme");
    expect(runsRepo).toBe("widget");
    expect(runsSha).toBe(expectedSha);
  });
});

describe("dispatchBypassCheck — green CI allow (mt#1951 R1)", () => {
  const baseInput = {
    toolName: "Bash" as const,
    command: CANONICAL_BYPASS,
    overrideEnvValue: undefined,
    agentId: undefined,
  };

  it("ALLOWS when every required check concluded success", () => {
    const result = dispatchBypassCheck({
      ...baseInput,
      prInfoLookup: () => okPrInfo(),
      branchProtectionFetch: () => protectionWithChecks("build", PLACEHOLDER_TESTS_CHECK_NAME),
      checkRunsFetch: () => runsAllGreen("build", PLACEHOLDER_TESTS_CHECK_NAME),
    });
    expect(result.kind).toBe("skip"); // skip = allow at hook surface
  });

  it("ALLOWS when no required checks are configured", () => {
    const result = dispatchBypassCheck({
      ...baseInput,
      prInfoLookup: () => okPrInfo(),
      branchProtectionFetch: () => protectionEmpty(),
      checkRunsFetch: () => okExec(EMPTY_CHECK_RUNS_RESPONSE),
    });
    expect(result.kind).toBe("skip");
  });
});

// Sanity check that the segment-detection import surface is correct (no regression
// in the imported helper; basic coverage so a future rename to
// block-subagent-bypass-merge.ts doesn't silently break this hook).
describe("findGhApiPutMergeSegment integration (mt#1951)", () => {
  it("detects the canonical bypass-merge form", () => {
    expect(findGhApiPutMergeSegment(CANONICAL_BYPASS)).not.toBeNull();
  });

  it("ignores gh pr merge (uses gh CLI not gh api)", () => {
    expect(findGhApiPutMergeSegment("gh pr merge 1234 --merge")).toBeNull();
  });

  it("ignores read-only gh api calls", () => {
    expect(findGhApiPutMergeSegment("gh api repos/edobry/minsky/pulls/1234/reviews")).toBeNull();
  });
});
