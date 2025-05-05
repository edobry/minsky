import { Command } from "commander";
import { SessionDB } from "../../domain/session";
import { normalizeTaskId } from "../../utils/task-utils";
import { getCurrentSession } from "../../domain/workspace";
import { GitService } from "../../domain/git";
import { join } from "path";
import { existsSync } from "fs";

export function createDirCommand(): Command {
  return new Command("dir")
    .description("Print the workdir path for a session (for use with cd $(minsky session dir <session>))")
    .argument("[session]", "Session identifier (detected automatically if in a session workspace)")
    .option("--task <taskId>", "Find session directory by associated task ID")
    .option("--ignore-workspace", "Ignore current workspace detection")
    .action(async (sessionName: string | undefined, options: { task?: string, ignoreWorkspace?: boolean }) => {
      try {
        // Initialize the session DB and Git service for getting session workspace path
        const db = new SessionDB();
        const gitService = new GitService();
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
        } else if (!options.ignoreWorkspace) {
          // Auto-detect from current working directory if neither session nor task is provided
          const currentSession = await getCurrentSession();
          if (currentSession) {
            session = await db.getSession(currentSession);
            if (!session) {
              console.error(`Current workspace session '${currentSession}' not found in database.`);
              process.exit(1);
              return;
            }
          } else {
            console.error("No session name provided and not in a session workspace. Use --task or provide a session name.");
            process.exit(1);
            return;
          }
        } else {
          console.error("You must provide either a session name or --task when using --ignore-workspace.");
          process.exit(1);
          return;
        }
        
        // Determine the correct session directory path based on what exists
        // Get the state home directory
        const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
        const baseDir = join(xdgStateHome, "minsky", "git");
        
        // Try the legacy path first (without sessions subdirectory)
        const legacyPath = join(baseDir, session.repoName, session.session);
        
        // Also check the new path structure with sessions subdirectory
        const newPath = gitService.getSessionWorkdir(session.repoName, session.session);
        
        // Use legacy path if it exists, otherwise use new path
        const workdir = existsSync(legacyPath) ? legacyPath : newPath;
        
        console.log(workdir);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error("Error getting session directory:", err.message);
        process.exit(1);
      }
    });
} 
