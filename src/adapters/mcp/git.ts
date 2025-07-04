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
    async (args) => {
      const params = {
        ...args,
      };

      const result = await cloneFromParams(params);

      return {
        success: true,
        workdir: result.workdir,
        session: result.session,
      } as any;
    }
  );

  // Git branch command
  commandMapper.addGitCommand(
    "branch",
    "Create a branch in a repository",
    z.object({
      session: z.string().describe(SESSION_DESCRIPTION),
      name: z.string().describe("Name of the branch to create"),
    }),
    async (args) => {
      const params = {
        ...args,
      };

      const result = await branchFromParams(params);

      return {
        success: true,
        workdir: result.workdir,
        branch: result.branch,
      } as any;
    }
  );

  // Git push command
  commandMapper.addGitCommand(
    "push",
    "Push changes to a remote repository",
    z.object({
      session: z.string().optional().describe(SESSION_DESCRIPTION),
      repo: z.string().optional().describe(REPO_DESCRIPTION),
      remote: z.string().optional().describe(GIT_REMOTE_DESCRIPTION),
      force: z.boolean().optional().describe(GIT_FORCE_DESCRIPTION),
    }),
    async (args) => {
      const params = {
        ...args,
        debug: true, // Enable debugging for MCP commands
      };

      const result = await pushFromParams(params);

      return {
        success: true,
        workdir: result.workdir,
        pushed: result.pushed,
      } as any;
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
    async (args) => {
      const params = {
        ...args,
        taskId: args.task, // Map task parameter to taskId for domain function
        json: true, // Always use JSON format for MCP
      };

      const result = await createPullRequestFromParams(params);

      return {
        success: true,
        markdown: result.markdown,
        statusUpdateResult: result.statusUpdateResult,
      } as any;
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
    async (args) => {
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
