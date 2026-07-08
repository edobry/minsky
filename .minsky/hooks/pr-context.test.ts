#!/usr/bin/env bun
// Tests for the shared PR-data fetch layer (mt#2617).
//
// Scope: this file tests the NEW consolidation surface (resolvePrMetaForTask,
// fetchPrContext, fetchCheckRunsRaw/fetchBranchProtectionRaw/fetchReviewsRaw,
// resolvePrRefByBranch, resolvePrBodyFromTask, fetchPrBody, withCallCounter).
// The MOVED-verbatim back-compat surface (parseGitHubRemoteUrl,
// deriveRepoFromGit, resolvePrNumber, makeProdPrDeps/fetchPrFiles) keeps its
// existing coverage in require-execution-evidence-before-merge.test.ts via
// re-export — duplicating that coverage here would test the same code twice.

import { describe, expect, it } from "bun:test";
import {
  withCallCounter,
  fetchPrMetaByCurrentBranch,
  fetchPrMetaByBranch,
  fetchPrMetaByNumber,
  resolvePrMetaForTask,
  resolvePrRefByBranch,
  fetchCheckRunsRaw,
  fetchBranchProtectionRaw,
  fetchReviewsRaw,
  fetchPrBody,
  resolvePrBodyFromTask,
  fetchPrContext,
  formatContextFailureWarnings,
  type ExecFn,
  type PrContextFailure,
} from "./pr-context";

const REPO = "edobry/minsky";
const TASK = "mt#2617";
const CWD = "/tmp";

const PR_TITLE = "feat: consolidate PR fetch";
const FILES_ENDPOINT_MATCH = "pulls/1234/files";

const PR_META_JSON = JSON.stringify({
  number: 1234,
  title: PR_TITLE,
  body: "## Summary\n\nConsolidates the fetch layer.",
  headSha: "abc1234def",
  baseBranch: "main",
});

/** Builds an ExecFn that returns canned responses based on command prefix (matches
 * the makeExecFn helper pattern used in require-execution-evidence-before-merge.test.ts). */
function makeExecFn(responses: Array<{ match: string; exitCode: number; stdout: string }>): ExecFn {
  return (cmd: string[]) => {
    const joined = cmd.join(" ");
    for (const r of responses) {
      if (joined.includes(r.match)) {
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: "" };
      }
    }
    return { exitCode: 1, stdout: "", stderr: "no match" };
  };
}

// ---------------------------------------------------------------------------
// withCallCounter
// ---------------------------------------------------------------------------

