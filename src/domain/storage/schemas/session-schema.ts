/**
 * Drizzle Schema for Session Records
 *
 * This module defines the database schema for session records using Drizzle ORM.
 * It supports both SQLite and PostgreSQL databases with identical schemas.
 */

import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pgTable, varchar, timestamp, text as pgText } from "drizzle-orm/pg-core";
import type { SessionRecord } from "../../session/session-db";

// SQLite Schema - CONSISTENT snake_case with Drizzle JSON support
export const sqliteSessions = sqliteTable("sessions", {
  session: text("session")!.primaryKey(),
  repoName: text("repo_name")!.notNull(),
  repoUrl: text("repo_url")!.notNull(),
  createdAt: text("created_at").notNull(),
  taskId: text("task_id"),
  branch: text("branch"),

  // PR-related fields with automatic JSON parsing
  prBranch: text("pr_branch"),
  prApproved: text("pr_approved", { mode: "json" }).$type<boolean>(),
  prState: text("pr_state", { mode: "json" }).$type<{
    branchName: string;
    exists: boolean;
    lastChecked: string;
    createdAt: string;
    mergedAt?: string;
    commitHash?: string;
  }>(),

  // Backend configuration with automatic JSON parsing
  backendType: text("backend_type"),
  pullRequest: text("pull_request", { mode: "json" }).$type<any>(),
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
  pullRequest: pgText("pull_request"), // Store as JSON
});

// Type exports for better type inference
export type SqliteSessionRecord = typeof sqliteSessions.$inferSelect;
export type SqliteSessionInsert = typeof sqliteSessions.$inferInsert;
export type PostgresSessionRecord = typeof postgresSessions.$inferSelect;
export type PostgresSessionInsert = typeof postgresSessions.$inferInsert;

/**
 * Convert SessionRecord to SQLite insert format
 * Drizzle handles JSON serialization automatically for json mode columns
 */
export function toSqliteInsert(record: SessionRecord): SqliteSessionInsert {
  return {
    session: record!.session,
    repoName: record!.repoName,
    repoUrl: record!.repoUrl,
    createdAt: record.createdAt,
    taskId: record.taskId || null,
    branch: record.branch || null,

    // JSON fields - Drizzle handles serialization automatically
    prBranch: record.prBranch || null,
    prApproved: record.prApproved || null,
    prState: record.prState || null,

    // Backend configuration - Drizzle handles JSON serialization
    backendType: record.backendType || null,
    pullRequest: record.pullRequest || null,
  };
}

// fromSqliteSelect is NO LONGER NEEDED!
// Drizzle automatically handles JSON parsing and field mapping.

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
