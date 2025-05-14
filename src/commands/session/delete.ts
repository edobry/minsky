import { Command } from "commander";
import { SessionDB } from "../../domain/session.js";
import { normalizeTaskId } from "../../domain/tasks";
import { join } from "path";
import { promises as fs } from "fs";
import { createInterface } from "readline";
import { exit } from "../../utils/process";
import * as p from "@clack/prompts";

export function createDeleteCommand(): Command {
  return new Command("delete")
    .description("Delete a session and its repository")
    .argument("[session-name]", "Name of the session to delete")
    .option("--task <taskId>", "Task ID associated with the session to delete")
    .option("--force", "Skip confirmation prompt")
    .option("--json", "Output result as JSON")
    .action(
      async (
        sessionNameInput: string | undefined,
        options: { task?: string; force?: boolean; json?: boolean }
      ) => {
        try {
          const db = new SessionDB();
          let sessionToDeleteName: string | null = null;
          let sessionToQuery: string | null = null;

          if (options.task) {
            const internalTaskId = normalizeTaskId(options.task);
            if (!internalTaskId) {
              const errorMessage = `Error: Invalid Task ID format provided: "${options.task}"`;
              if (options.json) {
                console.log(JSON.stringify({ success: false, error: errorMessage }));
              } else {
                console.error(errorMessage);
              }
              exit(1);
            }
            
            const sessionByTask = await db.getSessionByTaskId(internalTaskId);
            if (sessionByTask) {
              sessionToDeleteName = sessionByTask.session;
              sessionToQuery = sessionToDeleteName; // Use the found session name for querying
            } else {
              const errorMessage = `No session found for task ID originating from "${options.task}" (normalized to "${internalTaskId}").`;
              if (options.json) {
                console.log(JSON.stringify({ success: false, error: errorMessage }));
              } else {
                console.error(errorMessage);
              }
              exit(1);
            }
          } else if (sessionNameInput) {
            sessionToDeleteName = sessionNameInput;
            sessionToQuery = sessionToDeleteName;
          } else {
            // This case should ideally be caught by Commander if argument is truly required
            // and no task ID is provided. However, making argument optional to handle --task properly.
            const errorMessage = "Session name or task ID must be provided.";
            if (options.json) {
              console.log(JSON.stringify({ success: false, error: errorMessage }));
            } else {
              console.error(errorMessage);
            }
            exit(1);
          }

          if (!sessionToDeleteName || !sessionToQuery) {
            // Should not happen if logic above is correct, but as a safeguard.
            const errorMessage = "Could not determine session to delete.";
            if (options.json) {
              console.log(JSON.stringify({ success: false, error: errorMessage }));
            } else {
              console.error(errorMessage);
            }
            exit(1);
          }

          // First, check if the session exists using the determined sessionToQuery
          const session = await db.getSession(sessionToQuery);

          if (!session) {
            // Use sessionToDeleteName for the error message as it's what the user effectively tried to delete
            const errorMessage = `Session '${sessionToDeleteName}' not found.`;
            if (options.json) {
              console.log(JSON.stringify({ success: false, error: errorMessage }));
            } else {
              console.error(errorMessage);
            }
            exit(1);
          }

          // Confirm before deletion unless --force is used
          if (!options.force) {
            const answer = await promptConfirmation(
              `Are you sure you want to delete session '${sessionToDeleteName}' and its repository? This action cannot be undone. (y/n): `
            );

            if (!answer) {
              const message = "Deletion cancelled.";
              if (options.json) {
                console.log(JSON.stringify({ success: false, message }));
              } else {
                console.log(message);
              }
              return;
            }
          }

          // Determine the repository path - use stored path or fallback to getRepoPath if available
          let repoPath: string;
          
          // If session has repoPath property, use it directly
          if (session.repoPath) {
            repoPath = session.repoPath;
          } else if (typeof db.getRepoPath === "function") {
            // If db.getRepoPath exists, use it (newer versions)
            repoPath = await db.getRepoPath(session);
          } else {
            // Legacy fallback - construct path manually
            const xdgStateHome = Bun.env.XDG_STATE_HOME || join(Bun.env.HOME || "", ".local/state");
            repoPath = join(xdgStateHome, "minsky", "git", session.repoName, session.session);
          }

          // Try to delete the session repository
          let repoDeleted = false;
          try {
            await fs.rm(repoPath, { recursive: true, force: true });
            repoDeleted = true;
          } catch (error) {
            const errorMessage = `Error deleting repository: ${error instanceof Error ? error.message : String(error)}`;

            if (options.json) {
              console.log(
                JSON.stringify({
                  success: false,
                  error: errorMessage,
                  repoDeleted: false,
                  recordDeleted: false,
                })
              );
            } else {
              console.error(errorMessage);
            }
            exit(1);
          }

          // Try to delete session from database
          let recordDeleted = false;
          try {
            recordDeleted = await db.deleteSession(sessionToDeleteName);

            if (!recordDeleted) {
              throw new Error(`Failed to delete session record from database for '${sessionToDeleteName}'.`);
            }
          } catch (error) {
            const errorMessage = `Error removing session record: ${error instanceof Error ? error.message : String(error)}`;
            const finalMessage = repoDeleted 
              ? `${errorMessage}\nWARNING: Repository was deleted but session record remains. Database might be in an inconsistent state.`
              : errorMessage;

            if (options.json) {
              console.log(
                JSON.stringify({
                  success: false,
                  error: finalMessage,
                  repoDeleted,
                  recordDeleted: false,
                })
              );
            } else {
              console.error(finalMessage);
            }
            exit(1); // Always exit if record deletion fails
          }

          // Success case
          const successMessage = `Session '${sessionToDeleteName}' successfully deleted.`;
          if (options.json) {
            console.log(
              JSON.stringify({
                success: true,
                message: successMessage,
                repoDeleted,
                recordDeleted,
              })
            );
          } else {
            console.log(successMessage);
          }
        } catch (error) {
          const errorMessage = `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;

          if (options.json) {
            console.log(JSON.stringify({ success: false, error: errorMessage }));
          } else {
            console.error(errorMessage);
          }
          exit(1);
        }
      }
    );
}

// Helper function to prompt for confirmation
async function promptConfirmation(prompt: string): Promise<boolean> {
  const result = await p.confirm({ message: prompt, initialValue: false });
  return !!result;
}