describe("withCallCounter", () => {
  it("starts at zero", () => {
    const { count } = withCallCounter(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    expect(count()).toBe(0);
  });

  it("increments once per exec invocation", () => {
    const { exec, count } = withCallCounter(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    exec(["gh", "pr", "view"]);
    exec(["gh", "api", "x"]);
    expect(count()).toBe(2);
  });

  it("forwards the call to the wrapped exec fn", () => {
    let seen: string[] | null = null;
    const { exec } = withCallCounter((cmd) => {
      seen = cmd;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });
    const result = exec(["gh", "pr", "view"]);
    expect(seen).toEqual(["gh", "pr", "view"]);
    expect(result.stdout).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// fetchPrMetaBy* — single-call meta resolution
// ---------------------------------------------------------------------------

describe("fetchPrMetaByCurrentBranch", () => {
  it("parses a full PrMeta object from a successful gh pr view call", () => {
    const exec = makeExecFn([{ match: "pr view", exitCode: 0, stdout: PR_META_JSON }]);
    const meta = fetchPrMetaByCurrentBranch(REPO, { cwd: CWD, exec });
    expect(meta).toEqual({
      number: 1234,
      title: "feat: consolidate PR fetch",
      body: "## Summary\n\nConsolidates the fetch layer.",
      headSha: "abc1234def",
      baseBranch: "main",
    });
  });

  it("returns null on non-zero exit", () => {
    const exec = makeExecFn([{ match: "pr view", exitCode: 1, stdout: "" }]);
    expect(fetchPrMetaByCurrentBranch(REPO, { cwd: CWD, exec })).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    const exec = makeExecFn([{ match: "pr view", exitCode: 0, stdout: "not json" }]);
    expect(fetchPrMetaByCurrentBranch(REPO, { cwd: CWD, exec })).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    const exec = makeExecFn([
      { match: "pr view", exitCode: 0, stdout: JSON.stringify({ number: 1 }) },
    ]);
    expect(fetchPrMetaByCurrentBranch(REPO, { cwd: CWD, exec })).toBeNull();
  });

  it("issues exactly one gh call", () => {
    const { exec, count } = withCallCounter(
      makeExecFn([{ match: "pr view", exitCode: 0, stdout: PR_META_JSON }])
    );
    fetchPrMetaByCurrentBranch(REPO, { cwd: CWD, exec });
    expect(count()).toBe(1);
  });
});

describe("fetchPrMetaByBranch", () => {
  it("parses meta from a gh pr list --head call", () => {
    const exec = makeExecFn([{ match: "pr list", exitCode: 0, stdout: PR_META_JSON }]);
    const meta = fetchPrMetaByBranch(REPO, "task/mt-2617", { cwd: CWD, exec });
    expect(meta?.number).toBe(1234);
    expect(meta?.baseBranch).toBe("main");
  });

  it("returns null when no PR matches (jq .[0] on empty array -> 'null')", () => {
    const exec = makeExecFn([{ match: "pr list", exitCode: 0, stdout: "null" }]);
    expect(fetchPrMetaByBranch(REPO, "task/mt-2617", { cwd: CWD, exec })).toBeNull();
  });

  it("includes the branch name in the command", () => {
    let seenCmd: string[] = [];
    const exec: ExecFn = (cmd) => {
      seenCmd = cmd;
      return { exitCode: 0, stdout: PR_META_JSON, stderr: "" };
    };
    fetchPrMetaByBranch(REPO, "task/mt-2617", { cwd: CWD, exec });
    expect(seenCmd.join(" ")).toContain("task/mt-2617");
  });
});

describe("fetchPrMetaByNumber", () => {
  it("parses meta from a gh pr view <n> call", () => {
    const exec = makeExecFn([{ match: "pr view 1234", exitCode: 0, stdout: PR_META_JSON }]);
    const meta = fetchPrMetaByNumber(REPO, 1234, { cwd: CWD, exec });
    expect(meta?.number).toBe(1234);
  });
});

// ---------------------------------------------------------------------------
// resolvePrMetaForTask — the consolidated resolvePrNumber+fetchPrMeta replacement
// ---------------------------------------------------------------------------

describe("resolvePrMetaForTask", () => {
  it("resolves via current branch in ONE call (primary path)", () => {
    const { exec, count } = withCallCounter(
      makeExecFn([{ match: "pr view", exitCode: 0, stdout: PR_META_JSON }])
    );
    const { meta, warning } = resolvePrMetaForTask(REPO, TASK, { cwd: CWD, exec });
    expect(meta?.number).toBe(1234);
    expect(warning).toBeUndefined();
    expect(count()).toBe(1);
  });

  it("falls back to branch-name lookup in exactly TWO calls when current-branch fails", () => {
    const { exec, count } = withCallCounter(
      makeExecFn([
        { match: "pr view --repo", exitCode: 1, stdout: "" },
        { match: "pr list", exitCode: 0, stdout: PR_META_JSON },
      ])
    );
    const { meta, warning } = resolvePrMetaForTask(REPO, TASK, { cwd: CWD, exec });
    expect(meta?.number).toBe(1234);
    expect(warning).toBeUndefined();
    expect(count()).toBe(2);
  });

  it("uses task-derived branch (task/<id>) in the fallback call", () => {
    const seenCmds: string[] = [];
    const exec: ExecFn = (cmd) => {
      seenCmds.push(cmd.join(" "));
      if (cmd.join(" ").includes("pr view")) return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd.join(" ").includes("pr list"))
        return { exitCode: 0, stdout: PR_META_JSON, stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "" };
    };
    resolvePrMetaForTask(REPO, TASK, { cwd: CWD, exec });
    const listCmd = seenCmds.find((c) => c.includes("pr list"));
    expect(listCmd).toContain("task/mt-2617");
  });

  it("returns a warning when both paths fail", () => {
    const exec = makeExecFn([
      { match: "pr view", exitCode: 1, stdout: "" },
      { match: "pr list", exitCode: 1, stdout: "" },
    ]);
    const { meta, warning } = resolvePrMetaForTask(REPO, TASK, { cwd: CWD, exec });
    expect(meta).toBeNull();
    expect(warning).toBeDefined();
    expect(warning).toContain("gh pr view");
    expect(warning).toContain("gh pr list");
  });
});

// ---------------------------------------------------------------------------
// resolvePrRefByBranch — review-gate's string-typed {pr, headSha, baseBranch}
// ---------------------------------------------------------------------------

describe("resolvePrRefByBranch", () => {
  it("returns pr/headSha/baseBranch as strings in ONE call", () => {
    const { exec, count } = withCallCounter(
      makeExecFn([{ match: "pr list", exitCode: 0, stdout: PR_META_JSON }])
    );
    const ref = resolvePrRefByBranch(REPO, "task/mt-2617", { cwd: CWD, exec });
    expect(ref).toEqual({ pr: "1234", headSha: "abc1234def", baseBranch: "main" });
    expect(count()).toBe(1);
  });

  it("returns null (not an error object) when no PR is found — matches silent-exit contract", () => {
    const exec = makeExecFn([{ match: "pr list", exitCode: 0, stdout: "null" }]);
    expect(resolvePrRefByBranch(REPO, "task/mt-2617", { cwd: CWD, exec })).toBeNull();
  });

  it("returns null on transport failure too — matches pre-mt#2617 `if (!pr) exit(0)`", () => {
    const exec = makeExecFn([{ match: "pr list", exitCode: 1, stdout: "" }]);
    expect(resolvePrRefByBranch(REPO, "task/mt-2617", { cwd: CWD, exec })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchCheckRunsRaw / fetchBranchProtectionRaw / fetchReviewsRaw — single-call
// raw fetch, caller parses.
// ---------------------------------------------------------------------------

describe("fetchCheckRunsRaw", () => {
  it("requests per_page=100 (so ONE fetch covers presence + name-filter + full-enumeration)", () => {
    let seenCmd: string[] = [];
    const exec: ExecFn = (cmd) => {
      seenCmd = cmd;
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };
    fetchCheckRunsRaw(REPO, "abc123", { cwd: CWD, exec });
    const joined = seenCmd.join(" ");
    expect(joined).toContain("check-runs?per_page=100");
    expect(joined).not.toContain("check_name=");
  });

  it("issues exactly one gh call regardless of how many consumers parse the result", () => {
    const { exec, count } = withCallCounter(() => ({ exitCode: 0, stdout: "{}", stderr: "" }));
    const raw = fetchCheckRunsRaw(REPO, "abc123", { cwd: CWD, exec });
    // Simulate three consumers (presence / bundle-boot / required-checks) all
    // parsing the SAME raw result without triggering additional fetches.
    JSON.parse(raw.stdout || "{}");
    JSON.parse(raw.stdout || "{}");
    JSON.parse(raw.stdout || "{}");
    expect(count()).toBe(1);
  });
});

describe("fetchBranchProtectionRaw", () => {
  it("targets the caller-supplied branch, not a hardcoded 'main'", () => {
    let seenCmd: string[] = [];
    const exec: ExecFn = (cmd) => {
      seenCmd = cmd;
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };
    fetchBranchProtectionRaw(REPO, "release/2.0", { cwd: CWD, exec });
    expect(seenCmd.join(" ")).toContain("branches/release/2.0/protection");
  });
});

describe("fetchReviewsRaw", () => {
  it("targets the given repo + PR number", () => {
    let seenCmd: string[] = [];
    const exec: ExecFn = (cmd) => {
      seenCmd = cmd;
      return { exitCode: 0, stdout: "[]", stderr: "" };
    };
    fetchReviewsRaw(REPO, 1234, { cwd: CWD, exec });
    expect(seenCmd.join(" ")).toContain(`repos/${REPO}/pulls/1234/reviews`);
  });
});

// ---------------------------------------------------------------------------
// fetchPrBody / resolvePrBodyFromTask — block-out-of-band-merge's needs
// ---------------------------------------------------------------------------

describe("fetchPrBody", () => {
  it("returns the body on success", () => {
    const exec = makeExecFn([{ match: "pr view 42", exitCode: 0, stdout: "some body text" }]);
    const result = fetchPrBody(REPO, 42, { cwd: CWD, exec });
    expect(result).toEqual({ ok: true, body: "some body text" });
  });

  it("returns a structured error on non-zero exit", () => {
    const exec: ExecFn = () => ({ exitCode: 1, stdout: "", stderr: "boom" });
    const result = fetchPrBody(REPO, 42, { cwd: CWD, exec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("boom");
  });

  it("distinguishes a timeout from a plain non-zero exit", () => {
    const exec: ExecFn = () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: true });
    const result = fetchPrBody(REPO, 42, { cwd: CWD, exec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("timed out");
  });
});

describe("resolvePrBodyFromTask", () => {
  it("returns null for an empty task (no-op)", () => {
    expect(resolvePrBodyFromTask(REPO, "", {})).toBeNull();
  });

  it("returns {ok:true, prNumber, body} on success — ONE call", () => {
    const { exec, count } = withCallCounter(
      makeExecFn([
        {
          match: "pr list",
          exitCode: 0,
          stdout: JSON.stringify({ number: 55, body: "the body" }),
        },
      ])
    );
    const result = resolvePrBodyFromTask(REPO, TASK, { cwd: CWD, exec });
    expect(result).toEqual({ ok: true, prNumber: 55, body: "the body" });
    expect(count()).toBe(1);
  });

  it("returns null (not an error) when no PR exists for the branch", () => {
    const exec = makeExecFn([{ match: "pr list", exitCode: 0, stdout: "null" }]);
    expect(resolvePrBodyFromTask(REPO, TASK, { cwd: CWD, exec })).toBeNull();
  });

  it("returns a structured error on transport failure", () => {
    const exec: ExecFn = () => ({ exitCode: 1, stdout: "", stderr: "network down" });
    const result = resolvePrBodyFromTask(REPO, TASK, { cwd: CWD, exec });
    expect(result && "ok" in result && result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchPrContext — the top-level consolidated entry point
// ---------------------------------------------------------------------------

describe("fetchPrContext", () => {
  it("resolves by prNumber in ONE call when files are not requested", () => {
    const exec = makeExecFn([{ match: "pr view 1234", exitCode: 0, stdout: PR_META_JSON }]);
    const result = fetchPrContext(REPO, { prNumber: 1234, cwd: CWD, exec });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prNumber).toBe(1234);
      expect(result.title).toBe(PR_TITLE);
      expect(result.baseBranch).toBe("main");
      expect(result.files).toEqual([]);
      expect(result.ghCallCount).toBe(1);
    }
  });

  it("resolves by task via current-branch primary path in ONE call", () => {
    const exec = makeExecFn([{ match: "pr view", exitCode: 0, stdout: PR_META_JSON }]);
    const result = fetchPrContext(REPO, { task: TASK, cwd: CWD, exec });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ghCallCount).toBe(1);
  });

  it("fetches files in a SECOND call when include.files is set", () => {
    const exec = makeExecFn([
      { match: "pr view", exitCode: 0, stdout: PR_META_JSON },
      {
        match: FILES_ENDPOINT_MATCH,
        exitCode: 0,
        stdout: JSON.stringify([{ filename: "a.test.ts", status: "added" }]),
      },
    ]);
    const result = fetchPrContext(REPO, { task: TASK, cwd: CWD, exec, include: { files: true } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files).toEqual([{ filename: "a.test.ts", status: "added" }]);
      expect(result.ghCallCount).toBe(2);
    }
  });

  it("total calls for execution-evidence-shaped usage (meta+files) is 2, down from up to 3", () => {
    // Pre-mt#2617: resolvePrNumber (1-2 calls) + fetchPrMeta (1 call) + fetchPrFiles
    // (1 call) = up to 4 on the fallback path, 3 on the happy path.
    // Post-mt#2617: resolvePrMetaForTask (1 call happy path) + fetchPrFiles (1 call) = 2.
    const exec = makeExecFn([
      { match: "pr view", exitCode: 0, stdout: PR_META_JSON },
      {
        match: FILES_ENDPOINT_MATCH,
        exitCode: 0,
        stdout: JSON.stringify([{ filename: "src/x.ts", status: "modified" }]),
      },
    ]);
    const result = fetchPrContext(REPO, { task: TASK, cwd: CWD, exec, include: { files: true } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ghCallCount).toBe(2);
  });

  it("returns a failure result (not a throw) when PR resolution fails entirely", () => {
    const exec: ExecFn = () => ({ exitCode: 1, stdout: "", stderr: "" });
    const result = fetchPrContext(REPO, { task: TASK, cwd: CWD, exec });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.warning).toBeDefined();
      expect(result.ghCallCount).toBe(2); // current-branch attempt + branch-name fallback
    }
  });

  it("failure result always carries a `warnings` array (mt#2617 R1 BLOCKING #2) — never undefined", () => {
    const exec: ExecFn = () => ({ exitCode: 1, stdout: "", stderr: "" });
    const result = fetchPrContext(REPO, { task: TASK, cwd: CWD, exec });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Array.isArray(result.warnings)).toBe(true);
    }
  });

  it("propagates a fetchPrFiles warning without failing the whole context", () => {
    const exec = makeExecFn([
      { match: "pr view", exitCode: 0, stdout: PR_META_JSON },
      { match: FILES_ENDPOINT_MATCH, exitCode: 1, stdout: "" },
    ]);
    const result = fetchPrContext(REPO, { task: TASK, cwd: CWD, exec, include: { files: true } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files).toEqual([]);
      expect(result.warnings.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// formatContextFailureWarnings — mt#2617 R1 BLOCKING #2
// ---------------------------------------------------------------------------
//
// Pre-mt#2617, execution-evidence and deploy-verification fetched files and
// meta as two INDEPENDENT gh calls, so a fetchPrFiles warning could exist
// alongside a meta-resolution failure — and the pre-refactor fail-open path
// surfaced BOTH. The post-mt#2617 fail-open path (`context.warning` only)
// silently dropped any accumulated `context.warnings`. This is the shared
// fix every gate's fail-open branch consumes.

const RESOLUTION_FAILURE_WARNING = "Could not resolve PR metadata.";

describe("formatContextFailureWarnings (mt#2617 R1 BLOCKING #2)", () => {
  it("includes the primary resolution warning", () => {
    const failure: PrContextFailure = {
      ok: false,
      warning: RESOLUTION_FAILURE_WARNING,
      warnings: [],
      ghCallCount: 2,
    };
    expect(formatContextFailureWarnings(failure)).toContain(RESOLUTION_FAILURE_WARNING);
  });

  it("includes accumulated per-call warnings ahead of the primary resolution warning", () => {
    const failure: PrContextFailure = {
      ok: false,
      warning: RESOLUTION_FAILURE_WARNING,
      warnings: ["fetchPrFiles: gh api failed (exit 1) for PR #42 — test-file detection skipped."],
      ghCallCount: 3,
    };
    const formatted = formatContextFailureWarnings(failure);
    expect(formatted).toEqual([
      "fetchPrFiles: gh api failed (exit 1) for PR #42 — test-file detection skipped.",
      RESOLUTION_FAILURE_WARNING,
    ]);
  });

  it("does not silently drop warnings when there are multiple accumulated entries", () => {
    const failure: PrContextFailure = {
      ok: false,
      warning: "final failure reason",
      warnings: ["first accumulated warning", "second accumulated warning"],
      ghCallCount: 4,
    };
    expect(formatContextFailureWarnings(failure)).toEqual([
      "first accumulated warning",
      "second accumulated warning",
      "final failure reason",
    ]);
  });
});
