/**
 * Shared Git Commands
 *
 * This module contains shared git command implementations that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandParameterMap,
} from "../command-registry";
// Domain git functions are lazy-imported inside execute handlers to avoid
// loading the entire domain layer at command registration time.
import { conflictsCommandParams } from "../../../domain/git/commands/subcommands/conflicts-subcommand";
import { log } from "../../../utils/logger";
import { SESSION_DESCRIPTION } from "../../../utils/option-descriptions";
import { CommonParameters, GitParameters, composeParams } from "../common-parameters";
import { execAsync } from "../../../utils/exec";
import type { AppContainerInterface } from "../../../composition/types";

/**
 * Parameters for the commit command
 */
const commitCommandParams = composeParams(
  {
    repo: CommonParameters.repo,
    session: CommonParameters.session,
  },
  {
    message: {
      schema: z.string().min(1),
      description: "Commit message",
      required: true,
    },
    all: {
      schema: z.boolean(),
      description: "Stage all changes including deletions",
      required: false,
      defaultValue: false,
    },
    amend: {
      schema: z.boolean(),
      description: "Amend the previous commit",
      required: false,
      defaultValue: false,
    },
    noStage: {
      schema: z.boolean(),
      description: "Skip staging changes",
      required: false,
      defaultValue: false,
    },
  }
) satisfies CommandParameterMap;

/**
 * Parameters for the push command
 */
const pushCommandParams = composeParams(
  {
    repo: CommonParameters.repo,
    session: CommonParameters.session,
    force: CommonParameters.force,
    debug: CommonParameters.debug,
  },
  {
    remote: GitParameters.remote,
  }
) satisfies CommandParameterMap;

/**
 * Parameters for the clone command
 */
const cloneCommandParams = composeParams(
  {
    session: CommonParameters.session,
    branch: GitParameters.branch,
  },
  {
    url: {
      schema: z.string().url(),
      description: "URL of the Git repository to clone",
      required: true,
    },
    destination: {
      schema: z.string(),
      description: "Target directory for the clone",
      required: false,
    },
  }
) satisfies CommandParameterMap;

/**
 * Parameters for the branch command
 */
const branchCommandParams = composeParams(
  {
    preview: GitParameters.preview,
    autoResolve: GitParameters.autoResolve,
  },
  {
    session: {
      schema: z.string(),
      description: SESSION_DESCRIPTION,
      required: true,
    },
    name: {
      schema: z.string(),
      description: "Name of the branch to create",
      required: true,
    },
  }
) satisfies CommandParameterMap;

/**
 * Parameters for the merge command
 */
const mergeCommandParams = composeParams(
  {
    session: CommonParameters.session,
    repo: CommonParameters.repo,
    preview: GitParameters.preview,
    autoResolve: GitParameters.autoResolve,
  },
  {
    branch: {
      schema: z.string().min(1),
      description: "Branch to merge",
      required: true,
    },
    conflictStrategy: {
      schema: z.enum(["automatic", "guided", "manual"]),
      description: "Choose conflict resolution strategy",
      required: false,
    },
  }
) satisfies CommandParameterMap;

/**
 * NEW: Parameters for the checkout command
 */
const checkoutCommandParams = composeParams(
  {
    session: CommonParameters.session,
    repo: CommonParameters.repo,
    force: CommonParameters.force,
    preview: GitParameters.preview,
  },
  {
    branch: {
      schema: z.string(),
      description: "Branch to checkout",
      required: true,
    },
    autoStash: {
      schema: z.boolean(),
      description: "Automatically stash uncommitted changes before checkout",
      required: false,
      defaultValue: false,
    },
  }
) satisfies CommandParameterMap;

/**
 * NEW: Parameters for the rebase command
 */
