import { Command } from "commander";
import { SessionDB } from "../../domain/session.js";
import { join } from "path";
import { promises as fs } from "fs";
import { createInterface } from "readline";

export function createDeleteCommand(): Command {
  return new Command("delete")
    .description("Delete a session and its repository")
    .argument("<session-name>", "Name of the session to delete")
    .option("--force", "Skip confirmation prompt")
    .option("--json", "Output result as JSON")
    .action(async (sessionName: string, options: { force?: boolean, json?: boolean }) => {
      try {
        // First, check if the session exists
        const db = new SessionDB();
        const session = await db.getSession(sessionName);
        
        if (!session) {
          const errorMessage = `Session "${sessionName}" not found.`;
          if (options.json) {
            console.log(JSON.stringify({ 
              success: false, 
              error: errorMessage,
              session: sessionName 
            }));
          } else {
            console.error(errorMessage);
          }
          process.exit(1);
        }
        
        // Confirm before deletion unless --force is used
        if (!options.force) {
          const answer = await promptConfirmation(
            `Are you sure you want to delete session "${sessionName}" and its repository? This action cannot be undone. (y/n): `
          );
          
          if (!answer) {
            const message = "Deletion cancelled.";
            if (options.json) {
              console.log(JSON.stringify({ 
                success: false, 
                message,
                session: sessionName
              }));
            } else {
              console.log(message);
            }
            return;
          }
        }
        
        // Check for uncommitted changes
        const repoPath = getSessionRepoPath(session);
        
        // Try to delete the session repository
        let repoDeleted = false;
        try {
          await fs.rm(repoPath, { recursive: true, force: true });
          repoDeleted = true;
        } catch (error) {
          const errorMessage = `Error deleting repository: ${error instanceof Error ? error.message : String(error)}`;
          
          if (options.json) {
            console.log(JSON.stringify({ 
              success: false, 
              error: errorMessage,
              session: sessionName,
              repoDeleted: false,
              recordDeleted: false
            }));
          } else {
            console.error(errorMessage);
          }
          process.exit(1);
        }
        
        // Try to delete session from database
        let recordDeleted = false;
        try {
          recordDeleted = await db.deleteSession(sessionName);
          
          if (!recordDeleted) {
            throw new Error("Failed to delete session record from database");
          }
        } catch (error) {
          const errorMessage = `Error removing session record: ${error instanceof Error ? error.message : String(error)}`;
          
          // If we deleted the repo but failed to update the DB, this is a critical error
          if (repoDeleted) {
            if (options.json) {
              console.log(JSON.stringify({ 
                success: false, 
                error: errorMessage,
                session: sessionName,
                repoDeleted: true,
                recordDeleted: false,
                warning: "Repository was deleted but session record remains. Database might be in an inconsistent state."
              }));
            } else {
              console.error(errorMessage);
              console.error("WARNING: Repository was deleted but session record remains. Database might be in an inconsistent state.");
            }
            process.exit(1);
          }
        }
        
        // Success case
        const successMessage = `Session "${sessionName}" successfully deleted.`;
        if (options.json) {
          console.log(JSON.stringify({ 
            success: true, 
            message: successMessage,
            session: sessionName,
            repoDeleted,
            recordDeleted
          }));
        } else {
          console.log(successMessage);
        }
      } catch (error) {
        const errorMessage = `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
        
        if (options.json) {
          console.log(JSON.stringify({ 
            success: false, 
            error: errorMessage,
            session: sessionName
          }));
        } else {
          console.error(errorMessage);
        }
        process.exit(1);
      }
    });
}

// Helper function to get session repository path
function getSessionRepoPath(session: { repoName: string, session: string }): string {
  const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
  return join(xdgStateHome, "minsky", "git", session.repoName, session.session);
}

// Helper function to prompt for confirmation
async function promptConfirmation(prompt: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise<boolean>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
} 
