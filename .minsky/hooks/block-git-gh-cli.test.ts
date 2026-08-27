import { describe, expect, it } from "bun:test";
import {
  checkDenial,
  extractGitAddPaths,
  getUnmergedPaths,
  isConflictResolutionAdd,
  ghDenials,
  gitDenials,
  parseCommands,
  parseSegment,
  splitOnShellOperators,
  splitOnShellOperatorsUnquoted,
  classifyRepoScope,
  commandMayRelocateCwd,
  resolveLeadingCdTarget,
  isLiterallyResolvablePath,
  isCwdScopedInvocation,
  isMinskySessionPath,
  stripEnvVarAssignments,
  toolContextFromName,
  REDIRECT_UNAVAILABLE_ESCAPE,
  buildDenialReason,
  classifyAgentTypeObservation,
  findGhApiMethod,
  findGhApiEndpoint,
  findGhApiField,
  findGhApiPrMergeEndpointToken,
  stripSurroundingQuotes,
  SESSION_EXEC_TOOL_NAME,
} from "./block-git-gh-cli";
import reviewerAgent from "../agents/reviewer/agent";
import auditorAgent from "../agents/auditor/agent";
import fixtureAgent from "../agents/fixture/agent";

// ---------------------------------------------------------------------------
// Helpers: injectable runGit implementations for carve-out tests
// ---------------------------------------------------------------------------

/** Returns a runGit that simulates `git diff --name-only --diff-filter=U` output. */
function fakeRunGitWithUnmerged(unmergedPaths: string[]): (cmd: string) => string {
  return (_cmd: string) => unmergedPaths.join("\n") + (unmergedPaths.length > 0 ? "\n" : "");
}

/** Returns a runGit that throws (simulates not in a git repo or git unavailable). */
function fakeRunGitError(msg = "not a git repository"): (cmd: string) => string {
  return (_cmd: string) => {
    throw new Error(msg);
  };
}

/** Minsky MCP tool names referenced in denial reasons — hoisted to avoid magic-string duplication in tests. */
const SESSION_COMMIT_TOOL = "mcp__minsky__session_commit";

/** Reusable test fixture: a branch-protection endpoint path (mt#1957). */
const BRANCH_PROTECTION_PATH = "/repos/owner/repo/branches/main/protection";

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
// classifyAgentTypeObservation (mt#3381)
// ---------------------------------------------------------------------------

describe("classifyAgentTypeObservation", () => {
  it("reports 'present' when the payload carries an agent_type", () => {
    expect(classifyAgentTypeObservation({ agent_id: "a1", agent_type: "reviewer" })).toBe(
      "present"
    );
  });

  it("distinguishes a subagent missing the field from a main-thread call", () => {
    // This is the whole point of the three-way split: only the first of these
    // is evidence that the field does not reach a PreToolUse hook. A bare
    // missing string would conflate them and prove nothing.
    expect(classifyAgentTypeObservation({ agent_id: "a1" })).toBe("absent-in-subagent");
    expect(classifyAgentTypeObservation({})).toBe("not-a-subagent");
  });

  it("treats an empty-string agent_type as absent, not present", () => {
    // An empty string would record as "the field arrived" while carrying no
    // agent identity — which would read as evidence the check is buildable.
    expect(classifyAgentTypeObservation({ agent_id: "a1", agent_type: "" })).toBe(
      "absent-in-subagent"
    );
  });

  it("reports 'present' even without an agent_id, so a surprise shape is not discarded", () => {
    expect(classifyAgentTypeObservation({ agent_type: "Explore" })).toBe("present");
  });
});

// ---------------------------------------------------------------------------
// Redirect targets must be reachable by the restricted agents (mt#3381)
// ---------------------------------------------------------------------------

