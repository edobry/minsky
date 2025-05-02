import { Command } from "commander";
import { SessionDB } from "../../domain/session";
import { normalizeTaskId } from "../../utils/task-utils";

export function createDirCommand(): Command {
  return new Command("dir")
    .description("Print the workdir path for a session (for use with cd $(minsky session dir <session>))")
    .argument("[session]", "Session identifier")
    .option("--task <taskId>", "Find session directory by associated task ID")
    .action(async (sessionName: string | undefined, options: { task?: string }) => {
      try {
        // Initialize the session DB
        const db = new SessionDB();
        let session;
        
        // Error if both session and --task are provided
        if (sessionName && options.task) {
          console.error("Provide either a session name or --task, not both.");
          process.exit(1);
          return;
        }
        
        // If task ID is provided, find the session by task ID
        if (options.task) {
          // Normalize the task ID format
          const normalizedTaskId = normalizeTaskId(options.task);
          
          session = await db.getSessionByTaskId(normalizedTaskId);
          if (!session) {
            console.error(`No session found for task ID '${normalizedTaskId}'.`);
            process.exit(1);
            return;
          }
        } else if (sessionName) {
          // Otherwise look up by session name
          session = await db.getSession(sessionName);
          if (!session) {
            console.error(`Session '${sessionName}' not found.`);
            process.exit(1);
            return;
          }
        } else {
          console.error("You must provide either a session name or --task.");
          process.exit(1);
          return;
        }
        
        // Use the SessionDB.getRepoPath method to get the correct repository path
        const workdir = await db.getRepoPath(session);
        console.log(workdir);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error("Error getting session directory:", err.message);
        process.exit(1);
      }
    });
} 
