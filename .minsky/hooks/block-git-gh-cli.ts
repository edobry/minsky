#!/usr/bin/env bun
// PreToolUse hook: block git/gh CLI commands when a purpose-built MCP tool exists.
//
// Rationale: Minsky provides MCP tools for all common git/gh operations.
// Using raw CLI bypasses session resolution, auto-push, and audit trails.
// This hook intercepts both `Bash` AND `mcp__minsky__session_exec` tool calls
// (both accept a `command` parameter) and denies known-equivalent operations.
//
// Four rules (`git status`, `git reset`, `git stash`, `git restore`) are tagged
// `allowedInSessionExec: true` and skipped when the invocation is already via
// session_exec — otherwise the hook would deny the very fallback its own denial
// text offers.
//
// Their denial text names the MCP tool FIRST (mt#4226). All four of those MCP
// tools accept a `session` parameter, so `session_exec` is the fallback for what
// the tools do NOT cover — not "the path for sessions", which is what this text
// said until 2026-08-18 and which named no real capability boundary. When you
// ship an MCP tool that covers a carved-out command, update the matching `reason`
// string in the same PR: a denial string is an instruction carrying hook
// authority, and it ages independently of the tool surface it names (mem#1078).
//
// `git -C` is NOT carved out: the -C rule previously had allowedInSessionExec,
// but minsky-reviewer (mt#1196 review 4167154239) correctly identified that
// the carve-out was a bypass. Because the -C rule matches args[0] === "-C"
// and subsequent rules all check args[0] for a subcommand, a skipped -C rule
// let `git -C /anywhere commit|push|merge` slip through untouched. Also,
// allowing -C on session_exec would let callers scope operations outside the
// session root, violating session isolation. Denied unconditionally.
//
// Carve-out (mt#1806): `git add <explicit-paths>` is permitted when ALL
// specified paths are in git's "conflicted" (unmerged) set, as reported by
// `git diff --name-only --diff-filter=U`. This covers the final step of
// stash-pop / merge conflict resolution: after stripping conflict markers the
// agent runs `git add <file>` to mark the path resolved in the git index.
// Broad staging ops (`git add .`, `git add -A`, `git add -u`, `git add`
// with no paths) are NOT carved out — only explicit-path additions where
// every named path is in the unmerged set.
//
// @see mt#1196 — extending this hook to cover session_exec after PR #717
// retrospective surfaced the loophole.
// @see mt#1806 — git add carve-out for conflict resolution

import { execSync } from "child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readInput, writeOutput, findRepoRoot, deriveHookRepoRoot } from "./types";
import type { ToolHookInput } from "./types";
import { recordFireLogEntry } from "./fire-log";
import { recordGuardDenial } from "./two-strikes-record";

/** This guard's fire-log identifier (mt#2597, evaluation-loop Phase 1). */
const GUARD_NAME = "block-git-gh-cli";

/**
 * Appended to every agent-facing denial (mt#4257).
 *
 * Every redirect in this file names an `mcp__*` tool, and the module header
 * above already records one availability lesson: `session_exec` is carved out
 * so the hook does not "deny the very fallback its own denial text offers."
 * That reasoning covers a fallback this GUARD blocks. It does not cover a
 * fallback that does not EXIST.
 *
 * When an MCP server is disconnected its tools do not load at all — and because
 * `session_exec` is itself `mcp__minsky__session_exec`, the Minsky server going
 * down takes the redirect targets AND the documented escape hatch together. The
 * agent is then denied the CLI and handed ~34 tool names it cannot call, with
 * nothing left to do. Observed twice while auditing this guard (mt#4257): a
 * denied `git log` during a Minsky-MCP outage left reading `.git/HEAD` by hand
 * as the only way to see git state. A guard cannot be more available than the
 * mechanism its instruction names, so the denial has to say what to do when
 * that mechanism is gone.
 *
 * This states the CAPABILITY boundary — what the named tools cannot do — which
 * is the discipline mem#1078 draws from the mt#4226 fix, applied to
 * availability rather than to workspace.
 *
 * The github-MCP half of the same class (six `mcp__github__*` redirects that go
 * dark when the Docker daemon is down) is owned by mt#3779.
 */
export const REDIRECT_UNAVAILABLE_ESCAPE =
  `\n\nIf the tool named above will not load — an MCP server is disconnected, so ` +
  `\`mcp__*\` tools are absent — then this redirect names no reachable path, and ` +
  `neither does \`session_exec\` (itself an MCP tool on the same server). Reconnect ` +
  `first (\`/mcp\`). If it is still unreachable and the command is genuinely needed, ` +
  `set \`MINSKY_HOOK_OVERRIDE=${GUARD_NAME}\` for that one invocation — audit-logged, ` +
  `and the honest option rather than hand-reading \`.git\` plumbing around the guard.`;

// ---------------------------------------------------------------------------
// Tool context
// ---------------------------------------------------------------------------

export type HookTool = "bash" | "session_exec";

export const SESSION_EXEC_TOOL_NAME = "mcp__minsky__session_exec";

/** Derive a HookTool tag from the raw `tool_name` field. */
export function toolContextFromName(toolName: string): HookTool {
  return toolName === SESSION_EXEC_TOOL_NAME ? "session_exec" : "bash";
}

/**
 * Classify what this fire observed about `agent_type` (mt#3381).
 *
 * This guard denies a CLI command and names an `mcp__*` replacement, but has no
 * way to know whether the caller actually holds that replacement — the
 * PreToolUse payload carries no tool inventory. `agent_type` is the one field
 * that could close the gap for subagents (it maps to an agent definition whose
 * declared grant is knowable), and the vendor documents it — but nothing in this
 * repo has ever observed it. Rather than build on an unverified field or guess,
 * record what each fire actually saw and let ordinary subagent traffic answer it.
 *
 * The three-way split is the point: a bare missing string cannot distinguish
 * "the field does not exist" from "this simply was not a subagent call", and
 * only the first of those is evidence.
 */