const rebaseCommandParams = composeParams(
  {
    session: CommonParameters.session,
    repo: CommonParameters.repo,
    preview: GitParameters.preview,
    autoResolve: GitParameters.autoResolve,
  },
  {
    baseBranch: {
      schema: z.string(),
      description: "Base branch to rebase onto",
      required: true,
    },
    conflictStrategy: {
      schema: z.enum(["automatic", "guided", "manual"]),
      description: "Choose conflict resolution strategy",
      required: false,
    },
  }
) satisfies CommandParameterMap;

/**
 * Parameters for the git log command
 */
const logCommandParams = composeParams(
  {
    repo: CommonParameters.repo,
  },
  {
    limit: {
      schema: z.number(),
      description: "Maximum number of commits to show",
      required: false,
      defaultValue: 20,
    },
    author: {
      schema: z.string(),
      description: "Filter commits by author name or email",
      required: false,
    },
    since: {
      schema: z.string(),
      description:
        "Show commits more recent than a specific date (e.g. '2024-01-01', '1 week ago')",
      required: false,
    },
    until: {
      schema: z.string(),
      description: "Show commits older than a specific date",
      required: false,
    },
    path: {
      schema: z.string(),
      description: "Filter commits that affect the specified file path",
      required: false,
    },
    grep: {
      schema: z.string(),
      description: "Filter commits by message text",
      required: false,
    },
    format: {
      schema: z.enum(["oneline", "short", "medium", "full"]),
      description: "Output format: oneline, short, medium, or full",
      required: false,
      defaultValue: "oneline",
    },
    ref: {
      schema: z.string(),
      description: "Branch, tag, or ref to start log from",
      required: false,
    },
  }
) satisfies CommandParameterMap;

/**
 * Parameters for the git search command
 */
const searchCommandParams = composeParams(
  {
    repo: CommonParameters.repo,
  },
  {
    pattern: {
      schema: z.string().min(1),
      description: "Search pattern",
      required: true,
    },
    type: {
      schema: z.enum(["content", "commits", "diff"]),
      description:
        "Search type: content (git grep), commits (git log -S pickaxe), or diff (git log -p with grep)",
      required: false,
      defaultValue: "content",
    },
    path: {
      schema: z.string(),
      description: "Restrict search to a specific file path or directory",
      required: false,
    },
    ref: {
      schema: z.string(),
      description: "Search at a specific ref (default HEAD for content search)",
      required: false,
    },
    limit: {
      schema: z.number(),
      description: "Maximum number of results to return",
      required: false,
      defaultValue: 20,
    },
    ignoreCase: {
      schema: z.boolean(),
      description: "Perform case-insensitive search",
      required: false,
      defaultValue: false,
    },
  }
) satisfies CommandParameterMap;

/**
 * Parameters for the git diff command
 */
const diffCommandParams = composeParams(
  {
    repo: CommonParameters.repo,
  },
  {
    from: {
      schema: z.string(),
      description: "Starting ref (commit, branch, tag). If omitted, shows unstaged changes",
      required: false,
    },
    to: {
      schema: z.string(),
      description: "Ending ref. If omitted with from, diffs from against working tree",
      required: false,
    },
    path: {
      schema: z.string(),
      description: "Restrict diff to a specific file or directory",
      required: false,
    },
    stat: {
      schema: z.boolean(),
      description: "Show diffstat summary only (--stat)",
      required: false,
      defaultValue: false,
    },
    nameOnly: {
      schema: z.boolean(),
      description: "Show only changed file names (--name-only)",
      required: false,
      defaultValue: false,
    },
  }
) satisfies CommandParameterMap;

/**
 * Parameters for the git blame command
 */
const blameCommandParams = composeParams(
  {
    repo: CommonParameters.repo,
  },
  {
    path: {
      schema: z.string().min(1),
      description: "File to blame",
      required: true,
    },
    ref: {
      schema: z.string(),
      description: "Blame at specific ref (default HEAD)",
      required: false,
    },
    startLine: {
      schema: z.number(),
      description: "Start of line range",
      required: false,
    },
    endLine: {
      schema: z.number(),
      description: "End of line range",
      required: false,
    },
  }
) satisfies CommandParameterMap;

