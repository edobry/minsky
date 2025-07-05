/**
 * Drizzle Schema for Session Records
 *
 * This module defines the database schema for session records using Drizzle ORM.
 * It supports both SQLite and PostgreSQL databases with identical schemas.
 */

import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  pgTable,
  varchar,
  timestamp,
} from "drizzle-orm/pg-core";
import type { SessionRecord } from "../../session/session-db";

// SQLite Schema
export const sqliteSessions = sqliteTable("sessions", {
  session: text("session").primaryKey(),
  repoName: text("repo_name").notNull(),
  repoUrl: text("repo_url").notNull(),
  createdAt: text("created_at").notNull(),
  taskId: text("task_id").notNull(),
  branch: text("branch").notNull(),
});

// PostgreSQL Schema
export const postgresSessions = pgTable("sessions", {
  session: varchar("session", { length: 255 }).primaryKey(),
  repoName: varchar("repo_name", { length: 255 }).notNull(),
  repoUrl: varchar("repo_url", { length: 1000 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  taskId: varchar("task_id", { length: 100 }).notNull(),
  branch: varchar("branch", { length: 255 }).notNull(),
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
    session: record.session,
    repoName: record.repoName,
    repoUrl: record.repoUrl,
    createdAt: record.createdAt,
    taskId: record.taskId,
    branch: record.branch,
  };
}

/**
 * Convert SQLite record to SessionRecord format
 */
export function fromSqliteSelect(record: SqliteSessionRecord): SessionRecord {
  return {
    session: record.session,
    repoName: record.repoName,
    repoUrl: record.repoUrl,
    createdAt: record.createdAt,
    taskId: record.taskId,
    branch: record.branch,
  };
}

/**
 * Convert SessionRecord to PostgreSQL insert format
 */
export function toPostgresInsert(record: SessionRecord): PostgresSessionInsert {
  return {
    session: record.session,
    repoName: record.repoName,
    repoUrl: record.repoUrl,
    createdAt: new Date(record.createdAt),
    taskId: record.taskId,
    branch: record.branch,
  };
}

/**
 * Convert PostgreSQL record to SessionRecord format
 */
export function fromPostgresSelect(record: PostgresSessionRecord): SessionRecord {
  return {
    session: record.session,
    repoName: record.repoName,
    repoUrl: record.repoUrl,
    createdAt: record.createdAt.toISOString(),
    taskId: record.taskId,
    branch: record.branch,
  };
}
