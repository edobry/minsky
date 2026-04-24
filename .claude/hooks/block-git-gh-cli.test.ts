import { describe, expect, it } from "bun:test";
import {
  checkDenial,
  ghDenials,
  gitDenials,
  parseCommands,
  parseSegment,
  splitOnShellOperators,
  stripEnvVarAssignments,
  toolContextFromName,
  findGhApiMethod,
  findGhApiEndpoint,
  findGhApiField,
  SESSION_EXEC_TOOL_NAME,
} from "./block-git-gh-cli";

/** Minsky MCP tool names referenced in denial reasons — hoisted to avoid magic-string duplication in tests. */
const SESSION_COMMIT_TOOL = "mcp__minsky__session_commit";

// ---------------------------------------------------------------------------
// toolContextFromName
// ---------------------------------------------------------------------------

describe("toolContextFromName", () => {
  it("maps session_exec tool name to 'session_exec' context", () => {
    expect(toolContextFromName(SESSION_EXEC_TOOL_NAME)).toBe("session_exec");
  });

  it("maps Bash to 'bash' context", () => {
    expect(toolContextFromName("Bash")).toBe("bash");
  });

  it("maps any other tool name to 'bash' context (default)", () => {
    expect(toolContextFromName("Edit")).toBe("bash");
    expect(toolContextFromName("")).toBe("bash");
    expect(toolContextFromName("mcp__minsky__session_commit")).toBe("bash");
  });
});

// ---------------------------------------------------------------------------
// checkDenial — session_exec context (carve-outs preserved)
// ---------------------------------------------------------------------------

