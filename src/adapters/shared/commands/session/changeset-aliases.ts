/**
 * Session Changeset Aliases
 *
 * Provides session-specific aliases for changeset commands that delegate
 * to the repository changeset abstraction layer with session context.
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
} from "../../command-registry";
import { CommonParameters, composeParams } from "../../common-parameters";
import { getCurrentSession } from "../../../../domain/workspace";
import { resolveRepositoryAndBackend } from "../../../../domain/session/repository-backend-detection";
import { createChangesetService } from "../../../../domain/changeset/index";
import { log } from "../../../../utils/logger";
import { getErrorMessage } from "../../../../errors/index";
import { sessionPrCreateCommandParams, sessionPrEditCommandParams } from "./session-parameters";

/**
 * Session changeset list parameters (simplified, session-focused)
 */
const sessionChangesetListParams: CommandParameterMap = composeParams(
  {
    repo: CommonParameters.repo,
    json: CommonParameters.json,
  },
  {
    status: {
      schema: z.string().optional(),
      spec: "Filter by status (open, merged, closed, draft)",
      required: false,
    },
    limit: {
      schema: z.number().optional(),
      spec: "Maximum number of results (default: 10)",
      required: false,
    },
    all: {
      schema: z.boolean().optional(),
      spec: "Show changesets for all sessions, not just current",
      required: false,
    },
  }
);

/**
 * Session changeset get parameters
 */
const sessionChangesetGetParams: CommandParameterMap = composeParams(
  {
    repo: CommonParameters.repo,
    json: CommonParameters.json,
  },
  {
    id: {
      schema: z.string().optional(),
      spec: "Changeset ID (defaults to current session's changeset)",
      required: false,
    },
    details: {
      schema: z.boolean().optional(),
      spec: "Include detailed diff information",
      required: false,
    },
  }
);

/**
 * List changesets for current session (or all sessions)
 */
