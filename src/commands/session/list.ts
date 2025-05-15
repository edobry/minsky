import { Command } from "commander";
import { SessionDB } from "../../domain/session";
import { log } from "../../utils/logger";

export function createListCommand(): Command {
  return new Command("list")
    .description("List all sessions")
    .option("--json", "Output sessions as JSON")
    .action(async (options: { json?: boolean }) => {
      const db = new SessionDB();
      const sessions = await db.listSessions();
      
      try {
        if (sessions.length === 0) {
          if (options.json) {
            // Use agent logger for structured JSON output
            log.agent(JSON.stringify([]));
          } else {
            // Use program logger for user-facing messages
            log.cli("No sessions found.");
          }
          return;
        }
        
        if (options.json) {
          // Use agent logger for structured JSON output
          log.agent(JSON.stringify(sessions, null, 2));
        } else {
          // Format and display each session using program logger
          for (const s of sessions) {
            log.cli(`Session: ${s.session}\n  Repo: ${s.repoUrl}\n  Created: ${s.createdAt}\n`);
          }
        }
      } catch (error) {
        log.error("Error listing sessions", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
      }
    });
}