export function classifyAgentTypeObservation(input: {
  agent_id?: string;
  agent_type?: string;
}): "present" | "absent-in-subagent" | "not-a-subagent" {
  if (input.agent_type) return "present";
  return input.agent_id ? "absent-in-subagent" : "not-a-subagent";
}

// ---------------------------------------------------------------------------
// Target-repository scope (mt#3788)
// ---------------------------------------------------------------------------

/**
 * Which repository a Bash invocation is standing in, relative to the two this
 * guard exists to protect.
 *
 * - `project`    — the Minsky checkout the hook installation itself lives in.
 * - `session`    — a Minsky session workspace clone.
 * - `external`   — some other git repository entirely.
 * - `indeterminate` — no repo root could be established (fail CLOSED: deny).
 */
export type RepoScope = "project" | "session" | "external" | "indeterminate";

/**
 * True when `path` sits inside a Minsky session-workspace root.
 *
 * Load-bearing: a session workspace is a CLONE, so its repo root never equals
 * the hook installation's root. Without this test every session would classify
 * as `external` and the guard would stop enforcing exactly where session
 * provenance matters most — the inverse of what mt#3788 set out to do.
 */
export function isMinskySessionPath(path: string): boolean {
  const normalized = resolve(path).split("\\").join("/");
  return /(^|\/)\.?minsky\/sessions\//.test(normalized);
}

/**
 * Classify the repository a command is being run against.
 *
 * The guard's redirects — `session_commit`, `session_pr_create`, `git_push` —
 * are all Minsky operations against a Minsky-managed repo. In a repository
 * Minsky does not manage there is nothing to redirect TO, so denying there
 * blocks work while protecting nothing. mt#3788's originating case: a
 * throwaway git repo in the agent scratchpad, created to reproduce a bun
 * defect in isolation, could not be seeded because `git add` was denied.
 *
 * Fail-closed by construction — only a POSITIVELY identified foreign repo
 * returns `external`. A cwd we cannot resolve to a real repo root returns
 * `indeterminate`, which callers treat as deny.
 */
/**
 * Whether a command string contains any construct that could move the working
 * directory out from under `input.cwd` before a later segment runs.
 *
 * PR #2685 R2: the scope is resolved ONCE, from the cwd the harness reports at
 * invocation time. That is only a true description of where a git command runs
 * if nothing in the command relocates first. The bypass runs in the permissive
 * direction — with `input.cwd` in a scratch repo (scope `external`),
 * `cd /Users/edobry/Projects/minsky && git push` would be carved out on a scope
 * computed for a directory the push never happens in.
 *
 * Rather than thread a simulated cwd through the segments — which would need a
 * real shell model to get right, and would be wrong the first time it met a
 * variable — this refuses the carve-out entirely whenever relocation is
 * POSSIBLE. Detection is deliberately over-broad: a false hit costs the
 * pre-mt#3788 behavior (a denial), which is the safe direction.
 */
/** Does THIS segment, on its own, move the working directory? */
function segmentRelocates(segment: string): boolean {
  const tokens = stripEnvVarAssignments(segment.split(/\s+/).filter((t) => t.length > 0));
  if (tokens.length === 0) return false;
  const [binary, ...rest] = tokens;
  if (binary === "cd" || binary === "pushd" || binary === "popd" || binary === "chdir") return true;
  // `env -C <dir> …` and a nested shell running an arbitrary script.
  if (binary === "env" && rest.some((a) => a === "-C" || a.startsWith("--chdir"))) return true;
  if (
    (binary === "sh" || binary === "bash" || binary === "zsh" || binary === "dash") &&
    rest.includes("-c")
  ) {
    return true;
  }
  return false;
}