async function executeSessionChangesetList(
  params: any,
  ctx?: CommandExecutionContext
): Promise<any> {
  try {
    // Resolve repository
    const { repoUrl } = await resolveRepositoryAndBackend({
      repoParam: params.repo,
    });

    // Get current session if not showing all
    let sessionFilter: string | undefined;
    if (!params.all) {
      try {
        const currentSessionName = await getCurrentSession(process.cwd());
        if (currentSessionName) {
          sessionFilter = currentSessionName;
        } else {
          log.cliWarn("No current session detected. Use --all to see changesets for all sessions.");
          return { success: true };
        }
      } catch {
        log.cliWarn("Could not detect current session. Use --all to see all changesets.");
        return { success: true };
      }
    }

    // Create changeset service
    const changesetService = await createChangesetService(repoUrl);

    // Get all changesets and filter by session
    const allChangesets = await changesetService.list({
      status: params.status as any,
      limit: params.limit || 10,
    });

    let changesets = allChangesets;
    if (sessionFilter) {
      changesets = allChangesets.filter(
        (changeset) =>
          changeset.sessionName === sessionFilter ||
          changeset.sourceBranch === `pr/${sessionFilter}` ||
          changeset.sourceBranch === sessionFilter
      );
    }

    if (params.json || ctx?.format === "json") {
      return {
        success: true,
        data: {
          changesets,
          sessionFilter,
          count: changesets.length,
          repository: repoUrl,
        },
      };
    }

    // Human-readable output
    const platform = await changesetService.getPlatform();
    const sessionMsg = sessionFilter ? ` for session '${sessionFilter}'` : " (all sessions)";

    log.cli(`\n📋 Changesets${sessionMsg} in ${repoUrl} (${platform})\n${"━".repeat(60)}\n`);

    if (changesets.length === 0) {
      log.cli(sessionFilter ? "No changesets found for current session" : "No changesets found");

      if (sessionFilter) {
        log.cli(`\n💡 Try 'session changeset list --all' to see changesets for all sessions`);
      }

      return { success: true };
    }

    for (const changeset of changesets) {
      const statusIcon =
        changeset.status === "open" ? "🟢" : changeset.status === "merged" ? "🟣" : "🔴";

      log.cli(`${statusIcon} ${changeset.id}: ${changeset.title}`);
      log.cli(
        `   Author: ${changeset.author.username} | Target: ${changeset.targetBranch} | Status: ${changeset.status}`
      );

      if (changeset.sessionName) {
        log.cli(`   Session: ${changeset.sessionName}`);
      }

      log.cli(""); // Empty line
    }

    log.cli(`Found ${changesets.length} changeset(s)${sessionMsg}`);

    return { success: true };
  } catch (error) {
    const errorMsg = `Failed to list session changesets: ${getErrorMessage(error)}`;
    log.cliError(errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Get current session's changeset (or specified ID)
 */
async function executeSessionChangesetGet(
  params: any,
  ctx?: CommandExecutionContext
): Promise<any> {
  try {
    // Resolve repository
    const { repoUrl } = await resolveRepositoryAndBackend({
      repoParam: params.repo,
    });

    let changesetId = params.id;

    // If no ID specified, try to find current session's changeset
    if (!changesetId) {
      try {
        const currentSessionName = await getCurrentSession(process.cwd());
        if (currentSessionName) {
          changesetId = `pr/${currentSessionName}`;
        } else {
          const errorMsg = "No changeset ID specified and no current session detected";
          log.cliError(errorMsg);
          return { success: false, error: errorMsg };
        }
      } catch {
        const errorMsg = "No changeset ID specified and could not detect current session";
        log.cliError(errorMsg);
        return { success: false, error: errorMsg };
      }
    }

    // Create changeset service and get changeset
    const changesetService = await createChangesetService(repoUrl);
    const changeset = params.details
      ? await changesetService.getDetails(changesetId)
      : await changesetService.get(changesetId);

    if (!changeset) {
      const errorMsg = `Changeset not found: ${changesetId}`;
      log.cliError(errorMsg);
      return { success: false, error: errorMsg };
    }

    if (params.json || ctx?.format === "json") {
      return {
        success: true,
        data: changeset,
      };
    }

    // Human-readable output (reuse logic from repo changeset get)
    const statusIcon =
      changeset.status === "open" ? "🟢" : changeset.status === "merged" ? "🟣" : "🔴";

    log.cli(`\n${statusIcon} Session Changeset ${changeset.id} (${changeset.platform})`);
    log.cli(`${"━".repeat(60)}`);
    log.cli(`Title: ${changeset.title}`);
    log.cli(`Author: ${changeset.author.username}`);
    log.cli(`Status: ${changeset.status}`);
    log.cli(`Target: ${changeset.targetBranch} ← ${changeset.sourceBranch || "HEAD"}`);

    if (changeset.sessionName) {
      log.cli(`Session: ${changeset.sessionName}`);
    }
    if (changeset.taskId) {
      log.cli(`Task: ${changeset.taskId}`);
    }

    log.cli(`Created: ${changeset.createdAt.toLocaleDateString()}`);
    log.cli(`Updated: ${changeset.updatedAt.toLocaleDateString()}`);

    if (changeset.description) {
      log.cli(`\nDescription:\n${changeset.description}`);
    }

    if (changeset.commits.length > 0) {
      log.cli(`\nCommits (${changeset.commits.length}):`);
      changeset.commits.forEach((commit) => {
        const shortSha = commit.sha.substring(0, 7);
        log.cli(`  ${shortSha} ${commit.message.split("\n")[0]}`);
      });
    }

    return { success: true };
  } catch (error) {
    const errorMsg = `Failed to get session changeset: ${getErrorMessage(error)}`;
    log.cliError(errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Register session changeset alias commands
 */
export function registerSessionChangesetCommands(): void {
  // Register session changeset list command
  sharedCommandRegistry.registerCommand({
    id: "session.changeset.list",
    name: "changeset list",
    description: "List changesets for current session (alias for session pr list)",
    category: CommandCategory.SESSION,
    parameters: sessionChangesetListParams,
    execute: executeSessionChangesetList,
  });

  // Register session changeset get command
  sharedCommandRegistry.registerCommand({
    id: "session.changeset.get",
    name: "changeset get",
    description: "Get current session's changeset details (alias for session pr)",
    category: CommandCategory.SESSION,
    parameters: sessionChangesetGetParams,
    execute: executeSessionChangesetGet,
  });

  // Register short aliases
  sharedCommandRegistry.registerCommand({
    id: "session.cs.list",
    name: "cs list",
    description: "List changesets for current session (short alias)",
    category: CommandCategory.SESSION,
    parameters: sessionChangesetListParams,
    execute: executeSessionChangesetList,
  });

  sharedCommandRegistry.registerCommand({
    id: "session.cs.get",
    name: "cs get",
    description: "Get current session's changeset details (short alias)",
    category: CommandCategory.SESSION,
    parameters: sessionChangesetGetParams,
    execute: executeSessionChangesetGet,
  });

  // Delegation aliases for other session pr commands

  // session.changeset.create → session.pr.create
  sharedCommandRegistry.registerCommand({
    id: "session.changeset.create",
    name: "changeset create",
    description: "Create a changeset for current session (alias for session pr create)",
    category: CommandCategory.SESSION,
    parameters: sessionPrCreateCommandParams,
    execute: async (params: any, ctx?: CommandExecutionContext) => {
      // Delegate to existing session.pr.create
      const prCreateCommand = sharedCommandRegistry.getCommand("session.pr.create");
      if (prCreateCommand) {
        return await prCreateCommand.execute(params, ctx);
      }
      throw new Error("session.pr.create command not available");
    },
  });

  // session.changeset.approve → session.pr.approve
  sharedCommandRegistry.registerCommand({
    id: "session.changeset.approve",
    name: "changeset approve",
    description: "Approve current session's changeset (alias for session pr approve)",
    category: CommandCategory.SESSION,
    parameters: {},
    execute: async (params: any, ctx?: CommandExecutionContext) => {
      const prApproveCommand = sharedCommandRegistry.getCommand("session.pr.approve");
      if (prApproveCommand) {
        return await prApproveCommand.execute(params, ctx);
      }
      throw new Error("session.pr.approve command not available");
    },
  });

  // session.changeset.merge → session.pr.merge
  sharedCommandRegistry.registerCommand({
    id: "session.changeset.merge",
    name: "changeset merge",
    description: "Merge current session's changeset (alias for session pr merge)",
    category: CommandCategory.SESSION,
    parameters: {},
    execute: async (params: any, ctx?: CommandExecutionContext) => {
      const prMergeCommand = sharedCommandRegistry.getCommand("session.pr.merge");
      if (prMergeCommand) {
        return await prMergeCommand.execute(params, ctx);
      }
      throw new Error("session.pr.merge command not available");
    },
  });

  // session.changeset.edit → session.pr.edit
  sharedCommandRegistry.registerCommand({
    id: "session.changeset.edit",
    name: "changeset edit",
    description: "Edit current session's changeset (alias for session pr edit)",
    category: CommandCategory.SESSION,
    parameters: sessionPrEditCommandParams,
    execute: async (params: any, ctx?: CommandExecutionContext) => {
      const prEditCommand = sharedCommandRegistry.getCommand("session.pr.edit");
      if (prEditCommand) {
        return await prEditCommand.execute(params, ctx);
      }
      throw new Error("session.pr.edit command not available");
    },
  });

  // Short aliases for create/approve/merge
  sharedCommandRegistry.registerCommand({
    id: "session.cs.create",
    name: "cs create",
    description: "Create changeset for current session (short alias)",
    category: CommandCategory.SESSION,
    parameters: sessionPrCreateCommandParams,
    execute: async (params: any, ctx?: CommandExecutionContext) => {
      const prCreateCommand = sharedCommandRegistry.getCommand("session.pr.create");
      if (prCreateCommand) {
        return await prCreateCommand.execute(params, ctx);
      }
      throw new Error("session.pr.create command not available");
    },
  });

  sharedCommandRegistry.registerCommand({
    id: "session.cs.approve",
    name: "cs approve",
    description: "Approve current session's changeset (short alias)",
    category: CommandCategory.SESSION,
    parameters: {},
    execute: async (params: any, ctx?: CommandExecutionContext) => {
      const prApproveCommand = sharedCommandRegistry.getCommand("session.pr.approve");
      if (prApproveCommand) {
        return await prApproveCommand.execute(params, ctx);
      }
      throw new Error("session.pr.approve command not available");
    },
  });

  sharedCommandRegistry.registerCommand({
    id: "session.cs.merge",
    name: "cs merge",
    description: "Merge current session's changeset (short alias)",
    category: CommandCategory.SESSION,
    parameters: {},
    execute: async (params: any, ctx?: CommandExecutionContext) => {
      const prMergeCommand = sharedCommandRegistry.getCommand("session.pr.merge");
      if (prMergeCommand) {
        return await prMergeCommand.execute(params, ctx);
      }
      throw new Error("session.pr.merge command not available");
    },
  });
}
