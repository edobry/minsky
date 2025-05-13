#!/usr/bin/env bun
import { SessionDB } from "./src/domain/session";

async function main() {
  // Initialize the SessionDB
  const db = new SessionDB();

  console.log("Starting session migration...");

  // List all current sessions
  const sessions = await db.listSessions();
  console.log(`Found ${sessions.length} sessions`);

  for (const session of sessions) {
    console.log(`- ${session.session} (${session.repoName}): ${session.repoPath || "no path"}`);
  }

  // Run the migration
  console.log("\nMigrating sessions to subdirectory structure...");
  await db.migrateSessionsToSubdirectory();

  // List sessions after migration
  const migratedSessions = await db.listSessions();
  console.log(`\nAfter migration: ${migratedSessions.length} sessions`);

  for (const session of migratedSessions) {
    console.log(`- ${session.session} (${session.repoName}): ${session.repoPath || "no path"}`);
  }
}

main().catch((error) => {
  console.error("Error during migration:", error);
  process.exit(1);
});