export function commandMayRelocateCwd(command: string): boolean {
  // Subshells and command substitution can carry a `cd` we never tokenize.
  if (/[`(]/.test(command)) return true;
  return splitOnShellOperators(command).some(segmentRelocates);
}

/**
 * A path argument this hook can resolve WITHOUT running a shell: no variable
 * expansion, no command substitution, no glob, no `~` (whose expansion depends
 * on the invoking user's environment, which the hook does not model).
 *
 * Anything outside that set returns false and the caller falls back to the
 * relocation veto — the narrowness is the point, not a limitation to grow out
 * of casually.
 */
export function isLiterallyResolvablePath(token: string): boolean {
  if (token.length === 0) return false;
  return !/[$`~*?[\]{}]/.test(token);
}

/**
 * Resolve the directory a command relocates to, for the ONE shape this hook can
 * read with certainty: a command whose FIRST segment is exactly
 * `cd <literal-path>` and which relocates nowhere else.
 *
 * mt#3798: mt#3788 shipped a carve-out for git commands in repositories Minsky
 * does not manage, and PR #2685 R2 then correctly vetoed it whenever a command
 * could relocate — because the scope was computed once from `input.cwd`. But in
 * the Bash tool `cd` is the ONLY way to reach a foreign directory at all, so
 * every invocation the carve-out was built for necessarily contained the
 * construct that disabled it. The carve-out could never fire; mt#3788's own
 * Acceptance Test 1 was unmet by what merged.
 *
 * This resolves the target instead of guessing, for the narrow decidable case,
 * and leaves the veto untouched everywhere else. Returns null — meaning "keep
 * the veto" — for a variable, a substitution, a glob, a `~`, a second
 * relocation later in the command, or any subshell.
 *
 * A relative target resolves against `baseCwd`; the RESULT is only a candidate
 * path, and `classifyRepoScope` still has to find a real repo root there, so a
 * `cd` to a nonexistent or non-repo directory lands on `indeterminate` and
 * denies.
 */
export function resolveLeadingCdTarget(
  command: string,
  baseCwd: string | undefined
): string | null {
  if (!baseCwd) return null;
  // A subshell or substitution anywhere means the tokenization is unreliable.
  if (/[`(]/.test(command)) return null;

  const segments = splitOnShellOperators(command);
  const firstSegment = segments[0];
  // Need the leading `cd` AND at least one command after it to scope.
  if (segments.length < 2 || firstSegment === undefined) return null;

  const firstTokens = stripEnvVarAssignments(firstSegment.split(/\s+/).filter((t) => t.length > 0));
  const targetToken = firstTokens[1];
  // Exactly `cd <one-arg>` — a flagged form (`cd -P …`) is not this shape.
  if (firstTokens.length !== 2 || firstTokens[0] !== "cd" || targetToken === undefined) return null;

  // Nothing AFTER the leading cd may relocate again, or the target is stale by
  // the time the git command runs.
  if (segments.slice(1).some(segmentRelocates)) return null;

  const target = stripSurroundingQuotes(targetToken);
  if (!isLiterallyResolvablePath(target)) return null;

  return resolve(baseCwd, target);
}

/**
 * Whether a parsed invocation's target repository is the one `input.cwd` names
 * — the only case the `external` scope carve-out may be applied to.
 *
 * Two exclusions, both found by PR #2685 R1:
 *
 * - **`gh` is never cwd-scoped.** `gh api PUT /repos/edobry/minsky/pulls/N/merge`
 *   names its target repository in the URL and runs identically from any
 *   directory on the machine. Carving `gh` out by cwd would let every gh-policy
 *   denial — including the merge surfaces — be bypassed by first `cd`-ing to a
 *   scratch repo, which is a far worse hole than the false positive being fixed.
 * - **A path-redirecting git flag is never cwd-scoped.** `git -C <path>`,
 *   `--git-dir`, and `--work-tree` all point git at a repository other than the
 *   one the shell is standing in, so cwd answers the wrong question. `git -C` is
 *   additionally denied unconditionally by deliberate design (session isolation),
 *   which mt#3788's own spec puts out of scope — the early-allow this replaces
 *   silently overrode that.
 */
export function isCwdScopedInvocation(parsed: ParsedCommand): boolean {
  if (parsed.binary !== "git") return false;
  return !parsed.args.some(
    (arg) =>
      arg === "-C" ||
      arg === "--git-dir" ||
      arg === "--work-tree" ||
      arg.startsWith("--git-dir=") ||
      arg.startsWith("--work-tree=")
  );
}

export function classifyRepoScope(
  cwd: string | undefined,
  hookRepoRoot: string = deriveHookRepoRoot(),
  fileExists: (p: string) => boolean = existsSync
): RepoScope {
  if (!cwd) return "indeterminate";

  const root = findRepoRoot(cwd);
  // findRepoRoot falls back to its start directory when no repo is found, so a
  // returned path is only trustworthy when it actually carries a `.git` entry.
  if (!fileExists(join(root, ".git"))) return "indeterminate";

  if (resolve(root) === resolve(hookRepoRoot)) return "project";
  if (isMinskySessionPath(root)) return "session";
  return "external";
}

// ---------------------------------------------------------------------------
// Denial table types
// ---------------------------------------------------------------------------

export interface DenialRule {
  match: (args: string[]) => boolean;
  reason: string;
  /**
   * When true, this rule is SKIPPED when the invocation comes via
   * `mcp__minsky__session_exec`. Used for rules whose reason explicitly
   * redirects to session_exec — applying them on session_exec itself would
   * be self-contradictory.
   */
  allowedInSessionExec?: boolean;
}

// ---------------------------------------------------------------------------
// Git add conflict-resolution carve-out helpers (mt#1806)
// ---------------------------------------------------------------------------

/**
 * Extract the explicit path arguments from a `git add` arg list.
 *
 * Returns null (meaning "use broad staging") when:
 * - No args are provided (bare `git add`)
 * - Any arg starts with `-` (flags like `-A`, `-u`, `-p`, `--all`, etc. that
 *   imply broad/interactive staging)
 *
 * Returns the path list when all args are non-flag explicit paths.
 *
 * Examples:
 *   ["add", "src/foo.ts"]       → ["src/foo.ts"]
 *   ["add", "a.ts", "b.ts"]     → ["a.ts", "b.ts"]
 *   ["add", "-A"]               → null (broad flag)
 *   ["add", "."]                → null (`.` is treated as a broad path glob)
 *   ["add"]                     → null (no paths)
 */
export function extractGitAddPaths(args: string[]): string[] | null {
  // args[0] === "add"; path args start at index 1
  const pathArgs = args.slice(1);
  // No path args — broad staging intent
  if (pathArgs.length === 0) return null;

  // Handle pathspec separator: `git add -- <path>...` means everything after
  // `--` is a literal pathspec (even if it would otherwise look like a flag).
  // Before `--`, any flag means broad-staging intent.
  const sepIndex = pathArgs.indexOf("--");
  if (sepIndex !== -1) {
    // Anything BEFORE `--` that's a flag → broad-staging intent → reject
    const beforeSep = pathArgs.slice(0, sepIndex);
    if (beforeSep.some((a) => a.startsWith("-"))) return null;
    if (beforeSep.includes(".")) return null;
    // Paths are after `--` (plus any non-flag args before it, which is the
    // mixed `git add foo.ts -- bar.ts` form; treat both as paths)
    const afterSep = pathArgs.slice(sepIndex + 1);
    if (afterSep.length === 0 && beforeSep.length === 0) return null;
    const paths = [...beforeSep, ...afterSep];
    // `.` after `--` is still a broad-staging glob
    if (paths.includes(".")) return null;
    return paths.length > 0 ? paths : null;
  }

  // No `--` separator: any flag arg → broad staging
  if (pathArgs.some((a) => a.startsWith("-"))) return null;
  // `.` is equivalent to adding everything — treat as broad
  if (pathArgs.includes(".")) return null;
  return pathArgs;
}

/**
 * Return the set of unmerged (conflicted) file paths in the current git repo
 * by running `git diff --name-only --diff-filter=U`.
 *
 * Injectable `runGit` parameter lets tests substitute a fake runner without
 * spawning real processes.
 *
 * Returns null when:
 * - The command fails (not in a git repo, git unavailable, etc.)
 * - The output cannot be parsed
 * Fail-closed: callers treat null as "unmerged set unknown → deny".
 */
export function getUnmergedPaths(
  runGit: (cmd: string) => string = defaultRunGit
): Set<string> | null {
  try {
    const output = runGit("git diff --name-only --diff-filter=U");
    // Split on either LF or CRLF for cross-platform robustness; filter empties.
    const paths = output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return new Set(paths);
  } catch {
    return null;
  }
}

/** Production git runner using execSync. */
export function defaultRunGit(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * Check whether `git add <paths>` should be permitted as conflict resolution.
 *
 * Permitted when ALL of:
 * 1. `paths` is non-null and non-empty (extracted via extractGitAddPaths — no flags/`.`)
 * 2. `unmergedPaths` is non-null (git ran successfully)
 * 3. Every path in `paths` appears in `unmergedPaths`
 *
 * Injectable `runGit` for tests.
 */
export function isConflictResolutionAdd(
  args: string[],
  runGit: (cmd: string) => string = defaultRunGit
): boolean {
  const paths = extractGitAddPaths(args);
  if (paths === null || paths.length === 0) return false;
  const unmerged = getUnmergedPaths(runGit);
  if (unmerged === null) return false;
  return paths.every((p) => unmerged.has(p));
}

// ---------------------------------------------------------------------------
// Denial tables
// ---------------------------------------------------------------------------

export const gitDenials: DenialRule[] = [
  // git -C <path> <anything> — always denied on both Bash and session_exec.
  // - On Bash: redirect to session_exec (which sets cwd automatically).
  // - On session_exec: -C is redundant (cwd is the session root) AND dangerous.
  //   Dangerous because: before the mt#1196 review fix, -C was carved out on
  //   session_exec via allowedInSessionExec. That match()-skip fired first
  //   (args[0] === "-C"); subsequent rules all check args[0] for a subcommand,
  //   so `git -C /anywhere commit` (push/merge/rebase/…) would slip through
  //   untouched — a bigger loophole than the one the carve-out was meant to
  //   preserve. Also: -C lets callers scope operations outside the session
  //   root, violating session isolation. Denying unconditionally closes both.
  {
    match: (args) => args[0] === "-C",
    reason:
      "`git -C` is not allowed. On Bash, use `mcp__minsky__session_exec(task, command)`. Inside session_exec, omit `-C` — the session cwd is already set. Session isolation: `-C` could point git at paths outside the session root.",
  },
  {
    match: (args) => args[0] === "add",
    reason: "Use `mcp__minsky__session_commit` with `all: true` instead of `git add`.",
  },
  {
    match: (args) => args[0] === "commit",
    reason: "Use `mcp__minsky__session_commit` instead of `git commit`.",
  },
  {
    match: (args) => args[0] === "push",
    reason:
      "Use `mcp__minsky__session_commit` (auto-pushes) or `mcp__minsky__git_push` instead of `git push`.",
  },
  {
    match: (args) => args[0] === "status",
    reason:
      // mt#3381: `mcp__minsky__git_status` is named FIRST because it is the only
      // read-only option here. Redirecting solely to `session_exec` dead-ends
      // every caller whose grant deliberately omits it — the reviewer and
      // auditor agents omit it precisely because it can mutate, so telling them
      // to use it is advice they cannot take and must not be given.
      // mt#4226: `git_status` takes a `session`, so it serves sessions too — the
      // old "or session_exec inside a session" phrasing implied a boundary that
      // does not exist. session_exec stays as the fallback for porcelain output
      // this tool does not model.
      "Use `mcp__minsky__git_status({ session })` — read-only, and it accepts a `session`, so it covers session workspaces as well as main. Fallback: `mcp__minsky__session_exec(task, 'git status ...')` for raw/porcelain output the tool does not model. Or skip the call entirely if diff/log tools already give you the context.",
    // On session_exec itself, `git status` is the recommended path — don't block.
    allowedInSessionExec: true,
  },
  {
    match: (args) => args[0] === "log",
    reason: "Use `mcp__minsky__git_log` instead of `git log`.",
  },
  {
    match: (args) => args[0] === "diff",
    reason: "Use `mcp__minsky__git_diff` or `mcp__minsky__session_diff` instead of `git diff`.",
  },
  {
    match: (args) => args[0] === "blame",
    reason: "Use `mcp__minsky__git_blame` instead of `git blame`.",
  },
  {
    match: (args) => args[0] === "fetch",
    reason:
      "Fetch is handled automatically by `mcp__minsky__session_update` and other session ops. For main-workspace fast-forward updates, use `mcp__minsky__git_pull`.",
  },
  {
    match: (args) => args[0] === "pull",
    reason:
      "For main-workspace pulls use `mcp__minsky__git_pull` (--ff-only). For session pulls, `session_update` handles it automatically.",
  },
  {
    match: (args) => args[0] === "clone",
    reason: "Use `mcp__minsky__session_start` instead of `git clone` for session creation.",
  },
  {
    match: (args) => args[0] === "checkout",
    reason: "Branch checkout is handled by session state ops (`session_start`, `session_update`).",
  },
  {
    match: (args) => args[0] === "branch",
    reason: "Branch management is handled by session state ops.",
  },
  {
    match: (args) => args[0] === "merge",
    reason: "Use `mcp__minsky__session_pr_merge` instead of `git merge`.",
  },
  {
    match: (args) => args[0] === "rebase",
    reason: "Rebasing is handled by `mcp__minsky__session_update`.",
  },
  {
    match: (args) => args[0] === "reset",
    reason:
      "Use `mcp__minsky__git_reset({ session, mode })` — it accepts a `session`, so it covers session workspaces as well as main (`mode` is required; `confirmHard: true` additionally required for hard mode). Fallback: `mcp__minsky__session_exec(task, 'git reset ...')` for forms the tool does not model, such as a pathspec reset. This is destructive — consider a revert alternative first.",
    // On session_exec itself, `git reset` is the recommended escape hatch — don't block.
    allowedInSessionExec: true,
  },
  {
    match: (args) => args[0] === "stash",
    reason:
      "Use `mcp__minsky__git_stash({ session, message, paths })` / `git_stash_pop` / `git_stash_list` / `git_stash_drop` — these accept a `session`, so they cover session workspaces as well as main. Fallback: `mcp__minsky__session_exec(task, 'git stash ...')` for the subcommands there is no tool for, such as `git stash apply` or `git stash show`.",
    // On session_exec itself, `git stash` is the recommended escape hatch — don't block.
    allowedInSessionExec: true,
  },
  {
    match: (args) => args[0] === "restore",
    reason:
      // mt#4226: this is the one carve-out with a REAL capability boundary, so
      // the message names it rather than a workspace split. `git_restore` has no
      // `source` parameter (mt#1297 SC1), and the legacy `git checkout <ref> --
      // <path>` spelling is denied even on session_exec by the `checkout` rule
      // above — which has no carve-out — so `--source=` is the only working path.
      "Use `mcp__minsky__git_restore({ session, paths })` to discard uncommitted changes — it accepts a `session`, so it covers session workspaces as well as main. The one case it CANNOT do is materialise a file from another revision: it has no `source` parameter (tracked as mt#1297). For that, use `mcp__minsky__session_exec(task, 'git restore --source=<ref> -- <path>')` — and use that `--source=` spelling specifically, because the older `git checkout <ref> -- <path>` form is denied even via session_exec.",
    // On session_exec itself, `git restore` is the recommended escape hatch — don't block.
    allowedInSessionExec: true,
  },
];

export const ghDenials: DenialRule[] = [
  {
    match: (args) => args[0] === "pr" && args[1] === "create",
    reason: "Use `mcp__minsky__session_pr_create` instead of `gh pr create`.",
  },
  {
    match: (args) => args[0] === "pr" && args[1] === "list",
    reason: "Use `mcp__github__list_pull_requests` instead of `gh pr list`.",
  },
  {
    match: (args) => args[0] === "pr" && (args[1] === "view" || args[1] === "get"),
    reason: 'Use `mcp__github__pull_request_read` (method: "get") instead of `gh pr view`.',
  },
  {
    match: (args) => args[0] === "pr" && args[1] === "close",
    reason:
      "Use `mcp__minsky__session_pr_close` instead of `gh pr close`. The Minsky tool routes through TokenProvider (bot identity), supports posting an optional closure comment before the state flip, and refuses already-closed/merged PRs with a clear error. See mt#1955.",
  },
  {
    match: (args) => args[0] === "pr" && args[1] === "merge",
    reason:
      "Use `mcp__minsky__session_pr_merge` or `mcp__github__merge_pull_request` instead of `gh pr merge`.",
  },
  {
    match: (args) => args[0] === "pr" && args[1] === "review",
    reason:
      "Use `mcp__minsky__session_pr_review_submit` instead of `gh pr review`. (The previous redirect pointed at `mcp__github__pull_request_review_write`, which is now banned by mt#1030.)",
  },
  {
    match: (args) =>
      args[0] === "issue" && (args[1] === "create" || args[1] === "list" || args[1] === "view"),
    reason: "Use `mcp__github__issue_write` / `mcp__github__issue_read` instead of `gh issue`.",
  },
  {
    match: (args) => args[0] === "run" && (args[1] === "list" || args[1] === "view"),
    reason:
      "Use `mcp__minsky__forge_ci_run_list` (for listing) or `mcp__minsky__forge_ci_run_view_log` (for logs) instead of `gh run list` / `gh run view`. The Minsky tools route through the configured ForgeBackend (mt#1957).",
  },
  {
    match: (args) =>
      args[0] === "label" &&
      (args[1] === "create" || args[1] === "list" || args[1] === "edit" || args[1] === "delete"),
    reason:
      "Use `mcp__minsky__forge_label_create` / `mcp__minsky__forge_label_list` / `mcp__minsky__forge_label_update` / `mcp__minsky__forge_label_delete` instead of `gh label`. The Minsky tools route through the configured ForgeBackend (mt#1957).",
  },
  {
    // Block `gh api .../branches/<branch>/protection` reads/writes — use forge_branch_protection_get/set.
    match: (args) => {
      if (args[0] !== "api") return false;
      return args.some((a) => /\/branches\/[^/]+\/protection/.test(a));
    },
    reason:
      "Use `mcp__minsky__forge_branch_protection_get` or `mcp__minsky__forge_branch_protection_set` instead of `gh api .../branches/.../protection`. The Minsky tools route through the configured ForgeBackend (mt#1957). Note: the operator-facing `scripts/set-branch-protection.ts` remains the canonical audit-logged write path.",
  },
  {
    // Block `gh api .../commits/<sha>/check-runs` — use forge_check_runs_list.
    match: (args) => {
      if (args[0] !== "api") return false;
      return args.some((a) => /\/commits\/[^/]+\/check-runs/.test(a));
    },
    reason:
      "Use `mcp__minsky__forge_check_runs_list` instead of `gh api .../commits/.../check-runs`. The Minsky tool exposes the existing `ci.getChecksForRef` capability at the MCP surface (mt#1957). For PR-level checks, use `mcp__minsky__session_pr_checks` instead.",
  },
  {
    // Block `gh api .../actions/runs/...` and `.../actions/workflows/.../runs` — use forge_ci_run_list/view_log.
    match: (args) => {
      if (args[0] !== "api") return false;
      return args.some(
        (a) => /\/actions\/runs(\/|$)/.test(a) || /\/actions\/workflows\/.+\/runs/.test(a)
      );
    },
    reason:
      "Use `mcp__minsky__forge_ci_run_list` or `mcp__minsky__forge_ci_run_view_log` instead of `gh api .../actions/runs/...`. The Minsky tools route through the configured ForgeBackend (mt#1957).",
  },
  {
    // Block `gh api .../labels` and `.../labels/<name>` for REPO-level label
    // management — use forge_label_* tools. Narrowed regex to match only the
    // repo-level path shape `/repos/<owner>/<repo>/labels[/...]`, NOT the
    // issue/PR-scoped `/repos/<owner>/<repo>/issues/<N>/labels` (which is
    // label application to an issue, served by `mcp__github__issue_write`, not
    // `forge_label_*`). mt#1957 PR #1185 reviewer-bot finding.
    match: (args) => {
      if (args[0] !== "api") return false;
      return args.some((a) => /\/repos\/[^/]+\/[^/]+\/labels(\/|$)/.test(a));
    },
    reason:
      "Use `mcp__minsky__forge_label_create` / `mcp__minsky__forge_label_list` / `mcp__minsky__forge_label_update` / `mcp__minsky__forge_label_delete` instead of `gh api /repos/.../labels`. The Minsky tools route through the configured ForgeBackend (mt#1957). (For applying labels to an issue or PR — `/repos/.../issues/<N>/labels` — use `mcp__github__issue_write` instead.)",
  },
  {
    // Minsky policy: the PR-merge bypass (feedback_gh_api_bypass.md) and
    // the documented workflow (docs/pr-workflow.md) BOTH require
    // merge_method=merge — we preserve merge commits for the linear-history-
    // with-meaningful-merge-commits pattern. This rule blocks `gh api` calls
    // that would squash- or rebase-merge a PR, plus calls that omit
    // merge_method entirely (ambiguous intent; GitHub's own default is
    // merge but not explicitly saying so has burned us before).
    //
    // Filed and enforced as mt#1228 after three squash-merges landed by
    // accident in one session on 2026-04-24 despite the policy being
    // cited in every bypass commit message.
    match: (args) => {
      if (args[0] !== "api") return false;
      const method = findGhApiMethod(args);
      if (method !== "PUT") return false;
      // Scan ALL tokens for a PR-merge endpoint (bypass-proof vs quote-
      // splitting of preceding -f values). See findGhApiPrMergeEndpointToken.
      const endpoint = findGhApiPrMergeEndpointToken(args);
      if (endpoint === null) return false;
      const mergeMethod = findGhApiField(args, "merge_method");
      // Block when absent OR anything other than "merge".
      return mergeMethod !== "merge";
    },
    reason:
      "`gh api PUT .../pulls/N/merge` must use `-f merge_method=merge`. Minsky preserves " +
      "merge commits for clean linear history — see docs/pr-workflow.md §Merge method policy. " +
      "Squash-merges erase PR-branch history and invalidate review-evidence links. " +
      "If you truly need the bypass, retry with `-f merge_method=merge`.",
  },
];

// ---------------------------------------------------------------------------
// Parsing logic (exported for tests)
// ---------------------------------------------------------------------------

// ENV_VAR_PREFIX matches leading `FOO=bar` assignments (possibly multiple).
const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*=\S*/;

/**
 * Strip leading shell env-var assignments from a token list and return the
 * remaining tokens.
 *
 * e.g. ["FOO=bar", "BAZ=qux", "git", "status"] → ["git", "status"]
 */
export function stripEnvVarAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined || !ENV_VAR_RE.test(token)) break;
    i++;
  }
  return tokens.slice(i);
}