/**
 * Helper to resolve session to repo path at the adapter boundary.
 * Uses the container's sessionProvider if available.
 */
async function resolveSessionToRepo(
  session: string | undefined,
  repo: string | undefined,
  container?: AppContainerInterface
): Promise<string | undefined> {
  if (session && !repo && container?.has("sessionProvider")) {
    const sessionProvider = container.get("sessionProvider");
    return await sessionProvider.getSessionWorkdir(session);
  }
  return repo;
}

/**
 * Register the git commands in the shared command registry
 */
export function registerGitCommands(container?: AppContainerInterface): void {
  // Register git commit command
  sharedCommandRegistry.registerCommand({
    id: "git.commit",
    category: CommandCategory.GIT,
    name: "commit",
    description: "Commit changes to the repository",
    parameters: commitCommandParams,
    execute: async (params, context) => {
      log.debug("Executing git.commit command", { params });
      const { commitChangesFromParams } = await import("../../../domain/git");

      const repo = await resolveSessionToRepo(params.session, params.repo, container);

      const result = await commitChangesFromParams({
        message: params.message,
        all: params.all,
        amend: params.amend,
        noStage: params.noStage,
        repo,
      });

      return {
        success: true,
        commitHash: result.commitHash,
        message: result.message,
      };
    },
  });

  // Register git push command
  sharedCommandRegistry.registerCommand({
    id: "git.push",
    category: CommandCategory.GIT,
    name: "push",
    description: "Push changes to the remote repository",
    parameters: pushCommandParams,
    execute: async (params, context) => {
      log.debug("Executing git.push command", { params });
      const { pushFromParams } = await import("../../../domain/git");

      const repo = await resolveSessionToRepo(params.session, params.repo, container);

      const result = await pushFromParams({
        repo,
        remote: params.remote,
        force: params.force,
        debug: params.debug,
      });

      return {
        success: result.pushed,
        workdir: result.workdir,
      };
    },
  });

  // Register git clone command
  sharedCommandRegistry.registerCommand({
    id: "git.clone",
    category: CommandCategory.GIT,
    name: "clone",
    description: "Clone a Git repository",
    parameters: cloneCommandParams,
    execute: async (params, context) => {
      log.debug("Executing git.clone command", { params });
      const { cloneFromParams } = await import("../../../domain/git");

      const result = await cloneFromParams({
        url: params.url,
        workdir: params.destination || ".",
        session: params.session,
        branch: params.branch,
      });

      return {
        success: true,
        workdir: result.workdir,
        session: result.session,
      };
    },
  });

  // Register git branch command
  sharedCommandRegistry.registerCommand({
    id: "git.branch",
    category: CommandCategory.GIT,
    name: "branch",
    description: "Create a new branch",
    parameters: branchCommandParams,
    execute: async (params, context) => {
      log.debug("Executing git.branch command", { params });
      const { branchFromParams } = await import("../../../domain/git");

      const result = await branchFromParams({
        session: params.session,
        name: params.name,
      });

      return {
        success: true,
        workdir: result.workdir,
        branch: result.branch,
      };
    },
  });

  // Register git merge command
  sharedCommandRegistry.registerCommand({
    id: "git.merge",
    category: CommandCategory.GIT,
    name: "merge",
    description: "Merge a branch with conflict detection",
    parameters: mergeCommandParams,
    execute: async (params, context) => {
      log.debug("Executing git.merge command", { params });
      const { mergeFromParams } = await import("../../../domain/git");

      const repo = await resolveSessionToRepo(params.session, params.repo, container);

      const result = await mergeFromParams({
        sourceBranch: params.branch,
        repo,
        preview: params.preview,
        autoResolve: params.autoResolve,
        conflictStrategy: params.conflictStrategy,
      });

      return {
        success: result.merged,
        workdir: result.workdir,
        message: result.conflicts
          ? result.conflictDetails || "Merge completed with conflicts"
          : "Merge completed successfully",
      };
    },
  });

  // Register git checkout command
  sharedCommandRegistry.registerCommand({
    id: "git.checkout",
    category: CommandCategory.GIT,
    name: "checkout",
    description: "Checkout a branch with conflict detection",
    parameters: checkoutCommandParams,
    execute: async (params, context) => {
      log.debug("Executing git.checkout command", { params });
      const { checkoutFromParams } = await import("../../../domain/git");

      const repo = await resolveSessionToRepo(params.session, params.repo, container);

      const result = await checkoutFromParams({
        branch: params.branch,
        repo,
        preview: params.preview,
        autoResolve: params.autoStash,
      });

      return {
        success: result.switched,
        workdir: result.workdir,
        message: result.conflicts
          ? result.conflictDetails || "Checkout completed with warnings"
          : "Checkout completed successfully",
      };
    },
  });

  // Register git rebase command
  sharedCommandRegistry.registerCommand({
    id: "git.rebase",
    category: CommandCategory.GIT,
    name: "rebase",
    description: "Rebase with conflict detection",
    parameters: rebaseCommandParams,
    execute: async (params, context) => {
      log.debug("Executing git.rebase command", { params });
      const { rebaseFromParams } = await import("../../../domain/git");

      const repo = await resolveSessionToRepo(params.session, params.repo, container);

      const result = await rebaseFromParams({
        baseBranch: params.baseBranch,
        repo,
        preview: params.preview,
        autoResolve: params.autoResolve,
        conflictStrategy: params.conflictStrategy,
      });

      return {
        success: result.rebased,
        workdir: result.workdir,
        message: result.conflicts
          ? result.conflictDetails || "Rebase completed with conflicts"
          : "Rebase completed successfully",
      };
    },
  });

  // Register git conflicts command
  sharedCommandRegistry.registerCommand({
    id: "git.conflicts",
    category: CommandCategory.GIT,
    name: "conflicts",
    description: "Detect and report merge conflicts in structured format",
    parameters: conflictsCommandParams,
    execute: async (params, context) => {
      log.debug("Executing git.conflicts command", { params });
      const { conflictsFromParams } = await import(
        "../../../domain/git/commands/subcommands/conflicts-subcommand"
      );

      const result = await conflictsFromParams({
        format: params.format,
        context: params.context,
        files: params.files,
      });

      if (!result.success) {
        throw new Error(result.error || "Failed to scan for conflicts");
      }

      return {
        success: true,
        data: result.data,
      };
    },
  });

  // Register git log command
  sharedCommandRegistry.registerCommand({
    id: "git.log",
    category: CommandCategory.GIT,
    name: "log",
    description: "View commit history with optional filtering",
    parameters: logCommandParams,
    execute: async (params, _context) => {
      log.debug("Executing git.log command", { params });

      const repoPath = params.repo || process.cwd();
      const limit = params.limit ?? 20;
      const format = params.format ?? "oneline";

      const args: string[] = ["git", "-C", repoPath, "log"];

      // Format flag
      if (format === "oneline") {
        args.push("--oneline");
      } else {
        args.push(`--format=${format}`);
      }

      // Limit
      args.push(`-n`, String(limit));

      // Optional filters
      if (params.author) {
        args.push(`--author=${params.author}`);
      }
      if (params.since) {
        args.push(`--since=${params.since}`);
      }
      if (params.until) {
        args.push(`--until=${params.until}`);
      }
      if (params.grep) {
        args.push(`--grep=${params.grep}`);
      }
      if (params.ref) {
        args.push(params.ref);
      }
      if (params.path) {
        args.push("--", params.path);
      }

      try {
        const { stdout } = await execAsync(args.join(" "));
        return {
          success: true,
          output: stdout.trim(),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  // Register git search command
  sharedCommandRegistry.registerCommand({
    id: "git.search",
    category: CommandCategory.GIT,
    name: "search",
    description: "Search repository content, commits, or diffs",
    parameters: searchCommandParams,
    execute: async (params, _context) => {
      log.debug("Executing git.search command", { params });

      const repoPath = params.repo || process.cwd();
      const pattern = params.pattern;
      const type = params.type ?? "content";
      const limit = params.limit ?? 20;
      const ignoreCase = params.ignoreCase ?? false;

      try {
        let command: string;

        if (type === "content") {
          const args: string[] = ["git", "-C", repoPath, "grep"];
          if (ignoreCase) args.push("-i");
          args.push("-n");
          args.push(pattern);
          if (params.ref) args.push(params.ref);
          if (params.path) args.push("--", params.path);
          command = args.join(" ");
        } else if (type === "commits") {
          // Pickaxe search: find commits that added/removed the pattern
          const args: string[] = ["git", "-C", repoPath, "log"];
          args.push(`-n`, String(limit));
          args.push("--oneline");
          if (ignoreCase) args.push("-i");
          args.push(`-S${pattern}`);
          if (params.ref) args.push(params.ref);
          if (params.path) args.push("--", params.path);
          command = args.join(" ");
        } else {
          // type === "diff": search in diffs
          const args: string[] = ["git", "-C", repoPath, "log"];
          args.push(`-n`, String(limit));
          args.push("--oneline");
          args.push("-p");
          if (ignoreCase) args.push("-i");
          args.push(`-G${pattern}`);
          if (params.ref) args.push(params.ref);
          if (params.path) args.push("--", params.path);
          command = args.join(" ");
        }

        const { stdout } = await execAsync(command);
        return {
          success: true,
          output: stdout.trim(),
        };
      } catch (error) {
        // git grep exits with code 1 when no matches found — treat as success with empty output
        if (error instanceof Error && error.message.includes("exit code 1")) {
          return { success: true, output: "" };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  // Register git diff command
  sharedCommandRegistry.registerCommand({
    id: "git.diff",
    category: CommandCategory.GIT,
    name: "diff",
    description: "Show diff between refs, or unstaged changes",
    parameters: diffCommandParams,
    execute: async (params, _context) => {
      log.debug("Executing git.diff command", { params });

      const repoPath = params.repo || process.cwd();
      const from = params.from;
      const to = params.to;
      const path = params.path;
      const stat = params.stat ?? false;
      const nameOnly = params.nameOnly ?? false;

      const args: string[] = ["git", "-C", repoPath, "diff"];

      // Output format flags
      if (stat) {
        args.push("--stat");
      } else if (nameOnly) {
        args.push("--name-only");
      }

      // Ref range
      if (from && to) {
        args.push(`${from}..${to}`);
      } else if (from) {
        args.push(from);
      }
      // No from/to: show unstaged changes (plain `git diff`)

      // Path restriction
      if (path) {
        args.push("--", path);
      }

      try {
        const { stdout } = await execAsync(args.join(" "));
        return {
          success: true,
          output: stdout.trim(),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  // Register git blame command
  sharedCommandRegistry.registerCommand({
    id: "git.blame",
    category: CommandCategory.GIT,
    name: "blame",
    description: "Show what revision and author last modified each line of a file",
    parameters: blameCommandParams,
    execute: async (params, _context) => {
      log.debug("Executing git.blame command", { params });

      const repoPath = params.repo || process.cwd();
      const filePath = params.path;
      const ref = params.ref;
      const startLine = params.startLine;
      const endLine = params.endLine;

      const args: string[] = ["git", "-C", repoPath, "blame"];

      // Line range
      if (startLine !== undefined && endLine !== undefined) {
        args.push(`-L`, `${startLine},${endLine}`);
      } else if (startLine !== undefined) {
        args.push(`-L`, `${startLine},${startLine}`);
      }

      // Ref (must come before -- path)
      if (ref) {
        args.push(ref);
      }

      // Always use -- to separate path from ref
      args.push("--", filePath);

      try {
        const { stdout } = await execAsync(args.join(" "));
        return {
          success: true,
          output: stdout.trim(),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
