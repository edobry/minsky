import { Command } from "commander";
import { SessionDB } from "../../domain/session.js";
import { normalizeTaskId } from "../../utils/task-utils.js";

export function createDeleteCommand(db: SessionDB): Command {
  const command = new Command("delete")
    .description("Delete a Minsky session")
    .argument("[session]", "Session name to delete")
    .option("-t, --task <taskId>", "Task ID associated with the session")
    .option("-f, --force", "Force deletion without confirmation", false)
    .option("--json", "Output in JSON format")
    .action(async (sessionName, options) => {
      try {
        let sessionToDelete: string | undefined = sessionName;

        if (options.task && sessionName) {
          const internalTaskId = normalizeTaskId(options.task);
          const taskSession = await db.getSessionByTaskId(internalTaskId);
          if (taskSession) {
            sessionToDelete = taskSession.session;
            if (options.json) {
              console.log(JSON.stringify({ session: sessionToDelete, status: "resolved by task ID" }));
            }
          } else {
            if (!sessionName) {
              throw new Error(`No session found for task ID "${internalTaskId}", and no session name provided.`);
            }
            if (options.json) {
              console.log(JSON.stringify({ error: `No session found for task ${internalTaskId}, attempting to delete by name: ${sessionName}` }));
            }
          }
        } else if (options.task) {
          const internalTaskId = normalizeTaskId(options.task);
          const taskSession = await db.getSessionByTaskId(internalTaskId);
          if (!taskSession) {
            throw new Error(`No session found for task ID "${internalTaskId}"`);
          }
          sessionToDelete = taskSession.session;
        }

        if (!sessionToDelete) {
          throw new Error(
            "Session name or task ID must be provided, or run from within a session workspace."
          );
        }

        const success = await db.deleteSession(sessionToDelete);
        if (success) {
          if (options.json) {
            console.log(JSON.stringify({ session: sessionToDelete, deleted: true, message: `Session "${sessionToDelete}" deleted successfully.` }));
          } else {
            console.log(`Session "${sessionToDelete}" deleted successfully.`);
          }
        } else {
          throw new Error(`Session "${sessionToDelete}" not found or could not be deleted.`);
        }
      } catch (error) {
        if (options.json) {
          console.error(JSON.stringify({ error: (error instanceof Error ? error.message : String(error))}));
        } else {
          console.error(error instanceof Error ? error.message : String(error));
        }
        process.exit(1);
      }
    });

  return command;
}
