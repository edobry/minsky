import { Command } from "commander";
import { SessionDB } from "../../domain/session.js";
import { normalizeTaskId } from "../../domain/tasks/utils";
import { getCurrentSession as defaultGetCurrentSession } from "../../domain/workspace.js";
import type { SessionCommandDependencies } from "./index.js";
import { log } from "../../utils/logger.js";

export function createGetCommand(dependencies: SessionCommandDependencies = {}): Command {
  // Use provided dependency or fall back to default
  const getCurrentSession = dependencies.getCurrentSession || defaultGetCurrentSession;

  return new Command("get")
    .description("Get details for a specific session or by task ID")
    .argument("[session]", "Session identifier")
    .option("--task <taskId>", "Find session by associated task ID")
    .option("--json", "Output session as JSON")
    .option("--ignore-workspace", "Ignore auto-detection from workspace")
    .action(
      async (
        sessionName: string | undefined,
        options: {
          json?: boolean;
          task?: string;
          ignoreWorkspace?: boolean;
        }
      ) => {
        try {
          const db = new SessionDB();
          if (sessionName && options.task) {
            const msg = "Provide either a session name or --task, not both.";
            if (options.json) {
              log.agent(JSON.stringify({ error: msg }));
            } else {
              log.cliError(msg);
            }
            process.exit(1);
          }

          let record;
          if (options.task) {
            const internalTaskId = normalizeTaskId(options.task);
            if (!internalTaskId) {
              const msg = `Error: Invalid Task ID format provided: "${options.task}"`;
              if (options.json) {
                log.agent(JSON.stringify({ error: msg }));
              } else {
                log.cliError(msg);
              }
              process.exit(1);
              return;
            }
            record = await db.getSessionByTaskId(internalTaskId);
            if (!record) {
              const msg = `No session found for task ID originating from "${options.task}" (normalized to "${internalTaskId}").`;
              if (options.json) {
                log.agent(JSON.stringify(null));
              } else {
                log.cliError(msg);
              }
              process.exit(1);
            }
          } else if (sessionName) {
            record = await db.getSession(sessionName);
            if (!record) {
              if (options.json) {
                log.agent(JSON.stringify(null));
              } else {
                log.cliError(`Session "${sessionName}" not found.`);
              }
              process.exit(1);
            }
          } else if (!options.ignoreWorkspace) {
            const currentSessionName = await getCurrentSession();
            if (currentSessionName) {
              record = await db.getSession(currentSessionName);
              if (!record) {
                const msg = `Current session "${currentSessionName}" not found in session database.`;
                if (options.json) {
                  log.agent(JSON.stringify({ error: msg }));
                } else {
                  log.cliError(msg);
                }
                process.exit(1);
              }
            } else {
              const msg =
                "Not in a session workspace. Please provide a session name or --task option.";
              if (options.json) {
                log.agent(JSON.stringify({ error: msg }));
              } else {
                log.cliError(msg);
              }
              process.exit(1);
            }
          } else {
            const msg = "You must provide either a session name or --task.";
            if (options.json) {
              log.agent(JSON.stringify({ error: msg }));
            } else {
              log.cliError(msg);
            }
            process.exit(1);
          }

          if (options.json) {
            log.agent(JSON.stringify(record, null, 2));
          } else {
            // Print a human-readable summary (mimic list output)
            log.cli(`Session: ${record.session}`);
            log.cli(`Repo: ${record.repoUrl}`);
            // The branch property might not exist on SessionRecord type, so access it safely
            log.cli(`Branch: ${(record as any).branch || "(none)"}`);
            log.cli(`Created: ${record.createdAt}`);
            if (record.taskId) {
              log.cli(`Task ID: ${record.taskId}`);
            }
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          const msg = `Error getting session: ${err.message}`;
          log.error("Error getting session details", {
            error: err.message,
            stack: err.stack
          });
          
          if (options.json) {
            log.agent(JSON.stringify({ error: msg }));
          } else {
            log.cliError(msg);
          }
          process.exit(1);
        }
      }
    );
}
