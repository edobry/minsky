/**
 * Drizzle Schema for Session Records
 *
 * This module defines the database schema for session records using Drizzle ORM.
 * It supports both SQLite and PostgreSQL databases with identical schemas.
 */

import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pgTable, varchar, timestamp, text as pgText } from "drizzle-orm/pg-core";
import type { SessionRecord } from "../../session/session-db";

// SQLite Schema - MATCHING ACTUAL DATABASE COLUMNS
export const sqliteSessions = sqliteTable("sessions", {
  session: text("session")!.primaryKey(),
  repoName: text("repoName")!.notNull(), // Keep actual column name
  repoUrl: text("repoUrl")!.notNull(), // Keep actual column name
  createdAt: text("createdAt").notNull(), // Keep actual column name
  taskId: text("taskId"), // Keep actual column name
  branch: text("branch"),

  // PR-related fields (Task #332/#366) - these are correct snake_case
  prBranch: text("pr_branch"),
  prApproved: text("pr_approved"), // Store as JSON boolean string
  prState: text("pr_state"), // Store as JSON

  // Backend configuration - these are correct snake_case
  backendType: text("backend_type"),
  github: text("github"), // Store as JSON
  remote: text("remote"), // Store as JSON
  pullRequest: text("pull_request"), // Store as JSON
});

// PostgreSQL Schema
export const postgresSessions = pgTable("sessions", {
  session: varchar("session", { length: 255 })!.primaryKey(),
  repoName: varchar("repo_name", { length: 255 })!.notNull(),
  repoUrl: varchar("repo_url", { length: 1000 })!.notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  taskId: varchar("task_id", { length: 100 }),
  branch: varchar("branch", { length: 255 }),

  // PR-related fields (Task #332/#366)
  prBranch: varchar("pr_branch", { length: 255 }),
  prApproved: varchar("pr_approved", { length: 10 }), // Store as JSON boolean string
  prState: pgText("pr_state"), // Store as JSON

  // Backend configuration
  backendType: varchar("backend_type", { length: 50 }),
  github: pgText("github"), // Store as JSON
  remote: pgText("remote"), // Store as JSON
  pullRequest: pgText("pull_request"), // Store as JSON
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
    session: record!.session,
    repoName: record!.repoName,
    repoUrl: record!.repoUrl,
    createdAt: record.createdAt,
    taskId: record.taskId || null,
    branch: record.branch || null,

    // PR-related fields
    prBranch: record.prBranch || null,
    prApproved: record.prApproved ? JSON.stringify(record.prApproved) : null,
    prState: record.prState ? JSON.stringify(record.prState) : null,

    // Backend configuration
    backendType: record.backendType || null,
    github: record.github ? JSON.stringify(record.github) : null,
    remote: record.remote ? JSON.stringify(record.remote) : null,
    pullRequest: record.pullRequest ? JSON.stringify(record.pullRequest) : null,
  };
}

/**
 * Convert SQLite record to SessionRecord format
 * FIXED: Handle mixed camelCase (old) and snake_case (new) column names
 */
export function fromSqliteSelect(record: any): SessionRecord {
  return {
    session: record.session,
    repoName: record.repoName, // Direct access - camelCase column
    repoUrl: record.repoUrl, // Direct access - camelCase column
    createdAt: record.createdAt, // Direct access - camelCase column
    taskId: record.taskId || undefined, // Direct access - camelCase column
    branch: record.branch || undefined,

    // PR-related fields - these use snake_case columns (correct)
    prBranch: record.pr_branch || undefined,
    prApproved: record.pr_approved ? JSON.parse(record.pr_approved) : undefined,
    prState: record.pr_state ? JSON.parse(record.pr_state) : undefined,

    // Backend configuration - these use snake_case columns (correct)
    backendType: record.backend_type || undefined,
    github: record.github ? JSON.parse(record.github) : undefined,
    remote: record.remote ? JSON.parse(record.remote) : undefined,
    pullRequest: record.pull_request ? JSON.parse(record.pull_request) : undefined,
  };
}

/**
 * Convert SessionRecord to PostgreSQL insert format
 */
export function toPostgresInsert(record: SessionRecord): PostgresSessionInsert {
  return {
    session: record!.session,
    repoName: record!.repoName,
    repoUrl: record!.repoUrl,
    createdAt: new Date(record.createdAt),
    taskId: record.taskId || null,
    branch: record.branch || null,

    // PR-related fields
    prBranch: record.prBranch || null,
    prApproved: record.prApproved ? JSON.stringify(record.prApproved) : null,
    prState: record.prState ? JSON.stringify(record.prState) : null,

    // Backend configuration
    backendType: record.backendType || null,
    github: record.github ? JSON.stringify(record.github) : null,
    remote: record.remote ? JSON.stringify(record.remote) : null,
    pullRequest: record.pullRequest ? JSON.stringify(record.pullRequest) : null,
  };
}

/**
 * Convert PostgreSQL record to SessionRecord format
 */
export function fromPostgresSelect(record: PostgresSessionRecord): SessionRecord {
  return {
    session: record!.session,
    repoName: record!.repoName,
    repoUrl: record!.repoUrl,
    createdAt: record.createdAt.toISOString(),
    taskId: record.taskId || undefined,
    branch: record.branch || undefined,

    // PR-related fields
    prBranch: record.prBranch || undefined,
    prApproved: record.prApproved ? JSON.parse(record.prApproved) : undefined,
    prState: record.prState ? JSON.parse(record.prState) : undefined,

    // Backend configuration
    backendType: (record.backendType as any) || undefined,
    github: record.github ? JSON.parse(record.github) : undefined,
    remote: record.remote ? JSON.parse(record.remote) : undefined,
    pullRequest: record.pullRequest ? JSON.parse(record.pullRequest) : undefined,
  };
}