describe("read-only git redirects are reachable by the restricted agents", () => {
  // These two agents hold `Bash` specifically so they can run read-only git
  // commands (`.minsky/agents/reviewer/prompt.md` says so in as many words),
  // and this guard denies exactly those. If a denial names a tool the agent's
  // grant omits, the agent has no legal path to PR history at all — which is
  // the defect this task exists to close.
  // mt#3401: DISCOVERED, not hardcoded. Only agents that declare a restricted
  // `tools` grant can be dead-ended — an agent that omits `tools` inherits the
  // full set and can always reach the redirect. Adding a new restricted agent
  // therefore adds it to this list automatically; it does not silently escape
  // the check the way a hardcoded pair would.
  //
  // `fixture` is deliberately excluded: it declares `["Read", "Bash"]` and holds
  // NO MCP tool at all, so every redirect is unreachable for it by construction.
  // It is a compile-pipeline test artifact ("Not for production use", its whole
  // prompt is a two-line stub) that never runs a git command, so widening its
  // grant would add real tools to a fake agent to satisfy a test. Exempted by
  // name, with this reason, rather than by loosening the invariant.
  const EXEMPT_AGENTS = new Set(["fixture"]);

  const AGENT_GRANTS: ReadonlyArray<{ name: string; tools: readonly string[] }> = (
    [
      { name: "reviewer", tools: reviewerAgent.tools },
      { name: "auditor", tools: auditorAgent.tools },
      { name: "fixture", tools: fixtureAgent.tools },
    ] as ReadonlyArray<{ name: string; tools: readonly string[] | undefined }>
  )
    .filter((a) => Array.isArray(a.tools) && a.tools.length > 0 && !EXEMPT_AGENTS.has(a.name))
    .map((a) => ({ name: a.name, tools: a.tools as readonly string[] }));

  it("the discovered restricted-agent set is non-empty (the check can actually fail)", () => {
    // Guards against the filter silently emptying the list — a zero-length set
    // would make every assertion below vacuously pass.
    expect(AGENT_GRANTS.length).toBeGreaterThan(0);
  });

  // Every read-only git command the denial table covers. `git blame` is here
  // because mt#3381 fixed log/diff/status and missed it — which is precisely
  // the drift this generalized list exists to prevent.
  const READ_ONLY_GIT_COMMANDS = ["git log", "git diff", "git status", "git blame"] as const;

  for (const { name, tools } of AGENT_GRANTS) {
    for (const command of READ_ONLY_GIT_COMMANDS) {
      it(`${name}: the denial for \`${command}\` names a tool ${name} actually holds`, () => {
        const [parsed] = parseCommands(command);
        if (!parsed) throw new Error(`parseCommands produced nothing for \`${command}\``);
        const reason = checkDenial(parsed, "bash");

        // Precondition: the guard still denies it. If it stops denying, this
        // test must be revisited rather than silently passing.
        expect(reason).toBeTruthy();

        const named = [...(reason as string).matchAll(/mcp__[a-z0-9_]+/g)].map((m) => m[0]);
        expect(named.length).toBeGreaterThan(0);
        expect(named.some((tool) => tools.includes(tool))).toBe(true);
      });
    }
  }

  it("does NOT hand these agents a mutation tool to satisfy the redirect", () => {
    // The fix must not be "give them session_exec" — the Chinese-wall guarantee
    // rests on those tools being structurally absent.
    for (const { tools } of AGENT_GRANTS) {
      expect(tools).not.toContain(SESSION_EXEC_TOOL_NAME);
      expect(tools).not.toContain("mcp__minsky__session_write_file");
      expect(tools).not.toContain("mcp__minsky__session_edit_file");
    }
  });

  // -------------------------------------------------------------------------
  // Rule-level invariant (mt#3401) — agent-independent
  // -------------------------------------------------------------------------

  // The per-agent assertions above only cover agents that exist TODAY. This one
  // constrains the denial table itself, so a new rule that redirects a
  // read-only command solely to a mutation tool fails immediately — before any
  // restricted agent happens to hit it. That is the `git status` bug mt#3381
  // found by accident (it named ONLY `session_exec`), stated as a rule.
  //
  // Read-only MCP replacements, listed explicitly rather than pattern-matched:
  // "read-only" is a semantic property of each tool, not something derivable
  // from its name, so it is enumerated and reviewable.
  const READ_ONLY_MCP_TOOLS = new Set([
    "mcp__minsky__git_log",
    "mcp__minsky__git_diff",
    "mcp__minsky__git_status",
    "mcp__minsky__git_blame",
    "mcp__minsky__session_diff",
    "mcp__github__list_pull_requests",
    "mcp__github__pull_request_read",
  ]);

  const READ_ONLY_COMMANDS = [
    "git log",
    "git diff",
    "git status",
    "git blame",
    "gh pr list",
    "gh pr view",
  ] as const;

  for (const command of READ_ONLY_COMMANDS) {
    it(`the denial for \`${command}\` offers at least one READ-ONLY replacement`, () => {
      const [parsed] = parseCommands(command);
      if (!parsed) throw new Error(`parseCommands produced nothing for \`${command}\``);
      const reason = checkDenial(parsed, "bash");
      expect(reason).toBeTruthy();

      const named = [...(reason as string).matchAll(/mcp__[a-z0-9_]+/g)].map((m) => m[0]);
      const readOnly = named.filter((tool) => READ_ONLY_MCP_TOOLS.has(tool));

      // A read-only command whose only escape is a mutation tool dead-ends
      // every read-only caller, whether or not such a caller exists yet.
      expect(readOnly.length).toBeGreaterThan(0);
    });
  }

  // -------------------------------------------------------------------------
  // TOTAL rule-table enumeration (mt#3401 SC5)
  // -------------------------------------------------------------------------

  // The assertions above cover the read-only commands by name. This one walks
  // the ENTIRE denial table, so a newly added rule cannot silently bypass the
  // check by simply not being on any hand-written list.
  //
  // Every rule must either name a concrete `mcp__*` replacement, or be one of
  // the documented cases where no single tool is the answer. That allowlist is
  // matched on a distinctive substring of the reason and is deliberately small
  // — a new no-tool reason has to be added here consciously, which is the
  // review checkpoint.
  const REASONS_WITH_NO_SINGLE_TOOL_ALTERNATIVE = [
    // Branch checkout/management: the answer is a workflow (session state ops),
    // not one callable tool.
    "Branch checkout is handled by session state ops",
    "Branch management is handled by session state ops",
    // A constraint on HOW an allowed call must be shaped, not a redirect.
    "must use `-f merge_method=merge`",
  ];

  it("every rule in the denial table names an mcp__ tool or a documented no-tool case", () => {
    const allRules = [...gitDenials, ...ghDenials];

    // Guard: if the tables were ever emptied or renamed, this test would pass
    // vacuously while asserting nothing about the real guard.
    expect(allRules.length).toBeGreaterThan(20);

    const uncovered = allRules
      .map((rule) => rule.reason)
      .filter((reason) => !/mcp__[a-z0-9_]+/.test(reason))
      .filter(
        (reason) => !REASONS_WITH_NO_SINGLE_TOOL_ALTERNATIVE.some((known) => reason.includes(known))
      );

    expect(uncovered).toEqual([]);
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

  it("allows `git restore` via session_exec (self-referential carve-out)", () => {
    expect(deniedViaSessionExec("restore")).toBeNull();
    expect(deniedViaSessionExec("restore", ["--", "src/file.ts"])).toBeNull();
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

  it("denial reason for git reset references git_reset MCP tool and session_exec", () => {
    const reason = denied("reset");
    expect(reason).toContain("mcp__minsky__git_reset");
    expect(reason).toContain("mcp__minsky__session_exec");
    expect(reason).toContain("destructive");
  });

  it("denies git restore", () => {
    expect(denied("restore")).not.toBeNull();
  });

  it("denial reason for git restore references git_restore MCP tool", () => {
    const reason = denied("restore");
    expect(reason).toContain("mcp__minsky__git_restore");
  });

  it("denial reason for git fetch references git_pull MCP tool for main-workspace", () => {
    const reason = denied("fetch");
    expect(reason).toContain("mcp__minsky__git_pull");
  });

  it("denial reason for git pull references git_pull MCP tool", () => {
    const reason = denied("pull");
    expect(reason).toContain("mcp__minsky__git_pull");
  });

  it("denial reason for git stash references git_stash MCP tool", () => {
    const reason = denied("stash");
    expect(reason).toContain("mcp__minsky__git_stash");
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

// mt#4226 — the four `allowedInSessionExec` carve-outs must name their MCP tool
// BEFORE the session_exec fallback.
//
// MEASURED, not assumed — the negative control (source reverted to the pre-fix
// text, tests re-run) failed 7 of these and PASSED every ordering assertion. So
// the ordering checks are NOT what catches this staleness: the old strings
// already named the MCP tool first ("Use `mcp__minsky__git_restore <paths>` for
// main-workspace single-file discard. For sessions, use `session_exec(...)`").
// They are kept as a PIN against a future edit demoting the tool below the
// fallback, and are honestly labelled as such rather than as the regression test.
//
// The four assertions that actually discriminate, and what each pins:
//   - `{ session` in the message — the tool must be SHOWN accepting a session.
//     This is the substantive claim; a message naming a bare tool still reads as
//     main-workspace-only, which is the misreading that sent agents to the CLI.
//   - the "for sessions, use" negative control — the retired phrasing itself.
//   - `--source=` / `mt#1297` — the one real capability boundary is named.
//   - the `git checkout` warning — the dead-end spelling is called out.
//
// Root cause being guarded (mem#1078): a denial string is an instruction with
// hook authority, and it ages independently of the tool surface it names. All
// four tools gained a `session` parameter and nothing re-read the guard.
describe("carve-out denial text ranks the MCP tool above session_exec (mt#4226)", () => {
  const deniedOnBash = (subcommand: string) => checkDenial({ binary: "git", args: [subcommand] });
  const deniedOnSessionExec = (subcommand: string) =>
    checkDenial({ binary: "git", args: [subcommand] }, "session_exec");

  const CARVE_OUTS = [
    { subcommand: "status", tool: "mcp__minsky__git_status" },
    { subcommand: "reset", tool: "mcp__minsky__git_reset" },
    { subcommand: "stash", tool: "mcp__minsky__git_stash" },
    { subcommand: "restore", tool: "mcp__minsky__git_restore" },
  ] as const;

  for (const { subcommand, tool } of CARVE_OUTS) {
    it(`git ${subcommand}: names ${tool} before any session_exec mention`, () => {
      const reason = deniedOnBash(subcommand);
      expect(reason).not.toBeNull();
      const toolIndex = reason?.indexOf(tool) ?? -1;
      expect(toolIndex).toBeGreaterThanOrEqual(0);
      const execIndex = reason?.indexOf("session_exec") ?? -1;
      if (execIndex >= 0) expect(toolIndex).toBeLessThan(execIndex);
    });

    it(`git ${subcommand}: shows the MCP tool taking a session argument`, () => {
      // The substantive claim of the rewrite. A message naming the tool without
      // its `session` argument still reads as main-workspace-only, which is the
      // misreading that sent agents to the CLI in the first place.
      expect(deniedOnBash(subcommand)).toContain("{ session");
    });

    it(`git ${subcommand}: carve-out still permits it via session_exec`, () => {
      // SC5 — this task changes advice, not enforcement. Pinned here so a future
      // edit to these strings cannot quietly take the escape hatch with it.
      expect(deniedOnSessionExec(subcommand)).toBeNull();
    });
  }

  it("NEGATIVE CONTROL: the retired 'for sessions, use ...' phrasing is gone", () => {
    // Without this, every assertion above passes against a message that kept the
    // stale sentence appended after a correctly-ranked opening.
    for (const { subcommand } of CARVE_OUTS) {
      expect(deniedOnBash(subcommand)?.toLowerCase() ?? "").not.toContain("for sessions, use");
    }
  });

  it("git restore names --source= as the one case its MCP tool cannot cover", () => {
    const reason = deniedOnBash("restore");
    expect(reason).toContain("--source=");
    expect(reason).toContain("mt#1297");
  });

  it("git restore steers to --source=, not the checkout spelling that has no carve-out", () => {
    // `git checkout <ref> -- <path>` is the legacy spelling of the same
    // capability, and the `checkout` rule carries no allowedInSessionExec — so a
    // message pointing there would dead-end an agent inside a session. This
    // asserts both halves: that the message warns, and that the warning is true.
    expect(deniedOnBash("restore")).toContain("git checkout");
    expect(deniedOnSessionExec("checkout")).not.toBeNull();
  });
});

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

  it("denies gh pr close", () => {
    expect(denied("pr", "close")).not.toBeNull();
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

  it("denial reason for gh pr close references session_pr_close (mt#1955)", () => {
    const reason = denied("pr", "close");
    expect(reason).toContain("mcp__minsky__session_pr_close");
  });

  // mt#1957 — forge MCP tools (CI runs, check-runs, branch protection, labels)

  it("denies gh run list (mt#1957)", () => {
    expect(denied("run", "list")).not.toBeNull();
  });

  it("denies gh run view (mt#1957)", () => {
    expect(denied("run", "view")).not.toBeNull();
  });

  it("denial reason for gh run list references forge_ci_run_list", () => {
    const reason = denied("run", "list");
    expect(reason).toContain("forge_ci_run_list");
  });

  it("denies gh label create (mt#1957)", () => {
    expect(denied("label", "create")).not.toBeNull();
  });

  it("denies gh label list (mt#1957)", () => {
    expect(denied("label", "list")).not.toBeNull();
  });

  it("denies gh label edit (mt#1957)", () => {
    expect(denied("label", "edit")).not.toBeNull();
  });

  it("denies gh label delete (mt#1957)", () => {
    expect(denied("label", "delete")).not.toBeNull();
  });

  it("denial reason for gh label create references forge_label_create", () => {
    const reason = denied("label", "create");
    expect(reason).toContain("forge_label_create");
  });

  it("denies gh api branches/main/protection (mt#1957)", () => {
    expect(denied("api", BRANCH_PROTECTION_PATH)).not.toBeNull();
  });

  it("denies gh api -X PUT branches/main/protection (mt#1957)", () => {
    expect(denied("api", "-X", "PUT", BRANCH_PROTECTION_PATH)).not.toBeNull();
  });

  it("denial reason for gh api branches/.../protection references forge_branch_protection", () => {
    const reason = denied("api", BRANCH_PROTECTION_PATH);
    expect(reason).toContain("forge_branch_protection_get");
  });

  it("denies gh api commits/<sha>/check-runs (mt#1957)", () => {
    expect(denied("api", "/repos/owner/repo/commits/7af90f48/check-runs")).not.toBeNull();
  });

  it("denial reason for check-runs references forge_check_runs_list", () => {
    const reason = denied("api", "/repos/owner/repo/commits/7af90f48/check-runs");
    expect(reason).toContain("forge_check_runs_list");
  });

  it("denies gh api actions/runs/<id> (mt#1957)", () => {
    expect(denied("api", "/repos/owner/repo/actions/runs/12345")).not.toBeNull();
  });

  it("denies gh api actions/workflows/<name>/runs (mt#1957)", () => {
    expect(denied("api", "/repos/owner/repo/actions/workflows/ci.yml/runs")).not.toBeNull();
  });

  it("denies gh api -X POST labels (mt#1957)", () => {
    expect(denied("api", "-X", "POST", "/repos/owner/repo/labels")).not.toBeNull();
  });

  it("denies gh api labels/<name> (mt#1957)", () => {
    expect(denied("api", "/repos/owner/repo/labels/p0")).not.toBeNull();
  });

  it("denial reason for gh api labels references forge_label_create", () => {
    const reason = denied("api", "-X", "POST", "/repos/owner/repo/labels");
    expect(reason).toContain("forge_label_create");
  });

  it("does NOT block issue-scoped labels endpoint (PR #1185 review fix)", () => {
    // Regression: pre-fix regex /\/labels(\/|$)/ also matched
    // /repos/.../issues/<N>/labels, which is for applying labels to an issue —
    // served by `mcp__github__issue_write`, NOT forge_label_*. The narrowed
    // regex /\/repos\/[^/]+\/[^/]+\/labels(\/|$)/ now allows this path through.
    expect(denied("api", "/repos/owner/repo/issues/123/labels")).toBeNull();
    expect(denied("api", "-X", "POST", "/repos/owner/repo/issues/123/labels")).toBeNull();
  });

  it("still allows non-forge gh api endpoints (e.g. /user)", () => {
    expect(denied("api", "/user")).toBeNull();
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

  it("allows `git restore -- file.ts` via session_exec", () => {
    expect(firstSessionExecDenial("git restore -- file.ts")).toBeNull();
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

  it("a quoted operator no longer splits the argument into a phantom command (mt#3788)", () => {
    // Was: "DOCUMENTS: shell operator inside a commit message can let the
    // post-operator portion through". The splitter used to cut this into
    // `echo "hi ` and `git cherry-pick abc"`, so a string ARGUMENT produced a
    // parsed git invocation that no shell would ever run. Nothing was denied
    // here, so the old gap read as harmless — but the same mis-split in the
    // other direction is what denied a `grep` whose regex mentioned `git add`.
    //
    // Now the quoted region is preserved, `echo` is the only binary, and no
    // git command is parsed at all.
    const cmd = `echo "hi | git cherry-pick abc"`;
    expect(splitOnShellOperators(cmd)).toEqual([cmd]);
    const parsed = parseCommands(cmd);
    expect(parsed).toEqual([]);
    const anyDenied = parsed.map((p) => checkDenial(p)).some((r) => r !== null);
    expect(anyDenied).toBe(false);
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
/** Quoted form of merge_method=merge (double-quote stripping coverage). */
const MERGE_METHOD_MERGE_QUOTED = `"${MERGE_METHOD_MERGE}"`;
/** Canonical PR-merge endpoints used in the new enforcement tests. */
const ENDPOINT_PR1_MERGE = "repos/o/r/pulls/1/merge";
const ENDPOINT_PR42_MERGE = "repos/o/r/pulls/42/merge";

describe("findGhApiMethod", () => {
  it("defaults to GET when no method flag present", () => {
    expect(findGhApiMethod(["api", "repos/o/r"])).toBe("GET");
  });

  it("returns PUT for -X PUT", () => {
    expect(findGhApiMethod(["api", "-X", "PUT", ENDPOINT_PR1_MERGE])).toBe("PUT");
  });

  it("returns PUT for --method PUT (long-form)", () => {
    expect(findGhApiMethod(["api", "--method", "PUT", ENDPOINT_PR1_MERGE])).toBe("PUT");
  });

  it("returns POST for -X POST", () => {
    expect(findGhApiMethod(["api", "-X", "POST", "repos/o/r/issues"])).toBe("POST");
  });
});

describe("findGhApiEndpoint", () => {
  it("extracts the first positional after flag/value pairs", () => {
    expect(
      findGhApiEndpoint(["api", "-X", "PUT", ENDPOINT_PR42_MERGE, "-f", MERGE_METHOD_MERGE])
    ).toBe(ENDPOINT_PR42_MERGE);
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

// ---------------------------------------------------------------------------
// Quote/case/alternate-form hardening (PR #761 round-1 review)
// ---------------------------------------------------------------------------

describe("stripSurroundingQuotes", () => {
  it("removes matching double quotes from merge_method=merge", () => {
    expect(stripSurroundingQuotes(MERGE_METHOD_MERGE_QUOTED)).toBe(MERGE_METHOD_MERGE);
  });

  it("removes matching single quotes", () => {
    expect(stripSurroundingQuotes("'repos/o/r'")).toBe("repos/o/r");
  });

  it("leaves unquoted tokens unchanged", () => {
    expect(stripSurroundingQuotes(MERGE_METHOD_MERGE)).toBe(MERGE_METHOD_MERGE);
  });

  it("leaves mismatched quotes alone", () => {
    // "foo' is not a matched pair; don't touch it
    expect(stripSurroundingQuotes("\"foo'")).toBe("\"foo'");
  });

  it("leaves single-character tokens alone", () => {
    expect(stripSurroundingQuotes('"')).toBe('"');
    expect(stripSurroundingQuotes("'")).toBe("'");
    expect(stripSurroundingQuotes("")).toBe("");
  });
});

describe("findGhApiMethod — additional forms and casing", () => {
  it("uppercases lowercase -X values (avoids bypass via -X put)", () => {
    expect(findGhApiMethod(["api", "-X", "put", ENDPOINT_PR1_MERGE])).toBe("PUT");
  });

  it("uppercases --method values (avoids bypass via --method put)", () => {
    expect(findGhApiMethod(["api", "--method", "put", ENDPOINT_PR1_MERGE])).toBe("PUT");
  });

  it("parses equals form --method=PUT", () => {
    expect(findGhApiMethod(["api", "--method=PUT", ENDPOINT_PR1_MERGE])).toBe("PUT");
  });

  it("uppercases equals form --method=put", () => {
    expect(findGhApiMethod(["api", "--method=put", ENDPOINT_PR1_MERGE])).toBe("PUT");
  });

  it("parses combined short form -XPUT", () => {
    expect(findGhApiMethod(["api", "-XPUT", ENDPOINT_PR1_MERGE])).toBe("PUT");
  });

  it("parses combined short form with lowercase -Xput", () => {
    expect(findGhApiMethod(["api", "-Xput", ENDPOINT_PR1_MERGE])).toBe("PUT");
  });
});

describe("findGhApiField — quoted values", () => {
  it("strips double quotes around the whole KEY=VALUE token", () => {
    expect(findGhApiField(["api", "-f", MERGE_METHOD_MERGE_QUOTED], "merge_method")).toBe("merge");
  });

  it("strips single quotes around the whole KEY=VALUE token", () => {
    expect(findGhApiField(["api", "-f", "'merge_method=merge'"], "merge_method")).toBe("merge");
  });
});

describe("findGhApiPrMergeEndpointToken", () => {
  it("finds the endpoint at any position in args", () => {
    expect(
      findGhApiPrMergeEndpointToken([
        "api",
        "-X",
        "PUT",
        "-f",
        "commit_title=X",
        ENDPOINT_PR42_MERGE,
        "-f",
        MERGE_METHOD_SQUASH,
      ])
    ).toBe(ENDPOINT_PR42_MERGE);
  });

  it("finds a quoted endpoint", () => {
    // Pass the endpoint with surrounding double quotes as a single token —
    // template literal construction matches how the upstream tokenizer would
    // deliver a token like `"repos/o/r/pulls/42/merge"` with quotes intact.
    expect(findGhApiPrMergeEndpointToken(["api", "-X", "PUT", `"${ENDPOINT_PR42_MERGE}"`])).toBe(
      ENDPOINT_PR42_MERGE
    );
  });

  it("returns null when no token matches", () => {
    expect(
      findGhApiPrMergeEndpointToken(["api", "-X", "PUT", "repos/o/r/pulls/42/merges"])
    ).toBeNull();
  });

  it("does not match /merges or /merge-upstream", () => {
    expect(
      findGhApiPrMergeEndpointToken(["api", "-X", "PUT", "repos/o/r/pulls/42/merge-upstream"])
    ).toBeNull();
  });

  it('finds endpoint after a quote-split -f commit_title="My PR Title" (bypass regression guard)', () => {
    // Upstream tokenizer is not quote-aware, so `-f commit_title="My PR Title"`
    // arrives as multiple tokens. The old positional-based extractor returned
    // a fragment of the title; the all-tokens scan finds the real endpoint.
    expect(
      findGhApiPrMergeEndpointToken([
        "api",
        "-X",
        "PUT",
        "-f",
        'commit_title="My',
        "PR",
        'Title"',
        ENDPOINT_PR42_MERGE,
        "-f",
        MERGE_METHOD_SQUASH,
      ])
    ).toBe(ENDPOINT_PR42_MERGE);
  });
});

describe("checkDenial — gh api PR-merge hardening (PR #761 round 1)", () => {
  const ghApi = (argString: string) =>
    checkDenial({ binary: "gh", args: argString.split(/\s+/).filter(Boolean) });

  it("blocks lowercase -X put (case-insensitivity regression guard)", () => {
    expect(ghApi("api -X put repos/o/r/pulls/42/merge -f merge_method=squash")).not.toBeNull();
  });

  it("blocks --method=PUT equals form with squash", () => {
    expect(
      ghApi("api --method=PUT repos/o/r/pulls/42/merge -f merge_method=squash")
    ).not.toBeNull();
  });

  it("blocks -XPUT combined short form with squash", () => {
    expect(ghApi("api -XPUT repos/o/r/pulls/42/merge -f merge_method=squash")).not.toBeNull();
  });

  it("blocks quoted endpoint (regression guard for quote-stripping)", () => {
    // The tokenizer splits on whitespace only, so a quoted endpoint token
    // arrives with the quote characters still attached. Template literal
    // reconstructs the quoted form.
    const args = ["api", "-X", "PUT", `"${ENDPOINT_PR42_MERGE}"`, "-f", MERGE_METHOD_SQUASH];
    expect(checkDenial({ binary: "gh", args })).not.toBeNull();
  });

  it('blocks endpoint after a quote-split -f commit_title="My PR Title" (bypass regression guard)', () => {
    // Before the mt#1228 round-1 review fix, positional-based extraction
    // pulled \"PR\" out of the split title as the \"endpoint\", missed the
    // regex, and let a squash-merge through.
    const args = [
      "api",
      "-X",
      "PUT",
      "-f",
      'commit_title="My',
      "PR",
      'Title"',
      ENDPOINT_PR42_MERGE,
      "-f",
      MERGE_METHOD_SQUASH,
    ];
    expect(checkDenial({ binary: "gh", args })).not.toBeNull();
  });

  it('allows quoted -f "merge_method=merge" (over-block regression guard)', () => {
    // Before quote-stripping in findGhApiField, a valid quoted
    // -f \"merge_method=merge\" was treated as absent and over-blocked.
    const args = ["api", "-X", "PUT", ENDPOINT_PR42_MERGE, "-f", MERGE_METHOD_MERGE_QUOTED];
    expect(checkDenial({ binary: "gh", args })).toBeNull();
  });

  it("allows single-quoted -f 'merge_method=merge'", () => {
    const args = ["api", "-X", "PUT", ENDPOINT_PR42_MERGE, "-f", "'merge_method=merge'"];
    expect(checkDenial({ binary: "gh", args })).toBeNull();
  });

  it("denial reason does not reference out-of-repo memory paths", () => {
    // Per PR #761 review non-blocking: keep denial reasons pointing at
    // in-repo docs (docs/pr-workflow.md) rather than memory files that
    // live outside the repo.
    const reason = ghApi("api -X PUT repos/o/r/pulls/42/merge -f merge_method=squash");
    expect(reason).not.toContain("feedback_gh_api_bypass.md");
    expect(reason).toContain("pr-workflow.md");
  });
});

// ---------------------------------------------------------------------------
// extractGitAddPaths (mt#1806)
// ---------------------------------------------------------------------------

describe("extractGitAddPaths", () => {
  it("returns paths for explicit file arguments", () => {
    expect(extractGitAddPaths(["add", "src/foo.ts"])).toEqual(["src/foo.ts"]);
  });

  it("returns multiple paths", () => {
    expect(extractGitAddPaths(["add", "a.ts", "b.ts"])).toEqual(["a.ts", "b.ts"]);
  });

  it("returns null for bare `git add` (no paths)", () => {
    expect(extractGitAddPaths(["add"])).toBeNull();
  });

  it("returns null when -A flag is present (broad staging)", () => {
    expect(extractGitAddPaths(["add", "-A"])).toBeNull();
  });

  it("returns null when -u flag is present", () => {
    expect(extractGitAddPaths(["add", "-u"])).toBeNull();
  });

  it("returns null when --all flag is present", () => {
    expect(extractGitAddPaths(["add", "--all"])).toBeNull();
  });

  it("returns null when -p flag is present (interactive)", () => {
    expect(extractGitAddPaths(["add", "-p"])).toBeNull();
  });

  it("returns null when `.` is provided (glob-all)", () => {
    expect(extractGitAddPaths(["add", "."])).toBeNull();
  });

  // -- pathspec-separator cases (mt#1806 R1 — `git add -- <path>` should be carved out)
  it("returns paths after the `--` pathspec separator", () => {
    expect(extractGitAddPaths(["add", "--", "file.ts"])).toEqual(["file.ts"]);
  });

  it("returns multiple paths after the `--` separator", () => {
    expect(extractGitAddPaths(["add", "--", "a.ts", "b.ts"])).toEqual(["a.ts", "b.ts"]);
  });

  it("returns paths both before and after the `--` separator", () => {
    expect(extractGitAddPaths(["add", "foo.ts", "--", "bar.ts"])).toEqual(["foo.ts", "bar.ts"]);
  });

  it("returns null when a flag appears BEFORE the `--` separator", () => {
    expect(extractGitAddPaths(["add", "-A", "--", "file.ts"])).toBeNull();
  });

  it("returns null when `.` appears AFTER the `--` separator (still glob-all)", () => {
    expect(extractGitAddPaths(["add", "--", "."])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getUnmergedPaths (mt#1806)
// ---------------------------------------------------------------------------

describe("getUnmergedPaths", () => {
  it("returns a set of unmerged paths from git output", () => {
    const runGit = fakeRunGitWithUnmerged(["src/foo.ts", "src/bar.ts"]);
    const result = getUnmergedPaths(runGit);
    expect(result).not.toBeNull();
    expect(result?.has("src/foo.ts")).toBe(true);
    expect(result?.has("src/bar.ts")).toBe(true);
  });

  it("returns an empty set when no unmerged paths", () => {
    const runGit = fakeRunGitWithUnmerged([]);
    const result = getUnmergedPaths(runGit);
    expect(result).not.toBeNull();
    expect(result?.size).toBe(0);
  });

  it("returns null (fail-closed) when git fails", () => {
    const result = getUnmergedPaths(fakeRunGitError());
    expect(result).toBeNull();
  });

  // CRLF cross-platform robustness (mt#1806 R1 — Windows git output may emit \r\n)
  it("parses CRLF output without leaving \\r artifacts in paths", () => {
    const runGit = () => "src/foo.ts\r\nsrc/bar.ts\r\n";
    const result = getUnmergedPaths(runGit);
    expect(result).not.toBeNull();
    expect(result?.has("src/foo.ts")).toBe(true);
    expect(result?.has("src/bar.ts")).toBe(true);
    expect(result?.has("src/foo.ts\r")).toBe(false);
    expect(result?.has("src/bar.ts\r")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isConflictResolutionAdd (mt#1806)
// ---------------------------------------------------------------------------

describe("isConflictResolutionAdd", () => {
  it("returns true when the path is in the unmerged set", () => {
    const runGit = fakeRunGitWithUnmerged(["src/conflict.ts"]);
    expect(isConflictResolutionAdd(["add", "src/conflict.ts"], runGit)).toBe(true);
  });

  it("returns true when all multiple paths are in the unmerged set", () => {
    const runGit = fakeRunGitWithUnmerged(["a.ts", "b.ts"]);
    expect(isConflictResolutionAdd(["add", "a.ts", "b.ts"], runGit)).toBe(true);
  });

  it("returns false when the path is NOT in the unmerged set (acceptance test #4)", () => {
    const runGit = fakeRunGitWithUnmerged(["other.ts"]);
    expect(isConflictResolutionAdd(["add", "clean.ts"], runGit)).toBe(false);
  });

  it("returns false when some paths are conflicted but not all", () => {
    const runGit = fakeRunGitWithUnmerged(["conflicted.ts"]);
    expect(isConflictResolutionAdd(["add", "conflicted.ts", "clean.ts"], runGit)).toBe(false);
  });

  it("returns false for bare `git add` (null paths → no carve-out)", () => {
    const runGit = fakeRunGitWithUnmerged(["foo.ts"]);
    expect(isConflictResolutionAdd(["add"], runGit)).toBe(false);
  });

  it("returns false for `git add -A` (broad flag → no carve-out)", () => {
    const runGit = fakeRunGitWithUnmerged(["foo.ts"]);
    expect(isConflictResolutionAdd(["add", "-A"], runGit)).toBe(false);
  });

  it("returns false (fail-closed) when git is unavailable", () => {
    expect(isConflictResolutionAdd(["add", "foo.ts"], fakeRunGitError())).toBe(false);
  });

  it("returns true for the `--` form when path is in unmerged set", () => {
    const runGit = fakeRunGitWithUnmerged(["src/conflict.ts"]);
    expect(isConflictResolutionAdd(["add", "--", "src/conflict.ts"], runGit)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkDenial — git add conflict-resolution carve-out integration (mt#1806)
// ---------------------------------------------------------------------------

describe("checkDenial — git add conflict-resolution carve-out", () => {
  it("permits `git add <conflicted-path>` when path is in unmerged set", () => {
    const runGit = fakeRunGitWithUnmerged(["src/conflict.ts"]);
    const result = checkDenial({ binary: "git", args: ["add", "src/conflict.ts"] }, "bash", runGit);
    expect(result).toBeNull();
  });

  it("permits `git add` of multiple conflicted paths", () => {
    const runGit = fakeRunGitWithUnmerged(["a.ts", "b.ts"]);
    const result = checkDenial({ binary: "git", args: ["add", "a.ts", "b.ts"] }, "bash", runGit);
    expect(result).toBeNull();
  });

  it("denies `git add <non-conflicted-path>` (acceptance test #4)", () => {
    const runGit = fakeRunGitWithUnmerged(["other.ts"]);
    const result = checkDenial({ binary: "git", args: ["add", "clean.ts"] }, "bash", runGit);
    expect(result).not.toBeNull();
    expect(result).toContain("session_commit");
  });

  it("denies `git add` with no paths (broad staging)", () => {
    const runGit = fakeRunGitWithUnmerged(["foo.ts"]);
    const result = checkDenial({ binary: "git", args: ["add"] }, "bash", runGit);
    expect(result).not.toBeNull();
  });

  it("denies `git add -A` (broad flag, no carve-out even if files are conflicted)", () => {
    const runGit = fakeRunGitWithUnmerged(["foo.ts"]);
    const result = checkDenial({ binary: "git", args: ["add", "-A"] }, "bash", runGit);
    expect(result).not.toBeNull();
  });

  it("denies `git add .` (broad glob, no carve-out)", () => {
    const runGit = fakeRunGitWithUnmerged(["foo.ts"]);
    const result = checkDenial({ binary: "git", args: ["add", "."] }, "bash", runGit);
    expect(result).not.toBeNull();
  });

  it("denies (fail-closed) when git is not in a repo", () => {
    const result = checkDenial(
      { binary: "git", args: ["add", "src/conflict.ts"] },
      "bash",
      fakeRunGitError()
    );
    expect(result).not.toBeNull();
  });

  it("permits via session_exec context when path is conflicted", () => {
    const runGit = fakeRunGitWithUnmerged(["src/conflict.ts"]);
    const result = checkDenial(
      { binary: "git", args: ["add", "src/conflict.ts"] },
      "session_exec",
      runGit
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mt#3788 — quote-aware operator splitting
// ---------------------------------------------------------------------------

describe("splitOnShellOperators — quote awareness (mt#3788)", () => {
  it("does not split on a pipe inside single quotes — the originating case", () => {
    // This exact command was denied before mt#3788: the `|` inside the regex
    // split the string, producing a segment that literally read `git add`.
    const command = "grep -rln -E 'block-git-gh-cli|git add|guard matcher' docs/architecture";
    expect(splitOnShellOperators(command)).toEqual([command]);
    expect(parseCommands(command)).toEqual([]);
  });

  it("does not split on a semicolon inside double quotes", () => {
    const command = 'echo "hello; git push"';
    expect(splitOnShellOperators(command)).toEqual([command]);
    expect(parseCommands(command)).toEqual([]);
  });

  it("keeps a quoted commit message with a pipe in one segment, still denied", () => {
    const command = 'git commit -m "a | b"';
    expect(splitOnShellOperators(command)).toEqual([command]);
    const parsed = parseCommands(command);
    expect(parsed).toHaveLength(1);
    expect(parsed.map((p) => checkDenial(p, "bash")).join("")).toContain("session_commit");
  });

  it("still splits on real operators outside quotes", () => {
    expect(splitOnShellOperators("ls && git push")).toEqual(["ls", "git push"]);
    expect(splitOnShellOperators("ls | grep x; git status")).toEqual([
      "ls",
      "grep x",
      "git status",
    ]);
    expect(splitOnShellOperators("a || git push")).toEqual(["a", "git push"]);
  });

  it("still denies a real chained git command that follows a quoted argument", () => {
    const command = "grep -E 'a|b' file && git push";
    expect(splitOnShellOperators(command)).toEqual(["grep -E 'a|b' file", "git push"]);
    const parsed = parseCommands(command);
    expect(parsed).toHaveLength(1);
    expect(parsed.map((p) => checkDenial(p, "bash")).join("")).toContain("git_push");
  });

  it("honours a backslash-escaped double quote inside double quotes", () => {
    const command = 'echo "he said \\"hi\\"; git push"';
    expect(splitOnShellOperators(command)).toEqual([command]);
  });

  it("falls back to the quote-blind split when quotes are unbalanced (fail-closed)", () => {
    const command = "echo 'unterminated; git push";
    // The naive split still yields a `git push` segment, so the guard denies —
    // over-splitting is the safe direction.
    expect(splitOnShellOperators(command)).toEqual(splitOnShellOperatorsUnquoted(command));
    expect(parseCommands(command)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// mt#3788 — target-repository scope
// ---------------------------------------------------------------------------

/** Stand-in for the hook installation's own checkout in the mt#3788 scope tests. */
const FAKE_PROJECT_ROOT = "/Users/e/Projects/minsky";
/** Stand-in for a git repo Minsky does not manage. */
const FAKE_EXTERNAL_ROOT = "/tmp/scratch/probe";

describe("isMinskySessionPath (mt#3788)", () => {
  it("recognises the canonical session-workspace root", () => {
    expect(isMinskySessionPath("/Users/e/.local/state/minsky/sessions/abc-123")).toBe(true);
  });

  it("recognises a dot-prefixed .minsky/sessions root", () => {
    expect(isMinskySessionPath("/repo/.minsky/sessions/abc-123")).toBe(true);
  });

  it("does not match the project checkout or an unrelated repo", () => {
    expect(isMinskySessionPath(FAKE_PROJECT_ROOT)).toBe(false);
    expect(isMinskySessionPath(FAKE_EXTERNAL_ROOT)).toBe(false);
  });
});

describe("classifyRepoScope (mt#3788)", () => {
  const PROJECT = FAKE_PROJECT_ROOT;
  const SESSION = "/Users/e/.local/state/minsky/sessions/abc-123";
  const EXTERNAL = FAKE_EXTERNAL_ROOT;

  // Every candidate below IS a repo root, so findRepoRoot's upward walk stops
  // immediately and the classification is driven entirely by the path.
  const existsAt = (roots: string[]) => (p: string) =>
    roots.some((r) => p === `${r}/.git`) || roots.some((r) => p.startsWith(`${r}/.git`));

  it("classifies the hook installation's own repo as project", () => {
    expect(classifyRepoScope(PROJECT, PROJECT, existsAt([PROJECT]))).toBe("project");
  });

  it("classifies a session workspace as session, not external", () => {
    // The regression this guards: a session clone's root never equals the
    // project root, so without the path test it would read as external and
    // the guard would stop enforcing where it matters most.
    expect(classifyRepoScope(SESSION, PROJECT, existsAt([SESSION]))).toBe("session");
  });

  it("classifies an unrelated scratch repo as external", () => {
    expect(classifyRepoScope(EXTERNAL, PROJECT, existsAt([EXTERNAL]))).toBe("external");
  });

  it("returns indeterminate when the cwd resolves to no real repo (fail-closed)", () => {
    expect(classifyRepoScope("/tmp/not-a-repo", PROJECT, () => false)).toBe("indeterminate");
  });

  it("returns indeterminate when cwd is absent (fail-closed)", () => {
    expect(classifyRepoScope(undefined, PROJECT, () => true)).toBe("indeterminate");
  });
});

describe("commandMayRelocateCwd — vetoes the carve-out (PR #2685 R2)", () => {
  it("fires on a chained cd, the permissive-direction bypass", () => {
    // With input.cwd in a scratch repo the scope would be `external`, so
    // without this veto the push would be carved out on a scope computed for
    // a directory it never runs in.
    expect(commandMayRelocateCwd(`cd ${FAKE_PROJECT_ROOT} && git push`)).toBe(true);
    expect(commandMayRelocateCwd("git add -A; cd /elsewhere; git commit -m x")).toBe(true);
  });

  it("fires on pushd/popd and on env --chdir", () => {
    expect(commandMayRelocateCwd("pushd /elsewhere && git push")).toBe(true);
    expect(commandMayRelocateCwd("popd && git push")).toBe(true);
    expect(commandMayRelocateCwd("env -C /elsewhere git push")).toBe(true);
  });

  it("fires on a nested shell and on subshell / command substitution", () => {
    expect(commandMayRelocateCwd(`sh -c "cd ${FAKE_PROJECT_ROOT} && git push"`)).toBe(true);
    expect(commandMayRelocateCwd("(cd /elsewhere; git push)")).toBe(true);
    expect(commandMayRelocateCwd("TAG=$(cd /elsewhere && git log -1) git push")).toBe(true);
  });

  it("does not fire on an ordinary command with no relocation", () => {
    expect(commandMayRelocateCwd("git add -A")).toBe(false);
    expect(commandMayRelocateCwd("git add -A && git commit -m x")).toBe(false);
    expect(commandMayRelocateCwd("ls | grep foo && git status")).toBe(false);
  });

  it("is not fooled by the word cd appearing inside a quoted argument", () => {
    // Quote-aware splitting keeps this one segment whose binary is `git`.
    expect(commandMayRelocateCwd(`git commit -m "cd into the thing"`)).toBe(false);
  });
});

describe("resolveLeadingCdTarget (mt#3798)", () => {
  const BASE = "/Users/e/Projects/minsky";

  it("resolves an absolute leading cd — the case that unblocks the carve-out", () => {
    expect(resolveLeadingCdTarget(`cd ${FAKE_EXTERNAL_ROOT} && git add -A`, BASE)).toBe(
      FAKE_EXTERNAL_ROOT
    );
    expect(
      resolveLeadingCdTarget(`cd ${FAKE_EXTERNAL_ROOT} && git init -q . && git add -A`, BASE)
    ).toBe(FAKE_EXTERNAL_ROOT);
  });

  it("resolves a relative leading cd against the base cwd", () => {
    expect(resolveLeadingCdTarget("cd sub/dir && git add -A", BASE)).toBe(`${BASE}/sub/dir`);
  });

  it("resolves the PROJECT path too — the scope check, not this, does the denying", () => {
    // SC2's bypass: this must resolve so classifyRepoScope can call it `project`.
    expect(resolveLeadingCdTarget(`cd ${BASE} && git push`, "/tmp/scratch")).toBe(BASE);
  });

  it("refuses a target it cannot read literally", () => {
    expect(resolveLeadingCdTarget("cd $SOME_VAR && git push", BASE)).toBeNull();
    expect(resolveLeadingCdTarget('cd "$(pwd)" && git push', BASE)).toBeNull();
    expect(resolveLeadingCdTarget("cd ~/Projects/minsky && git push", BASE)).toBeNull();
    expect(resolveLeadingCdTarget("cd /tmp/scr*tch && git push", BASE)).toBeNull();
  });

  it("refuses when anything relocates again after the leading cd", () => {
    expect(resolveLeadingCdTarget("cd /tmp/scratch && cd /elsewhere && git push", BASE)).toBeNull();
    expect(
      resolveLeadingCdTarget(`cd /tmp/scratch && sh -c "cd ${BASE} && git push"`, BASE)
    ).toBeNull();
    expect(
      resolveLeadingCdTarget("cd /tmp/scratch && pushd /elsewhere && git push", BASE)
    ).toBeNull();
  });

  it("refuses a cd that is not the FIRST segment, or is not a bare two-token cd", () => {
    expect(resolveLeadingCdTarget("git add -A && cd /tmp/scratch", BASE)).toBeNull();
    expect(resolveLeadingCdTarget("cd && git push", BASE)).toBeNull();
    expect(resolveLeadingCdTarget("cd -P /tmp/scratch && git push", BASE)).toBeNull();
  });

  it("refuses a lone cd with nothing after it, and refuses without a base cwd", () => {
    expect(resolveLeadingCdTarget("cd /tmp/scratch", BASE)).toBeNull();
    expect(resolveLeadingCdTarget("cd /tmp/scratch && git push", undefined)).toBeNull();
  });
});

describe("isLiterallyResolvablePath (mt#3798)", () => {
  it("accepts plain absolute and relative paths", () => {
    expect(isLiterallyResolvablePath(FAKE_EXTERNAL_ROOT)).toBe(true);
    expect(isLiterallyResolvablePath("sub/dir")).toBe(true);
    expect(isLiterallyResolvablePath("../sibling")).toBe(true);
  });

  it("rejects expansion, substitution, globs, and tilde", () => {
    for (const t of ["$VAR", "a$VAR/b", "`pwd`", "~", "~/x", "a*b", "a?b", "a[0]", "a{b,c}", ""]) {
      expect(isLiterallyResolvablePath(t)).toBe(false);
    }
  });
});

describe("isCwdScopedInvocation — what the external carve-out may cover (PR #2685 R1)", () => {
  it("covers a plain git command, whose target repo IS the cwd", () => {
    expect(isCwdScopedInvocation({ binary: "git", args: ["add", "-A"] })).toBe(true);
    expect(isCwdScopedInvocation({ binary: "git", args: ["commit", "-m", "x"] })).toBe(true);
    expect(isCwdScopedInvocation({ binary: "git", args: ["push"] })).toBe(true);
  });

  it("never covers gh — it names its target repo in the args, not the cwd", () => {
    // The hole this closes: `cd /tmp/scratch && gh api PUT
    // /repos/edobry/minsky/pulls/N/merge` would otherwise bypass every
    // gh-policy denial, including the merge surfaces.
    expect(
      isCwdScopedInvocation({
        binary: "gh",
        args: ["api", "-X", "PUT", "/repos/edobry/minsky/pulls/1/merge"],
      })
    ).toBe(false);
    expect(isCwdScopedInvocation({ binary: "gh", args: ["pr", "merge"] })).toBe(false);
  });

  it("never covers a git command that redirects at another path", () => {
    // `git -C` stays denied everywhere by deliberate design (session
    // isolation), which mt#3788's spec puts explicitly out of scope.
    expect(
      isCwdScopedInvocation({ binary: "git", args: ["-C", FAKE_PROJECT_ROOT, "commit"] })
    ).toBe(false);
    expect(
      isCwdScopedInvocation({ binary: "git", args: ["--git-dir=/elsewhere/.git", "commit"] })
    ).toBe(false);
    expect(
      isCwdScopedInvocation({ binary: "git", args: ["--work-tree", "/elsewhere", "add", "-A"] })
    ).toBe(false);
  });
});

/** The override the escape must name — asserted in several places below. */
const OVERRIDE_DIRECTIVE = "MINSKY_HOOK_OVERRIDE=block-git-gh-cli";

/**
 * Ceiling on the escape's length. Test-local on purpose: nothing at runtime
 * reads it, so it has no business being exported from the guard (PR #3405 R2).
 * The risk it guards is the constant GROWING unnoticed — which a test catches
 * and a runtime bound on a fixed string cannot.
 */
const MAX_ESCAPE_CHARS = 600;

/** A representative shipped redirect, used as the sample base reason. */
const SAMPLE_REDIRECT = "Use `mcp__minsky__git_log` instead of `git log`.";

describe("REDIRECT_UNAVAILABLE_ESCAPE (mt#4257)", () => {
  // Every redirect in this guard names an `mcp__*` tool. When that server is
  // disconnected the tools do not load — and `session_exec`, the documented
  // fallback, is itself an MCP tool on the same server, so it goes with them.
  // The denial then names ~34 unreachable tools and no reachable path. These
  // pin the escape that closes that gap.

  it("names the guard's own override, derived from GUARD_NAME rather than retyped", () => {
    // Retyping the name is how an override string drifts from the guard it
    // unlocks; asserting the composed value catches that.
    expect(REDIRECT_UNAVAILABLE_ESCAPE).toContain(OVERRIDE_DIRECTIVE);
  });

  it("names the availability condition, not just the override", () => {
    // An override with no stated trigger reads as a general-purpose bypass.
    expect(REDIRECT_UNAVAILABLE_ESCAPE).toContain("MCP server is disconnected");
    expect(REDIRECT_UNAVAILABLE_ESCAPE).toContain("/mcp");
  });

  it("says the documented fallback shares the failure mode", () => {
    // This is the non-obvious half: an agent that knows session_exec is the
    // carve-out will reach for it first, and it is gone too.
    expect(REDIRECT_UNAVAILABLE_ESCAPE).toContain("session_exec");
    expect(REDIRECT_UNAVAILABLE_ESCAPE).toContain("same server");
  });

  it("starts with a blank-line separator so it cannot run into the redirect text", () => {
    expect(REDIRECT_UNAVAILABLE_ESCAPE.startsWith("\n\n")).toBe(true);
  });

  it("NEGATIVE CONTROL: the base redirect strings do NOT carry the escape", () => {
    // The escape is appended once at the denial site, not baked into each
    // rule — so the calibration record (which stores the base `reason`) stays
    // groupable by redirect. If a rule string ever embeds it, this fails.
    for (const rule of [...gitDenials, ...ghDenials]) {
      expect(rule.reason).not.toContain("MINSKY_HOOK_OVERRIDE");
    }
  });
});

describe("buildDenialReason (mt#4257, PR #3405 R1)", () => {
  // R1 non-blocking: only the constant was asserted; the EMITTED text rested on
  // a grep. The append is extracted so the emitted string is observable.

  it("emits the rule's redirect followed by the escape", () => {
    const emitted = buildDenialReason(SAMPLE_REDIRECT);
    expect(emitted).toContain(SAMPLE_REDIRECT);
    expect(emitted).toContain(OVERRIDE_DIRECTIVE);
    expect(emitted.startsWith(SAMPLE_REDIRECT)).toBe(true);
  });

  it("emits a reachable path for EVERY shipped rule, not just the one sampled", () => {
    // The defect this closes is per-redirect, so assert across the whole rule
    // set rather than trusting one example to stand in for 32.
    for (const rule of [...gitDenials, ...ghDenials]) {
      const emitted = buildDenialReason(rule.reason ?? "");
      expect(emitted).toContain(OVERRIDE_DIRECTIVE);
    }
  });

  it("NEGATIVE CONTROL: the base reason handed to the calibration record is unchanged", () => {
    // Calibration groups by redirect, so the escape must NOT reach the record.
    const base = SAMPLE_REDIRECT;
    expect(base).not.toContain("MINSKY_HOOK_OVERRIDE");
    expect(buildDenialReason(base)).not.toBe(base);
  });

  it("R1 blocking: the escape stays under its authored ceiling", () => {
    // Runtime truncation of a fixed constant is meaningless; unbounded GROWTH
    // of it is the real risk, and this is where that binds.
    expect(REDIRECT_UNAVAILABLE_ESCAPE.length).toBeLessThanOrEqual(MAX_ESCAPE_CHARS);
  });

  it("R1 blocking: worst-case emitted denial stays well inside the nearest budget", () => {
    // MERGED_CONTEXT_BUDGET_CHARS is 6627 and governs a different channel; this
    // pins that the deny channel's worst case does not drift toward it.
    const worst = Math.max(
      ...[...gitDenials, ...ghDenials].map((r) => buildDenialReason(r.reason ?? "").length)
    );
    expect(worst).toBeLessThan(2000);
  });
});
