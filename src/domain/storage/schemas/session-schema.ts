/**
 * Drizzle Schema for Session Records
 *
 * This module defines the database schema for session records using Drizzle ORM.
 * It supports both SQLite and PostgreSQL databases with identical schemas.
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import {
  pgTable,
  varchar,
  text as pgText,
  timestamp,
  uuid,
  integer as pgInteger,
} from "drizzle-orm/pg-core";
import type { SessionRecord } from "../../session/session-db";

// SQLite Schema
export const sqliteSessions = sqliteTable("sessions", {
  session: (text("session") as any).primaryKey(),
  repoName: (text("repo_name") as any).notNull(),
  repoUrl: (text("repo_url") as any).notNull(),
  createdAt: (text("created_at") as any).notNull(),
  taskId: (text("task_id") as any).notNull(),
  branch: (text("branch") as any).notNull(),
  repoPath: text("repo_path"),
});

// PostgreSQL Schema
export const postgresSessions = pgTable("sessions", {
  session: (varchar("session", { length: 255 }) as any).primaryKey(),
  repoName: (varchar("repo_name", { length: 255 }) as any).notNull(),
  repoUrl: (varchar("repo_url", { length: 1000 }) as any).notNull(),
  createdAt: (timestamp("created_at", { withTimezone: true }) as any).notNull(),
  taskId: (varchar("task_id", { length: 100 }) as any).notNull(),
  branch: (varchar("branch", { length: 255 }) as any).notNull(),
  repoPath: varchar("repo_path", { length: 1000 }),
});

// Type exports for better type inference
export type SqliteSessionRecord = typeof sqliteSessions.$inferSelect;
export type SqliteSessionInsert = typeof sqliteSessions.$inferInsert;
export type PostgresSessionRecord = typeof postgresSessions.$inferSelect;
export type PostgresSessionInsert = typeof postgresSessions.$inferInsert;

/**
 * Convert SessionRecord to SQLite insert format
 */
export function toSqliteInsert(record: SessionRecord): SqliteSessionInsert {
  return {
    session: (record as any).session,
    repoName: (record as any).repoName,
    repoUrl: (record as any).repoUrl,
    createdAt: (record as any).createdAt,
    taskId: (record as any).taskId,
    branch: (record as any).branch,
    repoPath: (record as any).repoPath || null,
  };
}

/**
 * Convert SQLite record to SessionRecord format
 */
export function fromSqliteSelect(record: SqliteSessionRecord): SessionRecord {
  return {
    session: (record as any).session,
    repoName: (record as any).repoName,
    repoUrl: (record as any).repoUrl,
    createdAt: (record as any).createdAt,
    taskId: (record as any).taskId,
    branch: (record as any).branch,
    repoPath: (record as any).repoPath || undefined,
  };
}

/**
 * Convert SessionRecord to PostgreSQL insert format
 */
export function toPostgresInsert(record: SessionRecord): PostgresSessionInsert {
  return {
    session: (record as any).session,
    repoName: (record as any).repoName,
    repoUrl: (record as any).repoUrl,
    createdAt: new Date((record as any).createdAt),
    taskId: (record as any).taskId,
    branch: (record as any).branch,
    repoPath: (record as any).repoPath || null,
  };
}

/**
 * Convert PostgreSQL record to SessionRecord format
 */
export function fromPostgresSelect(record: PostgresSessionRecord): SessionRecord {
  return {
    session: (record as any).session,
    repoName: (record as any).repoName,
    repoUrl: (record as any).repoUrl,
    createdAt: (record.createdAt as any).toISOString(),
    taskId: (record as any).taskId,
    branch: (record as any).branch,
    repoPath: (record as any).repoPath || undefined,
  };
}
