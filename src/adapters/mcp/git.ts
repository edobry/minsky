/**
 * MCP adapter for git commands
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { z } from "zod";

// Import centralized descriptions
import {
  SESSION_DESCRIPTION,
  REPO_DESCRIPTION,
  GIT_BRANCH_DESCRIPTION,
  GIT_REMOTE_DESCRIPTION,
  GIT_FORCE_DESCRIPTION,
  TASK_ID_DESCRIPTION,
  DEBUG_DESCRIPTION,
  NO_STATUS_UPDATE_DESCRIPTION,
} from "../../utils/option-descriptions.js";

// Import domain functions
import {
  createPullRequestFromParams,
  commitChangesFromParams,
  cloneFromParams,
  branchFromParams,
  pushFromParams,
} from "../../domain/index.js";

/**
 * Registers git tools with the MCP command mapper
 */
export function registerGitTools(commandMapper: CommandMapper): void {
  // Git clone command
  commandMapper.addGitCommand(
    "clone",
    "Clone a repository",
    z.object({
      url: z.string().url().describe("URL of the Git repository to clone"),
      session: z.string().optional().describe(SESSION_DESCRIPTION),
      destination: z.string().optional().describe("Target directory for the clone"),
      branch: z.string().optional().describe(GIT_BRANCH_DESCRIPTION),
    }),
    async (_args) => {
      const params = {
        ...args,
      };

      const _result = await cloneFromParams(params);

      return {
        success: true,
        _workdir: result.workdir,
        _session: result.session,
      };
    }
  );

  // Git branch command
  commandMapper.addGitCommand(
    "_branch",
    "Create a _branch in a repository",
    z.object({
      _session: z.string().describe(SESSION_DESCRIPTION),
      name: z.string().describe("Name of the _branch to create"),
    }),
    async (_args) => {
      const params = {
        ...args,
      };

      const _result = await branchFromParams(params);

      return {
        success: true,
        _workdir: result.workdir,
        _branch: result.branch,
      };
    }
  );

  // Git push command
  commandMapper.addGitCommand(
    "push",
    "Push changes to a remote repository",
    z.object({
      _session: z.string().optional().describe(SESSION_DESCRIPTION),
      repo: z.string().optional().describe(REPO_DESCRIPTION),
      remote: z.string().optional().describe(GIT_REMOTE_DESCRIPTION),
      force: z.boolean().optional().describe(GIT_FORCE_DESCRIPTION),
    }),
    async (_args) => {
      const params = {
        ...args,
        debug: true, // Enable debugging for MCP commands
      };

      const _result = await pushFromParams(params);

      return {
        success: true,
        _workdir: result.workdir,
        pushed: result.pushed,
      };
    }
  );

  // Git PR command
  commandMapper.addGitCommand(
    "pr",
    "Create a pull request",
    z.object({
      _session: z.string().optional().describe(SESSION_DESCRIPTION),
      repo: z.string().optional().describe(REPO_DESCRIPTION),
      branch: z.string().optional().describe(GIT_BRANCH_DESCRIPTION),
      task: z.string().optional().describe(TASK_ID_DESCRIPTION),
      debug: z.boolean().optional().describe(DEBUG_DESCRIPTION),
      noStatusUpdate: z.boolean().optional().describe(NO_STATUS_UPDATE_DESCRIPTION),
    }),
    async (_args) => {
      const params = {
        ...args,
        taskId: args.task, // Map task parameter to taskId for domain function
        json: true, // Always use JSON format for MCP
      };

      const _result = await createPullRequestFromParams(params);

      return {
        success: true,
        markdown: result.markdown,
        statusUpdateResult: result.statusUpdateResult,
      };
    }
  );

  // Git commit command
  commandMapper.addGitCommand(
    "commit",
    "Commit changes",
    z.object({
      message: z.string().describe("Commit message"),
      session: z.string().optional().describe(SESSION_DESCRIPTION),
      repo: z.string().optional().describe(REPO_DESCRIPTION),
      amend: z.boolean().optional().describe("Amend the previous commit"),
      all: z.boolean().optional().describe("Stage all changes"),
      noStage: z.boolean().optional().describe("Skip staging changes"),
    }),
    async (_args) => {
      const params = {
        ...args,
      };

      const commitSha = await commitChangesFromParams(params);

      return {
        success: true,
        message: `Changes committed successfully: ${commitSha}`,
        commitSha,
      };
    }
  );
}
