/**
 * Drizzle Schema for Session Records
 *
 * This module defines the database schema for session records using Drizzle ORM.
 * It supports both SQLite and PostgreSQL databases with identical schemas.
 */

import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pgTable, varchar, timestamp, text as pgText } from "drizzle-orm/pg-core";
import type { SessionRecord } from "../../session/session-db";

// SQLite Schema - CONSISTENT snake_case FOR ALL COLUMNS
export const sqliteSessions = sqliteTable("sessions", {
  session: text("session")!.primaryKey(),
  repoName: text("repo_name")!.notNull(), // Use snake_case consistently
  repoUrl: text("repo_url")!.notNull(), // Use snake_case consistently
  createdAt: text("created_at").notNull(), // Use snake_case consistently
  taskId: text("task_id"), // Use snake_case consistently
  branch: text("branch"),

  // PR-related fields - snake_case (consistent)
  prBranch: text("pr_branch"),
  prApproved: text("pr_approved"), // Store as JSON boolean string
  prState: text("pr_state"), // Store as JSON

  // Backend configuration - snake_case (consistent)
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
 * FIXED: Consistent snake_case database columns to camelCase TypeScript fields
 */
export function fromSqliteSelect(record: any): SessionRecord {
  return {
    session: record.session,
    repoName: record.repo_name, // snake_case DB → camelCase TS
    repoUrl: record.repo_url, // snake_case DB → camelCase TS
    createdAt: record.created_at, // snake_case DB → camelCase TS
    taskId: record.task_id || undefined, // snake_case DB → camelCase TS
    branch: record.branch || undefined,

    // PR-related fields - snake_case DB → camelCase TS
    prBranch: record.pr_branch || undefined,
    prApproved: record.pr_approved ? JSON.parse(record.pr_approved) : undefined,
    prState: record.pr_state ? JSON.parse(record.pr_state) : undefined,

    // Backend configuration - snake_case DB → camelCase TS
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
