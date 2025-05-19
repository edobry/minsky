/**
 * MCP adapter for git commands
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { z } from "zod";

// Import domain functions
import { 
  createPullRequestFromParams, 
  commitChangesFromParams,
  cloneFromParams,
  branchFromParams,
  pushFromParams 
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
      session: z.string().optional().describe("Session identifier for the clone"),
      destination: z.string().optional().describe("Target directory for the clone"),
      branch: z.string().optional().describe("Branch to checkout after cloning"),
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
      };
    }
  );

  // Git branch command
  commandMapper.addGitCommand(
    "branch",
    "Create a branch in a repository",
    z.object({
      session: z.string().describe("Session to create branch in"),
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
      };
    }
  );

  // Git push command
  commandMapper.addGitCommand(
    "push",
    "Push changes to a remote repository",
    z.object({
      session: z.string().optional().describe("Session to push changes for"),
      repo: z.string().optional().describe("Path to the repository"),
      remote: z.string().optional().describe("Remote to push to (defaults to origin)"),
      force: z.boolean().optional().describe("Force push (use with caution)"),
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
      };
    }
  );

  // Git PR command
  commandMapper.addGitCommand(
    "pr",
    "Create a pull request",
    z.object({
      session: z.string().optional().describe("Session to create PR from"),
      repo: z.string().optional().describe("Path to the repository"),
      branch: z.string().optional().describe("Branch to create PR for"),
      taskId: z.string().optional().describe("Task ID associated with this PR"),
      debug: z.boolean().optional().describe("Enable debug logging"),
      noStatusUpdate: z.boolean().optional().describe("Skip updating task status"),
    }),
    async (args) => {
      const params = {
        ...args,
        json: true, // Always use JSON format for MCP
      };

      const result = await createPullRequestFromParams(params);

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
      session: z.string().optional().describe("Session to commit changes for"),
      repo: z.string().optional().describe("Path to the repository"),
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