/**
 * Quote-blind operator split — the original implementation, retained as the
 * fail-closed fallback for a command whose quotes do not balance (see
 * `splitOnShellOperators`). Splitting too eagerly can only produce a spurious
 * DENIAL, never a missed one, which is the direction to fail in.
 */
export function splitOnShellOperatorsUnquoted(command: string): string[] {
  // Replace &&, ||, ;, | with a NUL sentinel, then split.
  const normalized = command
    .replace(/&&/g, "\x00")
    .replace(/\|\|/g, "\x00")
    .replace(/;/g, "\x00")
    .replace(/\|/g, "\x00");
  return normalized
    .split("\x00")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Split a shell command string into individual segments on `&&`, `||`, `;`,
 * and `|` (pipe), IGNORING operators that appear inside single or double
 * quotes. Returns non-empty trimmed segments.
 *
 * mt#3788: quote-awareness was previously listed here as an accepted
 * limitation, on the reasoning that a mis-split can only cost an edge-case
 * false positive. In practice that edge case is routine — a `|` inside a
 * regex is the normal way to write an alternation, so
 * `grep -E 'block-git-gh-cli|git add|guard matcher' docs/` split into a
 * segment that literally read `git add` and was denied, even though no git
 * command was being run at all. Argument VALUES that merely mention a
 * denied command must not be read as invocations of it.
 *
 * Unbalanced quotes fall back to `splitOnShellOperatorsUnquoted` rather than
 * swallowing the rest of the command into one segment — an unterminated quote
 * is more likely a tokenizer edge this function got wrong than a deliberate
 * command, and over-splitting fails toward denial.
 *
 * STILL NOT a shell lexer, and still not a security boundary. Subshell
 * invocations like `TAG=$(git log -1)` are not parsed; the outer command is
 * checked but the inner `git log` is not. So is `sh -c "git push"`. Both
 * predate this change and are unaffected by it: this narrows false positives,
 * it does not widen what slips through.
 */
export function splitOnShellOperators(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (quote !== null) {
      // A backslash escapes the next character inside double quotes only;
      // inside single quotes POSIX shells treat backslash literally.
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += ch + command[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    // `&&` and `||` consume two characters; a lone `|` and `;` consume one.
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (ch === "|" || ch === ";") {
      segments.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  if (quote !== null) return splitOnShellOperatorsUnquoted(command);

  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

export interface ParsedCommand {
  binary: "git" | "gh";
  args: string[]; // tokens after the binary
}

/**
 * Parse a single shell segment into a ParsedCommand if it starts with git or gh,
 * or returns null otherwise.
 */
export function parseSegment(segment: string): ParsedCommand | null {
  const tokens = segment.split(/\s+/).filter((t) => t.length > 0);
  const stripped = stripEnvVarAssignments(tokens);
  if (stripped.length === 0) return null;
  const binary = stripped[0];
  if (binary !== "git" && binary !== "gh") return null;
  return {
    binary: binary as "git" | "gh",
    args: stripped.slice(1),
  };
}

/**
 * Parse an entire command string and return all git/gh invocations found.
 */
export function parseCommands(command: string): ParsedCommand[] {
  const segments = splitOnShellOperators(command);
  const result: ParsedCommand[] = [];
  for (const seg of segments) {
    const parsed = parseSegment(seg);
    if (parsed) result.push(parsed);
  }
  return result;
}

// ---------------------------------------------------------------------------
// gh api argument helpers
// ---------------------------------------------------------------------------

/**
 * Flags that consume a separate value token on `gh api` (e.g., `-X PUT`, `-H "Accept: ..."`).
 * Used by findGhApiEndpoint to skip flag-value pairs when scanning for the first positional.
 */
const GH_API_VALUE_FLAGS = new Set([
  "-X",
  "--method",
  "-H",
  "--header",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
]);

/**
 * Strip a single surrounding matched pair of single- or double-quotes from a
 * token. Needed because the upstream tokenizer is intentionally not quote-
 * aware (see splitOnShellOperators), so tokens like `"merge_method=merge"`
 * arrive with the quotes still on them.
 */
export function stripSurroundingQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/**
 * Extract the HTTP method from `gh api` args. Defaults to "GET" when neither
 * -X nor --method is supplied. Expects `args` to start with the sub-command
 * ("api"); scans the rest for the flag.
 *
 * Handles all four method-flag shapes gh/Cobra accept:
 *   -X PUT           (separate tokens)
 *   --method PUT     (separate tokens, long form)
 *   -XPUT            (combined short form)
 *   --method=PUT     (equals form)
 *
 * Returns the method uppercased so comparisons are case-insensitive (gh
 * accepts `-X put`; the old case-sensitive comparison was a bypass vector).
 */
export function findGhApiMethod(args: string[]): string {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    // Separate-tokens form: -X VALUE / --method VALUE
    if (arg === "-X" || arg === "--method") {
      return (args[i + 1] ?? "GET").toUpperCase();
    }
    // Equals form: --method=VALUE
    if (arg.startsWith("--method=")) {
      return arg.slice("--method=".length).toUpperCase();
    }
    // Combined short form: -XVALUE (e.g., -XPUT)
    if (arg.startsWith("-X") && arg.length > 2) {
      return arg.slice(2).toUpperCase();
    }
  }
  return "GET";
}

/**
 * Extract the endpoint path from `gh api` args — the first positional argument
 * after flag/value pairs are stripped. Returns the unquoted token, or null if
 * no positional is found.
 *
 * NOTE: This is a first-positional extractor for general use. The PR-merge
 * denial rule does NOT rely on it for enforcement (see
 * findGhApiPrMergeEndpointToken) because quote-splitting by the upstream
 * tokenizer can pull the positional out of alignment. This helper is retained
 * for cases where identifying the first positional in a well-formed
 * invocation is useful.
 */
export function findGhApiEndpoint(args: string[]): string | null {
  let i = 1; // skip "api"
  while (i < args.length) {
    const arg = args[i];
    if (!arg) break;
    if (arg.startsWith("-")) {
      // Value-taking flag with separate value token: -f merge_method=merge
      if (GH_API_VALUE_FLAGS.has(arg)) {
        i += 2;
        continue;
      }
      // Equals-form flag (e.g., --method=PUT): single token, no separate value.
      i += 1;
      continue;
    }
    return stripSurroundingQuotes(arg);
  }
  return null;
}

/**
 * Extract the value of a named `-f KEY=VALUE` / `--field KEY=VALUE` /
 * `--raw-field KEY=VALUE` from `gh api` args. Returns null if the field is
 * not present.
 *
 * Tokens are quote-stripped before matching, so `-f "merge_method=merge"`
 * (where the upstream tokenizer kept the quotes on the token) is still
 * recognized. Without this, a perfectly valid quoted invocation would be
 * treated as if `merge_method` were absent and over-blocked.
 */
export function findGhApiField(args: string[], key: string): string | null {
  const prefix = `${key}=`;
  for (const arg of args) {
    const stripped = stripSurroundingQuotes(arg);
    if (stripped.startsWith(prefix)) {
      return stripped.slice(prefix.length);
    }
  }
  return null;
}

/**
 * Matches `repos/OWNER/REPO/pulls/N/merge` — the PR merge endpoint. Does NOT
 * match `/merges`, `/merge-upstream`, or any sub-resource.
 */
const PR_MERGE_ENDPOINT_RE = /(^|\/)pulls\/\d+\/merge$/;

/**
 * Scan ALL tokens for one that matches the PR-merge endpoint pattern (after
 * unquoting). Returns the matched token (unquoted) or null.
 *
 * This is deliberately broader than findGhApiEndpoint: the policy question
 * ("does this command target a PR-merge endpoint?") does not require
 * perfectly locating which token is the positional. A quoted -f value like
 * `-f commit_title="My PR"` can confuse positional extraction because the
 * upstream tokenizer is not quote-aware and splits `"My PR"` into multiple
 * tokens — but the actual endpoint token is still present somewhere in the
 * arg list, and scanning all tokens finds it.
 *
 * Exported for tests.
 */
export function findGhApiPrMergeEndpointToken(args: string[]): string | null {
  for (const arg of args) {
    const stripped = stripSurroundingQuotes(arg);
    if (PR_MERGE_ENDPOINT_RE.test(stripped)) {
      return stripped;
    }
  }
  return null;
}

/**
 * Check a parsed command against the denial tables, taking the invoking tool
 * context into account. Rules tagged `allowedInSessionExec` are skipped when
 * `context === "session_exec"` — their reasons redirect to session_exec, so
 * applying them on session_exec itself would be self-contradictory.
 *
 * For `git add` specifically, the conflict-resolution carve-out (mt#1806) is
 * applied: if ALL explicitly-named paths are in git's unmerged set, the call
 * is permitted with a stderr audit line. Injectable `runGit` for tests.
 *
 * Returns the denial reason string if denied, or null if allowed.
 */
export function checkDenial(
  parsed: ParsedCommand,
  context: HookTool = "bash",
  runGit: (cmd: string) => string = defaultRunGit
): string | null {
  const denials = parsed.binary === "git" ? gitDenials : ghDenials;
  for (const rule of denials) {
    if (context === "session_exec" && rule.allowedInSessionExec) continue;
    if (rule.match(parsed.args)) {
      // git add conflict-resolution carve-out (mt#1806): permit if every
      // explicitly-named path is in git's unmerged set.
      if (parsed.binary === "git" && parsed.args[0] === "add") {
        if (isConflictResolutionAdd(parsed.args, runGit)) {
          const paths = extractGitAddPaths(parsed.args) ?? [];
          process.stderr.write(
            `[block-git-gh-cli] git-add carve-out for conflict resolution: ${JSON.stringify(paths)}\n`
          );
          return null;
        }
      }
      return rule.reason;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const startMs = Date.now();
  const input = await readInput<ToolHookInput>();
  const command = (input.tool_input.command as string) ?? "";
  const context = toolContextFromName(input.tool_name);

  const parsedCommands = parseCommands(command);

  // mt#2597 (evaluation-loop Phase 1): fire-log this invocation exactly
  // once, regardless of how many parsed sub-commands were checked — "one
  // enforcement point firing" maps to one hook invocation, not one
  // sub-command. No documented override env-var for this guard (denials are
  // absolute — no MINSKY_SKIP_*/MINSKY_ACK_* escape hatch), so no override
  // fields are ever populated here.
  const recordAndExit = (decision: "allow" | "deny"): never => {
    recordFireLogEntry({
      guardName: GUARD_NAME,
      event: "PreToolUse",
      decision,
      // mt#3920: `decided` unconditionally, and only because BOTH exits sit downstream of
      // the check. This guard has no early exit and no fail-open: every invocation parses
      // the command and runs `checkDenial` over each parsed sub-command before it can
      // reach here, and the policy check is pure in-process matching with no probe to
      // break. A future early exit added ABOVE this closure must not route through it.
      guardOutcome: "decided",
      durationMs: Date.now() - startMs,
      toolName: input.tool_name,
      // mt#3381: settle whether `agent_type` reaches a PreToolUse hook in
      // production. Recorded on every fire, allow or deny — a denial that
      // dead-ends a subagent is the case of interest, but the allow path is
      // where most subagent traffic shows up.
      agentType: input.agent_type,
      agentTypeObserved: classifyAgentTypeObservation(input),
      sessionId: input.session_id,
    });
    process.exit(0);
  };

  // mt#3788: a git command standing in a repository Minsky does not manage has
  // no `session_*` equivalent to be redirected to, so the denial protects
  // nothing and only blocks work. Session workspaces and the project checkout
  // itself stay fully enforced; an unresolvable cwd is `indeterminate` and
  // still denies (fail-closed). `session_exec` is never scoped out — its cwd
  // is a session workspace by construction, and `input.cwd` for that tool is
  // the harness shell's directory, not the session's.
  //
  // Applied PER COMMAND, not as an early exit over the whole invocation
  // (PR #2685 R1): only invocations whose target repo IS the cwd may be carved
  // out — see `isCwdScopedInvocation` for why `gh` and path-redirecting git
  // flags never qualify. An early exit would have disabled every gh-policy
  // denial for anyone standing in a scratch directory.
  //
  // The scope is resolved ONCE from the reported cwd, so it only describes
  // where a git command actually runs when nothing in the command relocates
  // first (PR #2685 R2) — hence the `commandMayRelocateCwd` veto.
  //
  // mt#3798: `cd` is the only way to reach a foreign directory from the Bash
  // tool, so vetoing on relocation alone made the carve-out unreachable. When
  // the leading `cd` target is literally resolvable, classify THAT directory;
  // otherwise the veto stands.
  //
  // `classifiedPath` is carried alongside the scope so the audit line can name
  // the directory actually classified. Reporting `input.cwd` there would be
  // wrong exactly when a leading `cd` moved the target — the case this task
  // added (PR #2691 R1).
  const { scope, classifiedPath }: { scope: RepoScope; classifiedPath: string | undefined } = ((): {
    scope: RepoScope;
    classifiedPath: string | undefined;
  } => {
    if (context !== "bash") return { scope: "session", classifiedPath: undefined };
    const cdTarget = resolveLeadingCdTarget(command, input.cwd);
    if (cdTarget !== null) {
      return { scope: classifyRepoScope(cdTarget), classifiedPath: cdTarget };
    }
    if (commandMayRelocateCwd(command)) return { scope: "session", classifiedPath: undefined };
    return { scope: classifyRepoScope(input.cwd), classifiedPath: input.cwd };
  })();

  for (const parsed of parsedCommands) {
    if (scope === "external" && isCwdScopedInvocation(parsed)) {
      process.stderr.write(
        `[block-git-gh-cli] scope carve-out: git ${parsed.args[0] ?? ""} in ${classifiedPath}, outside the Minsky project and its session workspaces\n`
      );
      continue;
    }
    const reason = checkDenial(parsed, context);
    if (reason) {
      // mt#3802: this guard is NOT yet migrated onto the dispatcher (ADR-028
      // Phase 5), so the dispatcher's central deny-branch recording cannot see
      // it — and this is the guard from the originating incident, where four
      // byte-identical `Bash` calls were denied in a row and nothing recorded
      // it. The call lives here until this guard migrates, at which point the
      // dispatcher covers it and this line comes out.
      // mt#4257: the calibration record keeps the BASE reason so records stay
      // groupable by redirect; only the agent-facing text carries the
      // availability escape appended below.
      recordGuardDenial({
        sessionId: input.session_id,
        toolName: input.tool_name,
        guardName: "block-git-gh-cli",
        reason,
        toolInput: input.tool_input,
      });
      writeOutput({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `${reason}${REDIRECT_UNAVAILABLE_ESCAPE}`,
        },
      });
      recordAndExit("deny");
    }
  }

  recordAndExit("allow");
}
