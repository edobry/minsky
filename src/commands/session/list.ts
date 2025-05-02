import { Command } from "commander";
import { SessionDB } from "../../domain/session";

export function createListCommand(): Command {
  return new Command("list")
    .description("List all sessions")
    .option("--json", "Output sessions as JSON")
    .action(async (options: { json?: boolean }) => {
      const db = new SessionDB();
      const sessions = await db.listSessions();
      if (sessions.length === 0) {
        if (options.json) {
          console.log(JSON.stringify([]));
        } else {
          console.log("No sessions found.");
        }
        return;
      }
      if (options.json) {
        console.log(JSON.stringify(sessions, null, 2));
      } else {
        for (const s of sessions) {
          console.log(`Session: ${s.session}\n  Repo: ${s.repoUrl}\n  Branch: ${s.branch || "(none)"}\n  Created: ${s.createdAt}\n`);
        }
      }
    });
} 