describe("checkDenial — session_exec context", () => {
  const deniedViaSessionExec = (subcommand: string, extraArgs: string[] = []) =>
    checkDenial({ binary: "git", args: [subcommand, ...extraArgs] }, "session_exec");

  // The four rules that are self-referential on session_exec — MUST be allowed
  // when invoked via session_exec (otherwise the rule's reason contradicts itself).
  it("allows `git status` via session_exec (self-referential carve-out)", () => {
    expect(deniedViaSessionExec("status")).toBeNull();
  });

  it("allows `git stash` via session_exec (self-referential carve-out)", () => {
    expect(deniedViaSessionExec("stash")).toBeNull();
  });

  it("allows `git reset` via session_exec (self-referential carve-out)", () => {
    expect(deniedViaSessionExec("reset")).toBeNull();
    expect(deniedViaSessionExec("reset", ["--hard", "HEAD"])).toBeNull();
  });

  it("denies `git -C <path> status` via session_exec (prevents bypass)", () => {
    // Regression guard for the mt#1196 minsky-reviewer finding: -C was
    // originally carved out as `allowedInSessionExec: true`. That let
    // `git -C /anywhere commit|push|merge|...` slip through because the -C
    // rule fired first (args[0] === "-C"), got skipped as a carve-out, and
    // no subsequent rule matched (they all check args[0] for a subcommand).
    // Denying -C unconditionally closes the bypass.
    expect(
      checkDenial({ binary: "git", args: ["-C", "/some/path", "status"] }, "session_exec")
    ).not.toBeNull();
  });

  it("denies `git -C <path> commit` via session_exec (bypass attempt)", () => {
    expect(
      checkDenial(
        { binary: "git", args: ["-C", "/some/path", "commit", "-m", "x"] },
        "session_exec"
      )
    ).not.toBeNull();
  });

  it("denies `git -C <path> push` via session_exec (bypass attempt)", () => {
    expect(
      checkDenial({ binary: "git", args: ["-C", "/some/path", "push"] }, "session_exec")
    ).not.toBeNull();
  });

  it("denies `git -C <path> merge` via session_exec (bypass attempt)", () => {
    expect(
      checkDenial(
        { binary: "git", args: ["-C", "/some/path", "merge", "origin/main"] },
        "session_exec"
      )
    ).not.toBeNull();
  });

  // All other git denials still fire via session_exec — these are the loophole
  // cases from the PR #717 incident retrospective (mt#1196).
  it("denies `git log` via session_exec (use git_log MCP tool)", () => {
    const reason = deniedViaSessionExec("log");
    expect(reason).not.toBeNull();
    expect(reason).toContain("mcp__minsky__git_log");
  });

  it("denies `git diff` via session_exec (use git_diff/session_diff MCP tools)", () => {
    const reason = deniedViaSessionExec("diff");
    expect(reason).not.toBeNull();
    expect(reason).toContain("mcp__minsky__git_diff");
  });

  it("denies `git commit` via session_exec (use session_commit)", () => {
    const reason = deniedViaSessionExec("commit");
    expect(reason).not.toBeNull();
    expect(reason).toContain(SESSION_COMMIT_TOOL);
  });

  it("denies `git add` via session_exec (use session_commit all:true)", () => {
    expect(deniedViaSessionExec("add")).not.toBeNull();
  });

  it("denies `git push` via session_exec", () => {
    expect(deniedViaSessionExec("push")).not.toBeNull();
  });

  it("denies `git merge` via session_exec (use session_pr_merge)", () => {
    const reason = deniedViaSessionExec("merge");
    expect(reason).not.toBeNull();
    expect(reason).toContain("mcp__minsky__session_pr_merge");
  });

  it("denies `git rebase` via session_exec (use session_update)", () => {
    expect(deniedViaSessionExec("rebase")).not.toBeNull();
  });

  it("denies `git checkout` via session_exec", () => {
    expect(deniedViaSessionExec("checkout")).not.toBeNull();
  });

  it("denies `git fetch` via session_exec (handled by session_update)", () => {
    expect(deniedViaSessionExec("fetch")).not.toBeNull();
  });

  it("denies `git clone` via session_exec (use session_start)", () => {
    expect(deniedViaSessionExec("clone")).not.toBeNull();
  });

  it("denies `git blame` via session_exec (use git_blame)", () => {
    expect(deniedViaSessionExec("blame")).not.toBeNull();
  });

  it("denies `git branch` via session_exec", () => {
    expect(deniedViaSessionExec("branch")).not.toBeNull();
  });

  it("denies `git pull` via session_exec", () => {
    expect(deniedViaSessionExec("pull")).not.toBeNull();
  });

  it("allows `git show` via session_exec (not in denial table; real MCP gap)", () => {
    expect(deniedViaSessionExec("show")).toBeNull();
  });

  it("allows `git cherry-pick` via session_exec (not in denial table)", () => {
    expect(deniedViaSessionExec("cherry-pick")).toBeNull();
  });

  // All gh denials fire the same way on both contexts (no carve-outs).
  it("denies `gh pr create` via session_exec", () => {
    const reason = checkDenial({ binary: "gh", args: ["pr", "create"] }, "session_exec");
    expect(reason).not.toBeNull();
  });

  it("denies `gh pr review` via session_exec", () => {
    const reason = checkDenial({ binary: "gh", args: ["pr", "review"] }, "session_exec");
    expect(reason).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkDenial — bash context regression (default behavior unchanged)
// ---------------------------------------------------------------------------

describe("checkDenial — bash context (regression: no change from prior behavior)", () => {
  const deniedViaBash = (subcommand: string) =>
    checkDenial({ binary: "git", args: [subcommand] }, "bash");

  it("still denies `git status` on Bash (existing behavior)", () => {
    expect(deniedViaBash("status")).not.toBeNull();
  });

  it("still denies `git stash` on Bash (existing behavior)", () => {
    expect(deniedViaBash("stash")).not.toBeNull();
  });

  it("still denies `git reset` on Bash (existing behavior)", () => {
    expect(deniedViaBash("reset")).not.toBeNull();
  });

  it("still denies `git -C <path>` on Bash (existing behavior)", () => {
    expect(checkDenial({ binary: "git", args: ["-C", "/some/path"] }, "bash")).not.toBeNull();
  });

  it("default context (no arg) behaves as bash — denies `git status`", () => {
    expect(checkDenial({ binary: "git", args: ["status"] })).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stripEnvVarAssignments
// ---------------------------------------------------------------------------

describe("stripEnvVarAssignments", () => {
  it("strips a single env var prefix", () => {
    expect(stripEnvVarAssignments(["FOO=bar", "git", "status"])).toEqual(["git", "status"]);
  });

  it("strips multiple env var prefixes", () => {
    expect(stripEnvVarAssignments(["A=1", "B=2", "git", "commit"])).toEqual(["git", "commit"]);
  });

  it("leaves non-env-var tokens untouched", () => {
    expect(stripEnvVarAssignments(["git", "status"])).toEqual(["git", "status"]);
  });

  it("returns empty for all-env-var input", () => {
    expect(stripEnvVarAssignments(["FOO=bar"])).toEqual([]);
  });

  it("handles lowercase var names (not matching the pattern — leave them)", () => {
    // lowercase env vars are NOT stripped; only [A-Z_][A-Z0-9_]* prefix counts
    expect(stripEnvVarAssignments(["foo=bar", "git", "status"])).toEqual([
      "foo=bar",
      "git",
      "status",
    ]);
  });
});

// ---------------------------------------------------------------------------
// splitOnShellOperators
// ---------------------------------------------------------------------------

describe("splitOnShellOperators", () => {
  it("splits on &&", () => {
    expect(splitOnShellOperators("echo hi && git status")).toEqual(["echo hi", "git status"]);
  });

  it("splits on ||", () => {
    expect(splitOnShellOperators("git diff || true")).toEqual(["git diff", "true"]);
  });

  it("splits on ;", () => {
    expect(splitOnShellOperators("cd /tmp; git log")).toEqual(["cd /tmp", "git log"]);
  });

  it("splits on |", () => {
    expect(splitOnShellOperators("git log | head -5")).toEqual(["git log", "head -5"]);
  });

  it("handles multiple operators", () => {
    expect(splitOnShellOperators("A=1 git add . && git commit -m 'msg'")).toEqual([
      "A=1 git add .",
      "git commit -m 'msg'",
    ]);
  });

  it("returns single segment with no operators", () => {
    expect(splitOnShellOperators("ls -la")).toEqual(["ls -la"]);
  });

  it("filters empty segments", () => {
    expect(splitOnShellOperators("git status;")).toEqual(["git status"]);
  });
});

// ---------------------------------------------------------------------------
// parseSegment
// ---------------------------------------------------------------------------

describe("parseSegment", () => {
  it("parses a plain git command", () => {
    expect(parseSegment("git status")).toEqual({ binary: "git", args: ["status"] });
  });

  it("parses a plain gh command", () => {
    expect(parseSegment("gh pr create")).toEqual({ binary: "gh", args: ["pr", "create"] });
  });

  it("strips env vars before binary detection", () => {
    expect(parseSegment("GIT_DIR=.git git log --oneline")).toEqual({
      binary: "git",
      args: ["log", "--oneline"],
    });
  });

  it("returns null for non-git/gh commands", () => {
    expect(parseSegment("ls -la")).toBeNull();
    expect(parseSegment("echo hello")).toBeNull();
    expect(parseSegment("chmod +x file.ts")).toBeNull();
  });

  it("returns null for empty segment", () => {
    expect(parseSegment("")).toBeNull();
    expect(parseSegment("   ")).toBeNull();
  });

  it("handles git -C pattern", () => {
    expect(parseSegment("git -C /some/path status")).toEqual({
      binary: "git",
      args: ["-C", "/some/path", "status"],
    });
  });
});

// ---------------------------------------------------------------------------
// parseCommands
// ---------------------------------------------------------------------------

describe("parseCommands", () => {
  it("finds one git command in simple string", () => {
    expect(parseCommands("git commit -m 'hello'")).toEqual([
      { binary: "git", args: ["commit", "-m", "'hello'"] },
    ]);
  });

  it("finds multiple git/gh commands in chained string", () => {
    const result = parseCommands("git add . && git commit -m 'x' && gh pr create");
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ binary: "git", args: ["add", "."] });
    expect(result[1]).toEqual({ binary: "git", args: ["commit", "-m", "'x'"] });
    expect(result[2]).toEqual({ binary: "gh", args: ["pr", "create"] });
  });

  it("ignores non-git/gh segments", () => {
    expect(parseCommands("echo 'hello' && ls -la")).toEqual([]);
  });

  it("mixes git and non-git segments", () => {
    const result = parseCommands("cd /tmp && git status");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ binary: "git", args: ["status"] });
  });
});

// ---------------------------------------------------------------------------
// checkDenial — git commands
// ---------------------------------------------------------------------------

describe("checkDenial — git", () => {
  const denied = (subcommand: string, extraArgs: string[] = []) =>
    checkDenial({ binary: "git", args: [subcommand, ...extraArgs] });

  it("denies git add", () => {
    expect(denied("add")).not.toBeNull();
  });

  it("denies git commit", () => {
    expect(denied("commit")).not.toBeNull();
  });

  it("denies git push", () => {
    expect(denied("push")).not.toBeNull();
  });

  it("denies git status", () => {
    expect(denied("status")).not.toBeNull();
  });

  it("denies git log", () => {
    expect(denied("log")).not.toBeNull();
  });

  it("denies git diff", () => {
    expect(denied("diff")).not.toBeNull();
  });

  it("denies git blame", () => {
    expect(denied("blame")).not.toBeNull();
  });

  it("denies git fetch", () => {
    expect(denied("fetch")).not.toBeNull();
  });

  it("denies git pull", () => {
    expect(denied("pull")).not.toBeNull();
  });

  it("denies git clone", () => {
    expect(denied("clone")).not.toBeNull();
  });

  it("denies git checkout", () => {
    expect(denied("checkout")).not.toBeNull();
  });

  it("denies git branch", () => {
    expect(denied("branch")).not.toBeNull();
  });

  it("denies git merge", () => {
    expect(denied("merge")).not.toBeNull();
  });

  it("denies git rebase", () => {
    expect(denied("rebase")).not.toBeNull();
  });

  it("denies git stash", () => {
    expect(denied("stash")).not.toBeNull();
  });

  it("denies git reset", () => {
    expect(denied("reset")).not.toBeNull();
  });

  it("denies git reset --hard HEAD", () => {
    expect(denied("reset", ["--hard", "HEAD"])).not.toBeNull();
  });

  it("denial reason for git reset references session_exec and destructive warning", () => {
    const reason = denied("reset");
    expect(reason).toContain("mcp__minsky__session_exec");
    expect(reason).toContain("destructive");
  });

  it("denies git -C <path> <anything>", () => {
    expect(checkDenial({ binary: "git", args: ["-C", "/some/path", "status"] })).not.toBeNull();
  });

  it("allows git cherry-pick (not in denial table)", () => {
    expect(denied("cherry-pick")).toBeNull();
  });

  it("allows git show (not in denial table)", () => {
    expect(denied("show")).toBeNull();
  });

  it("allows git rev-parse (not in denial table)", () => {
    expect(denied("rev-parse")).toBeNull();
  });

  it("allows git config (not in denial table)", () => {
    expect(denied("config")).toBeNull();
  });

  it("returns null when no subcommand provided", () => {
    expect(checkDenial({ binary: "git", args: [] })).toBeNull();
  });

  it("denial reason for git add references session_commit", () => {
    const reason = denied("add");
    expect(reason).toContain(SESSION_COMMIT_TOOL);
  });

  it("denial reason for git -C references session_exec", () => {
    const reason = checkDenial({ binary: "git", args: ["-C", "/path"] });
    expect(reason).toContain("mcp__minsky__session_exec");
  });
});

// ---------------------------------------------------------------------------
// checkDenial — gh commands
// ---------------------------------------------------------------------------

describe("checkDenial — gh", () => {
  const denied = (...args: string[]) => checkDenial({ binary: "gh", args });

  it("denies gh pr create", () => {
    expect(denied("pr", "create")).not.toBeNull();
  });

  it("denies gh pr list", () => {
    expect(denied("pr", "list")).not.toBeNull();
  });

  it("denies gh pr view", () => {
    expect(denied("pr", "view")).not.toBeNull();
  });

  it("denies gh pr get", () => {
    expect(denied("pr", "get")).not.toBeNull();
  });

  it("denies gh pr merge", () => {
    expect(denied("pr", "merge")).not.toBeNull();
  });

  it("denies gh pr review", () => {
    expect(denied("pr", "review")).not.toBeNull();
  });

  it("denies gh issue create", () => {
    expect(denied("issue", "create")).not.toBeNull();
  });

  it("denies gh issue list", () => {
    expect(denied("issue", "list")).not.toBeNull();
  });

  it("denies gh issue view", () => {
    expect(denied("issue", "view")).not.toBeNull();
  });

  it("allows gh workflow (not in denial table)", () => {
    expect(denied("workflow", "run")).toBeNull();
  });

  it("allows gh api (not in denial table)", () => {
    expect(denied("api", "/repos")).toBeNull();
  });

  it("allows gh auth (not in denial table)", () => {
    expect(denied("auth", "login")).toBeNull();
  });

  it("allows gh repo (not in denial table)", () => {
    expect(denied("repo", "view")).toBeNull();
  });

  it("returns null for unknown gh subcommand", () => {
    expect(denied("release", "create")).toBeNull();
  });

  it("denial reason for gh pr create references session_pr_create", () => {
    const reason = denied("pr", "create");
    expect(reason).toContain("mcp__minsky__session_pr_create");
  });

  it("denial reason for gh issue references mcp__github__issue", () => {
    const reason = denied("issue", "create");
    expect(reason).toContain("mcp__github__issue_write");
  });
});

// ---------------------------------------------------------------------------
// Integration: full command string → denial
// ---------------------------------------------------------------------------

describe("full command denial integration", () => {
  const firstDenial = (cmd: string) => {
    const parsed = parseCommands(cmd);
    for (const p of parsed) {
      const r = checkDenial(p);
      if (r) return r;
    }
    return null;
  };

  it("denies 'git status' as full command", () => {
    expect(firstDenial("git status")).not.toBeNull();
  });

  it("denies chained command containing git push", () => {
    expect(firstDenial("echo done && git push origin main")).not.toBeNull();
  });

  it("allows 'chmod +x .claude/hooks/block-git-gh-cli.ts'", () => {
    expect(firstDenial("chmod +x .claude/hooks/block-git-gh-cli.ts")).toBeNull();
  });

  it("allows 'bun test'", () => {
    expect(firstDenial("bun test --preload ./tests/setup.ts")).toBeNull();
  });

  it("allows 'ls -la'", () => {
    expect(firstDenial("ls -la")).toBeNull();
  });

  it("allows 'cd /tmp && ls'", () => {
    expect(firstDenial("cd /tmp && ls")).toBeNull();
  });

  it("denies 'GIT_DIR=.git git log --oneline'", () => {
    expect(firstDenial("GIT_DIR=.git git log --oneline")).not.toBeNull();
  });

  it("denies 'git -C /path/to/session status'", () => {
    expect(firstDenial("git -C /path/to/session status")).not.toBeNull();
  });

  it("allows 'git cherry-pick abc123'", () => {
    expect(firstDenial("git cherry-pick abc123")).toBeNull();
  });

  it("allows 'gh workflow list'", () => {
    expect(firstDenial("gh workflow list")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: session_exec command string → denial
// ---------------------------------------------------------------------------

describe("full command denial integration — session_exec context", () => {
  const firstSessionExecDenial = (cmd: string) => {
    const parsed = parseCommands(cmd);
    for (const p of parsed) {
      const r = checkDenial(p, "session_exec");
      if (r) return r;
    }
    return null;
  };

  it("denies `git log --oneline` via session_exec", () => {
    expect(firstSessionExecDenial("git log --oneline")).not.toBeNull();
  });

  it("denies `git merge origin/main` via session_exec", () => {
    expect(firstSessionExecDenial("git merge origin/main --no-edit")).not.toBeNull();
  });

  it("denies chained `git fetch && git log` via session_exec", () => {
    expect(firstSessionExecDenial("git fetch origin main && git log --oneline")).not.toBeNull();
  });

  it("allows `git status` via session_exec", () => {
    expect(firstSessionExecDenial("git status")).toBeNull();
  });

  it("allows `git stash pop` via session_exec", () => {
    expect(firstSessionExecDenial("git stash pop")).toBeNull();
  });

  it("allows `git show origin/main:path/to/file` via session_exec (real MCP gap)", () => {
    expect(firstSessionExecDenial("git show origin/main:path/to/file")).toBeNull();
  });

  it("allows arbitrary non-git commands via session_exec", () => {
    expect(firstSessionExecDenial("bun test --preload ./tests/setup.ts")).toBeNull();
    expect(firstSessionExecDenial("ls -la")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Known limitations — document expected-but-imperfect behavior
// ---------------------------------------------------------------------------

describe("known limitations: shell quoting is not honored", () => {
  it("still denies when a quoted string contains `|` and the real binary is a denied subcommand", () => {
    // `git commit -m "feat: pipe | this"` — the splitter breaks the message at `|`,
    // but `git commit` is still detected as the first segment → denied correctly.
    // This is the happy path even though parsing is technically broken.
    const cmd = `git commit -m "feat: pipe | this"`;
    const parsed = parseCommands(cmd);
    const firstDenied = parsed.map((p) => checkDenial(p)).find((r) => r !== null);
    expect(firstDenied).not.toBeNull();
  });

  it("DOCUMENTS: shell operator inside a commit message can let the post-operator portion through", () => {
    // `git commit -m "cherry-pick this"` has no operator — safe.
    // But `git commit -m "x | cherry-pick y"` would split into:
    //   - `git commit -m "x ` (denied as commit)
    //   - `cherry-pick y"` (not a git/gh command — ignored)
    // In this case the overall result is still DENIED because `git commit` fires.
    //
    // The pathological case that actually slips: the FIRST segment is non-git/gh
    // and the SECOND segment (after a quoted operator) happens to look like an
    // allowed git command. This is extremely contrived in practice.
    //
    // We keep this test to document the known gap; fixing it correctly requires
    // a proper shell lexer, which is beyond scope.
    const cmd = `echo "hi | git cherry-pick abc"`;
    const parsed = parseCommands(cmd);
    // The splitter sees `echo "hi ` and `git cherry-pick abc"` — the latter parses
    // as git cherry-pick, which is in the allowed list.
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    const anyDenied = parsed.map((p) => checkDenial(p)).some((r) => r !== null);
    expect(anyDenied).toBe(false); // Known-permissive: nothing denied
  });

  it("DOCUMENTS: subshell invocations `$(git ...)` are not parsed", () => {
    // `TAG=$(git log -1 --format=%s)` — the outer command has no git/gh binary;
    // the inner `git log` is inside `$(...)` and not separately parsed.
    const cmd = `TAG=$(git log -1 --format=%s)`;
    const parsed = parseCommands(cmd);
    // Depending on the splitter, the outer command may not parse as git at all.
    const anyDenied = parsed.map((p) => checkDenial(p)).some((r) => r !== null);
    // Current behavior: subshell content is not blocked. Known limitation.
    expect(anyDenied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Denial table coverage: ensure every entry has a non-empty reason
// ---------------------------------------------------------------------------

describe("denial table sanity", () => {
  it("all gitDenials have non-empty reason strings", () => {
    for (const rule of gitDenials) {
      expect(rule.reason.length).toBeGreaterThan(0);
    }
  });

  it("all ghDenials have non-empty reason strings", () => {
    for (const rule of ghDenials) {
      expect(rule.reason.length).toBeGreaterThan(0);
    }
  });

  it("every gitDenial with `allowedInSessionExec: true` has a reason that references session_exec", () => {
    // Sanity check: if a rule carves out session_exec, its reason message
    // should actually guide the agent to use session_exec. Otherwise the
    // carve-out is incoherent.
    for (const rule of gitDenials) {
      if (rule.allowedInSessionExec) {
        expect(rule.reason).toContain("session_exec");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// gh api merge-method enforcement (mt#1228)
// ---------------------------------------------------------------------------

/** Test literals for the merge-method values; hoisted to avoid magic-string-duplication lint warnings. */
const MERGE_METHOD_MERGE = "merge_method=merge";
const MERGE_METHOD_SQUASH = "merge_method=squash";
const MERGE_METHOD_REBASE = "merge_method=rebase";

describe("findGhApiMethod", () => {
  it("defaults to GET when no method flag present", () => {
    expect(findGhApiMethod(["api", "repos/o/r"])).toBe("GET");
  });

  it("returns PUT for -X PUT", () => {
    expect(findGhApiMethod(["api", "-X", "PUT", "repos/o/r/pulls/1/merge"])).toBe("PUT");
  });

  it("returns PUT for --method PUT (long-form)", () => {
    expect(findGhApiMethod(["api", "--method", "PUT", "repos/o/r/pulls/1/merge"])).toBe("PUT");
  });

  it("returns POST for -X POST", () => {
    expect(findGhApiMethod(["api", "-X", "POST", "repos/o/r/issues"])).toBe("POST");
  });
});

describe("findGhApiEndpoint", () => {
  it("extracts the first positional after flag/value pairs", () => {
    expect(
      findGhApiEndpoint([
        "api",
        "-X",
        "PUT",
        "repos/o/r/pulls/42/merge",
        "-f",
        "merge_method=merge",
      ])
    ).toBe("repos/o/r/pulls/42/merge");
  });

  it("extracts the positional when it precedes flags", () => {
    expect(findGhApiEndpoint(["api", "repos/o/r", "-q", ".name"])).toBe("repos/o/r");
  });

  it("returns null when no positional is present", () => {
    expect(findGhApiEndpoint(["api", "-X", "GET"])).toBeNull();
  });
});

describe("findGhApiField", () => {
  it("extracts a -f KEY=VALUE value", () => {
    expect(
      findGhApiField(["api", "-X", "PUT", "endpoint", "-f", MERGE_METHOD_MERGE], "merge_method")
    ).toBe("merge");
  });

  it("returns null when the key is absent", () => {
    expect(findGhApiField(["api", "-X", "PUT", "endpoint"], "merge_method")).toBeNull();
  });

  it("does not match on partial prefix", () => {
    // `merge_methodology` should not match `merge_method` (the prefix check uses "=").
    expect(findGhApiField(["api", "-f", "merge_methodology=squash"], "merge_method")).toBeNull();
  });
});

describe("checkDenial — gh api PR-merge endpoint (mt#1228)", () => {
  const ghApi = (argString: string) =>
    checkDenial({ binary: "gh", args: argString.split(/\s+/).filter(Boolean) });

  it("blocks PUT /pulls/N/merge with merge_method=squash", () => {
    expect(ghApi(`api -X PUT repos/o/r/pulls/42/merge -f ${MERGE_METHOD_SQUASH}`)).not.toBeNull();
  });

  it("blocks PUT /pulls/N/merge with merge_method=rebase", () => {
    expect(ghApi(`api -X PUT repos/o/r/pulls/42/merge -f ${MERGE_METHOD_REBASE}`)).not.toBeNull();
  });

  it("blocks PUT /pulls/N/merge with no merge_method (ambiguous intent)", () => {
    expect(ghApi("api -X PUT repos/o/r/pulls/42/merge")).not.toBeNull();
  });

  it("blocks PUT /pulls/N/merge via --method long-form with merge_method=squash", () => {
    expect(
      ghApi(`api --method PUT repos/o/r/pulls/42/merge -f ${MERGE_METHOD_SQUASH}`)
    ).not.toBeNull();
  });

  it("allows PUT /pulls/N/merge with merge_method=merge", () => {
    expect(ghApi(`api -X PUT repos/o/r/pulls/42/merge -f ${MERGE_METHOD_MERGE}`)).toBeNull();
  });

  it("allows PUT /pulls/N/reviews/REVIEW_ID/dismissals (different endpoint)", () => {
    expect(ghApi("api -X PUT repos/o/r/pulls/42/reviews/123/dismissals -f message=why")).toBeNull();
  });

  it("allows GET /pulls/N/merge (not a merge operation)", () => {
    expect(ghApi("api -X GET repos/o/r/pulls/42/merge")).toBeNull();
  });

  it("allows generic `gh api repos/o/r` (default GET, no body)", () => {
    expect(ghApi("api repos/o/r")).toBeNull();
  });

  it("denial reason mentions merge_method=merge and links to policy docs", () => {
    const reason = ghApi(`api -X PUT repos/o/r/pulls/42/merge -f ${MERGE_METHOD_SQUASH}`);
    expect(reason).toContain(MERGE_METHOD_MERGE);
    expect(reason).toMatch(/pr-workflow|gh_api_bypass/);
  });
});
