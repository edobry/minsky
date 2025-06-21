import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pgTable, varchar, text as pgText } from "drizzle-orm/pg-core";

/**
 * SQLite schema for sessions
 */
export const sessionsTableSqlite = sqliteTable("sessions", {
  session: text("session").primaryKey(),
  repoName: text("repo_name").notNull(),
  repoUrl: text("repo_url").notNull(),
  createdAt: text("created_at").notNull(),
  taskId: text("task_id").notNull(),
  branch: text("branch").notNull(),
  repoPath: text("repo_path"),
});

/**
 * PostgreSQL schema for sessions
 */
export const sessionsTablePostgres = pgTable("sessions", {
  session: varchar("session", { length: 255 }).primaryKey(),
  repoName: varchar("repo_name", { length: 255 }).notNull(),
  repoUrl: pgText("repo_url").notNull(),
  createdAt: varchar("created_at", { length: 50 }).notNull(),
  taskId: varchar("task_id", { length: 100 }).notNull(),
  branch: varchar("branch", { length: 255 }).notNull(),
  repoPath: pgText("repo_path"),
});

/**
 * Type inference for session records from both schemas
 */
export type SessionRecordSqlite = typeof sessionsTableSqlite.$inferSelect;
export type SessionRecordPostgres = typeof sessionsTablePostgres.$inferSelect;
export type NewSessionSqlite = typeof sessionsTableSqlite.$inferInsert;
export type NewSessionPostgres = typeof sessionsTablePostgres.$inferInsert; 
