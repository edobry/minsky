import { describe, expect, it } from "bun:test";
import {
  checkDenial,
  ghDenials,
  gitDenials,
  parseCommands,
  parseSegment,
  splitOnShellOperators,
  stripEnvVarAssignments,
} from "./block-git-gh-cli";

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
    expect(reason).toContain("mcp__minsky__session_commit");
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
// Known limitations — document expected-but-imperfect behavior
// ---------------------------------------------------------------------------

describe("known limitations: shell quoting is not honored", () => {
  it("still denies when a quoted string contains `|` and the real binary is a denied subcommand", () => {
    // `git commit -m "feat: pipe | this"` — the splitter breaks the message at `|`,
    // but `git commit` is still detected as the first segment → denied correctly.
    // This is the happy path even though parsing is technically broken.
    const cmd = `git commit -m "feat: pipe | this"`;
    const parsed = parseCommands(cmd);
    const firstDenied = parsed.map(checkDenial).find((r) => r !== null);
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
    const anyDenied = parsed.map(checkDenial).some((r) => r !== null);
    expect(anyDenied).toBe(false); // Known-permissive: nothing denied
  });

  it("DOCUMENTS: subshell invocations `$(git ...)` are not parsed", () => {
    // `TAG=$(git log -1 --format=%s)` — the outer command has no git/gh binary;
    // the inner `git log` is inside `$(...)` and not separately parsed.
    const cmd = `TAG=$(git log -1 --format=%s)`;
    const parsed = parseCommands(cmd);
    // Depending on the splitter, the outer command may not parse as git at all.
    const anyDenied = parsed.map(checkDenial).some((r) => r !== null);
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
});
