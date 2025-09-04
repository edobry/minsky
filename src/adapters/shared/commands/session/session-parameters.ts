/**
 * Session Command Parameters
 *
 * Consolidated parameter definitions for all session commands.
 * Extracted from session.ts as part of modularization effort.
 */
import { z } from "zod";

/**
 * Common parameter building blocks for session commands
 */
export const commonSessionParams = {
  name: {
    schema: z.string(),
    description: "Session name",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
  force: {
    schema: z.boolean(),
    description: "Force the operation",
    required: false,
    defaultValue: false,
  },
  debug: {
    schema: z.boolean(),
    description: "Enable debug output",
    required: false,
    defaultValue: false,
  },
  quiet: {
    schema: z.boolean(),
    description: "Suppress output",
    required: false,
    defaultValue: false,
  },
  noStash: {
    schema: z.boolean(),
    description: "Skip stashing changes",
    required: false,
    defaultValue: false,
  },
  noPush: {
    schema: z.boolean(),
    description: "Skip pushing changes",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session list command parameters
 */
export const sessionListCommandParams = {
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  since: {
    schema: z.string(),
    description: "Only include sessions created on/after this time (YYYY-MM-DD or 7d/24h/30m)",
    required: false,
  },
  until: {
    schema: z.string(),
    description: "Only include sessions created on/before this time (YYYY-MM-DD or 7d/24h/30m)",
    required: false,
  },
};

/**
 * Session get command parameters
 */
export const sessionGetCommandParams = {
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  since: {
    schema: z.string(),
    description: "Only match if session created on/after this time (YYYY-MM-DD or 7d/24h/30m)",
    required: false,
  },
  until: {
    schema: z.string(),
    description: "Only match if session created on/before this time (YYYY-MM-DD or 7d/24h/30m)",
    required: false,
  },
};

/**
 * Session start command parameters
 */
export const sessionStartCommandParams = {
  name: {
    schema: z.string(),
    description: "Session name",
    required: false,
  },
  task: commonSessionParams.task,
  description: {
    schema: z.string(),
    description: "Task description for auto-creation",
    required: false,
  },
  branch: {
    schema: z.string(),
    description: "Git branch to use",
    required: false,
  },
  repo: commonSessionParams.repo,
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
  json: commonSessionParams.json,
  quiet: commonSessionParams.quiet,
  noStatusUpdate: {
    schema: z.boolean(),
    description: "Skip updating task status",
    required: false,
    defaultValue: false,
  },
  skipInstall: {
    schema: z.boolean(),
    description: "Skip dependency installation",
    required: false,
    defaultValue: false,
  },
  packageManager: {
    schema: z.enum(["npm", "yarn", "pnpm", "bun"]),
    description: "Package manager to use",
    required: false,
  },
};

/**
 * Session directory command parameters
 */
export const sessionDirCommandParams = {
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
};

/**
 * Session delete command parameters
 */
export const sessionDeleteCommandParams = {
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  force: commonSessionParams.force,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
};

/**
 * Session update command parameters
 */
export const sessionUpdateCommandParams = {
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  branch: {
    schema: z.string(),
    description: "Branch to update from",
    required: false,
  },
  noStash: commonSessionParams.noStash,
  noPush: commonSessionParams.noPush,
  force: commonSessionParams.force,
  json: commonSessionParams.json,
  skipConflictCheck: {
    schema: z.boolean(),
    description: "Skip conflict detection",
    required: false,
    defaultValue: false,
  },
  autoResolveDeleteConflicts: {
    schema: z.boolean(),
    description: "Automatically resolve delete conflicts",
    required: false,
    defaultValue: false,
  },
  dryRun: {
    schema: z.boolean(),
    description: "Preview changes without applying",
    required: false,
    defaultValue: false,
  },
  skipIfAlreadyMerged: {
    schema: z.boolean(),
    description: "Skip if changes already merged",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session approve command parameters
 */
export const sessionApproveCommandParams = {
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  skipCleanup: {
    schema: z.boolean(),
    description: "Skip session cleanup after merge (preserves session files)",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session PR command parameters
 */
export const sessionPrCommandParams = {
  title: {
    schema: z.string(),
    description: "PR title",
    required: false,
  },
  body: {
    schema: z.string(),
    description: "PR body content",
    required: false,
  },
  bodyPath: {
    schema: z.string(),
    description: "Path to file containing PR body",
    required: false,
  },
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  noStatusUpdate: {
    schema: z.boolean(),
    description: "Skip updating task status",
    required: false,
    defaultValue: false,
  },
  debug: commonSessionParams.debug,

  autoResolveDeleteConflicts: {
    schema: z.boolean(),
    description: "Automatically resolve delete conflicts",
    required: false,
    defaultValue: false,
  },
  skipConflictCheck: {
    schema: z.boolean(),
    description: "Skip conflict detection",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session migrate-backend command parameters
 */
export const sessionMigrateBackendCommandParams = {
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  dryRun: {
    schema: z.boolean(),
    description: "Preview changes without updating the session DB",
    required: false,
    defaultValue: false,
  },
  to: {
    schema: z.enum(["github", "local"]).default("github"),
    description: "Target backend to migrate to (default: github)",
    required: false,
    defaultValue: "github",
  },
  updateRemote: {
    schema: z.boolean(),
    description: "Also update the session workspace git remotes (default: true)",
    required: false,
    defaultValue: true,
  },
};

/**
 * Session inspect command parameters
 */
export const sessionInspectCommandParams = {
  json: commonSessionParams.json,
};

/**
 * Session PR Create command parameters
 * Replaces the current session PR command
 */
export const sessionPrCreateCommandParams = {
  title: {
    schema: z.string().refine((t) => !/^(?:[a-z]+)(?:\([^)]*\))?:\s*/i.test(t), {
      message:
        "Title should be description only. Do not include conventional prefix like 'feat:' or 'feat(scope):'",
    }),
    description: "PR title (description only when --type is provided)",
    required: true,
  },
  type: {
    schema: z.enum(["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore"]),
    description: "Conventional commit type to generate title prefix",
    required: true,
  },
  body: {
    schema: z.string(),
    description: "PR body content",
    required: false,
  },
  bodyPath: {
    schema: z.string(),
    description: "Path to file containing PR body",
    required: false,
  },
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  noStatusUpdate: {
    schema: z.boolean(),
    description: "Skip updating task status",
    required: false,
    defaultValue: false,
  },
  debug: commonSessionParams.debug,

  autoResolveDeleteConflicts: {
    schema: z.boolean(),
    description: "Automatically resolve delete conflicts",
    required: false,
    defaultValue: false,
  },
  skipConflictCheck: {
    schema: z.boolean(),
    description: "Skip conflict detection",
    required: false,
    defaultValue: false,
  },
  draft: {
    schema: z.boolean(),
    description: "Create draft PR (GitHub only, skips session update)",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session PR Edit Command Parameters
 * For editing existing PRs - all fields are optional
 */
export const sessionPrEditCommandParams = {
  title: {
    schema: z.string(),
    description:
      "PR title (to update). With --type, pass description-only; otherwise pass full conventional title",
    required: false,
  },
  type: {
    schema: z.enum(["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore"]),
    description: "Conventional commit type to generate prefix when editing (optional)",
    required: false,
  },
  body: {
    schema: z.string(),
    description: "PR body content (to update)",
    required: false,
  },
  bodyPath: {
    schema: z.string(),
    description: "Path to file containing PR body (to update)",
    required: false,
  },
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  debug: commonSessionParams.debug,
};

/**
 * Session PR List command parameters
 * Lists all PRs associated with sessions
 */
export const sessionPrListCommandParams = {
  session: {
    schema: z.string(),
    description: "Filter PRs by specific session name",
    required: false,
  },
  task: commonSessionParams.task,
  status: {
    schema: z.string().refine(
      (value) => {
        const validStatuses = [
          "open",
          "closed",
          "merged",
          "draft",
          "created",
          "unknown",
          "not_found",
          "all",
        ];
        if (value === "all") return true;
        const parts = value.split(",").map((s) => s.trim().toLowerCase());
        return parts.every((part) => validStatuses.includes(part));
      },
      {
        message:
          "Invalid status. Valid options: open, closed, merged, draft, created, unknown, not_found, all (or comma-separated combinations like 'open,draft')",
      }
    ),
    description:
      "Filter by PR status. Valid options: open, closed, merged, draft, created, unknown, not_found, all (or comma-separated combinations)",
    required: false,
  },
  backend: {
    schema: z.enum(["github", "remote", "local"]),
    description: "Filter by repository backend type",
    required: false,
  },
  since: {
    schema: z.string(),
    description:
      "Only include PRs updated on/after this time (YYYY-MM-DD or relative like 7d, 24h)",
    required: false,
  },
  until: {
    schema: z.string(),
    description:
      "Only include PRs updated on/before this time (YYYY-MM-DD or relative like 7d, 24h)",
    required: false,
  },
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  verbose: {
    schema: z.boolean(),
    description: "Show detailed PR information",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session PR Get command parameters
 * Gets detailed information about a specific PR
 */
export const sessionPrGetCommandParams = {
  sessionName: {
    schema: z.string(),
    description: "Session name to look up PR for (positional)",
    required: false,
  },
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  backend: {
    schema: z.enum(["github", "remote", "local"]),
    description: "Restrict to a specific repository backend type",
    required: false,
  },
  status: {
    schema: z.string().refine(
      (value) => {
        const validStatuses = [
          "open",
          "closed",
          "merged",
          "draft",
          "created",
          "unknown",
          "not_found",
          "all",
        ];
        if (value === "all") return true;
        const parts = value.split(",").map((s) => s.trim().toLowerCase());
        return parts.every((part) => validStatuses.includes(part));
      },
      {
        message:
          "Invalid status. Valid options: open, closed, merged, draft, created, unknown, not_found, all (or comma-separated combinations like 'open,draft')",
      }
    ),
    description:
      "Optional state constraint for the matched PR: open, closed, merged, draft, created, all (or comma-separated combinations)",
    required: false,
  },
  since: {
    schema: z.string(),
    description: "Only match if PR was updated on/after this time (YYYY-MM-DD or 7d/24h)",
    required: false,
  },
  until: {
    schema: z.string(),
    description: "Only match if PR was updated on/before this time (YYYY-MM-DD or 7d/24h)",
    required: false,
  },
  content: {
    schema: z.boolean(),
    description: "Include PR description and diff content",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session PR Open command parameters
 * Opens the pull request in the default web browser
 */
export const sessionPrOpenCommandParams = {
  sessionName: {
    schema: z.string(),
    description: "Session name to open PR for (positional)",
    required: false,
  },
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
};

/**
 * Session repair command parameters
 * Repairs various session state issues
 */
export const sessionRepairCommandParams = {
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  debug: commonSessionParams.debug,
  dryRun: {
    schema: z.boolean(),
    description: "Preview repairs without applying changes",
    required: false,
    defaultValue: false,
  },
  auto: {
    schema: z.boolean(),
    description: "Automatically apply safe repairs without confirmation",
    required: false,
    defaultValue: false,
  },
  interactive: {
    schema: z.boolean(),
    description: "Interactive repair mode with confirmations",
    required: false,
    defaultValue: false,
  },
  prState: {
    schema: z.boolean(),
    description: "Focus on PR state issues (branch format, stale state)",
    required: false,
    defaultValue: false,
  },
  backendSync: {
    schema: z.boolean(),
    description: "Sync session record with actual repository backend",
    required: false,
    defaultValue: false,
  },
  force: commonSessionParams.force,
};

/**
 * Session edit-file command parameters
 * CLI wrapper for session.edit_file MCP tool
 */
export const sessionEditFileCommandParams = {
  session: {
    schema: z.string(),
    description: "Session name (auto-detected from workspace if not provided)",
    required: false,
  },
  path: {
    schema: z.string(),
    description: "Path to the file within the session workspace",
    required: true,
  },
  instruction: {
    schema: z.string(),
    description: "Optional high-level instruction guiding how to apply the edit",
    required: false,
  },
  patternFile: {
    schema: z.string(),
    description: "Path to file containing edit pattern (alternative to stdin)",
    required: false,
  },
  dryRun: {
    schema: z.boolean(),
    description: "Preview changes without writing to disk",
    required: false,
    defaultValue: false,
  },
  createDirs: {
    schema: z.boolean(),
    description: "Create parent directories if they don't exist",
    required: false,
    defaultValue: true,
  },
  json: commonSessionParams.json,
  debug: commonSessionParams.debug,
};

/**
 * Session review command parameters
 */
export const sessionReviewCommandParams = {
  session: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  output: {
    schema: z.string(),
    description: "Output format (json, text)",
    required: false,
  },
  prBranch: {
    schema: z.string(),
    description: "PR branch name (defaults to pr/<session-name>)",
    required: false,
  },
};
