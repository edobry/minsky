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
  timestamp,
  text as pgText,
  integer as pgInteger,
} from "drizzle-orm/pg-core";
import type { SessionRecord, PullRequestInfo } from "../../session/session-db";

// SQLite Schema - Match existing database structure (camelCase column names)
export const sqliteSessions = sqliteTable("sessions", {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  session: text("session")!.primaryKey(),
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  repoName: text("repoName")!.notNull(),
  repoUrl: text("repoUrl"),
  createdAt: text("createdAt").notNull(),
  taskId: text("taskId"),

  // Legacy column (keeping for compatibility)
  repoPath: text("repoPath"),

  // PR-related fields with automatic JSON parsing (will be added via migration)
  prBranch: text("prBranch"),
  prApproved: text("prApproved", { mode: "json" }).$type<boolean>(),
  prState: text("prState", { mode: "json" }).$type<NonNullable<SessionRecord["prState"]>>(),

  // Backend configuration with automatic JSON parsing (will be added via migration)
  backendType: text("backendType"),
  pullRequest: text("pullRequest", { mode: "json" }).$type<PullRequestInfo>(),

  // Session liveness tracking fields (will be added via migration)
  lastActivityAt: text("last_activity_at"),
  lastCommitHash: text("last_commit_hash"),
  lastCommitMessage: text("last_commit_message"),
  commitCount: integer("commit_count"),
  status: text("status"),
  agentId: text("agent_id"),
});

// PostgreSQL Schema
export const postgresSessions = pgTable("sessions", {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  session: varchar("session", { length: 255 })!.primaryKey(),
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  repoName: varchar("repo_name", { length: 255 })!.notNull(),
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  repoUrl: varchar("repo_url", { length: 1000 })!.notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  taskId: varchar("task_id", { length: 100 }),

  // PR-related fields (Task #332/#366)
  prBranch: varchar("pr_branch", { length: 255 }),
  prApproved: varchar("pr_approved", { length: 10 }), // Store as JSON boolean string
  prState: pgText("pr_state"), // Store as JSON

  // Backend configuration
  backendType: varchar("backend_type", { length: 50 }),
  pullRequest: pgText("pull_request"), // Store as JSON

  // Session liveness tracking fields
  lastActivityAt: pgText("last_activity_at"),
  lastCommitHash: pgText("last_commit_hash"),
  lastCommitMessage: pgText("last_commit_message"),
  commitCount: pgInteger("commit_count"),
  status: pgText("status"),
  agentId: pgText("agent_id"),
});

// Type exports for better type inference
export type SqliteSessionRecord = typeof sqliteSessions.$inferSelect;
export type SqliteSessionInsert = typeof sqliteSessions.$inferInsert;
export type PostgresSessionRecord = typeof postgresSessions.$inferSelect;
export type PostgresSessionInsert = typeof postgresSessions.$inferInsert;

/**
 * Coerce various date representations into a valid Date.
 * Falls back to current time if parsing fails.
 */
function coerceToDate(input: unknown): Date {
  if (input instanceof Date && !isNaN(input.getTime())) return input;
  if (typeof input === "number") {
    const ms = input < 1e12 ? input * 1000 : input;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? new Date() : d;
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return new Date();
    // Handle common "YYYY-MM-DD HH:MM:SS" format by converting to ISO
    const sqlLike = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    const candidate = sqlLike.test(trimmed) ? `${trimmed.replace(" ", "T")}Z` : trimmed;
    const d = new Date(candidate);
    if (!isNaN(d.getTime())) return d;
    // Numeric string fallback
    const asNum = Number(trimmed);
    if (!Number.isNaN(asNum)) {
      const ms = asNum < 1e12 ? asNum * 1000 : asNum;
      const d2 = new Date(ms);
      return isNaN(d2.getTime()) ? new Date() : d2;
    }
  }
  return new Date();
}

/**
 * Convert SessionRecord to SQLite insert format
 * Drizzle handles JSON serialization automatically for json mode columns
 */
export function toSqliteInsert(record: SessionRecord): SqliteSessionInsert {
  return {
    session: record.session,
    repoName: record.repoName,
    repoUrl: record.repoUrl,
    createdAt: record.createdAt,
    taskId: record.taskId || null,

    // JSON fields - Drizzle handles serialization automatically
    prBranch: record.prBranch || null,
    prApproved: record.prApproved || null,
    prState: record.prState || null,

    // Backend configuration - Drizzle handles JSON serialization
    backendType: record.backendType || null,
    pullRequest: record.pullRequest || null,

    // Session liveness tracking fields
    lastActivityAt: record.lastActivityAt || null,
    lastCommitHash: record.lastCommitHash || null,
    lastCommitMessage: record.lastCommitMessage || null,
    commitCount: record.commitCount ?? null,
    status: record.status || null,
    agentId: record.agentId || null,
  };
}

// fromSqliteSelect is NO LONGER NEEDED!
// Drizzle automatically handles JSON parsing and field mapping.

/**
 * Convert SessionRecord to PostgreSQL insert format
 */
export function toPostgresInsert(record: SessionRecord): PostgresSessionInsert {
  return {
    session: record.session,
    repoName: record.repoName,
    repoUrl: record.repoUrl || "",
    createdAt: coerceToDate(record.createdAt),
    taskId: record.taskId || null,

    // PR-related fields
    prBranch: record.prBranch || null,
    prApproved: record.prApproved ? JSON.stringify(record.prApproved) : null,
    prState: record.prState ? JSON.stringify(record.prState) : null,

    // Backend configuration
    backendType: record.backendType || null,
    pullRequest: record.pullRequest ? JSON.stringify(record.pullRequest) : null,

    // Session liveness tracking fields
    lastActivityAt: record.lastActivityAt || null,
    lastCommitHash: record.lastCommitHash || null,
    lastCommitMessage: record.lastCommitMessage || null,
    commitCount: record.commitCount ?? null,
    status: record.status || null,
    agentId: record.agentId || null,
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
    taskId: record.taskId || undefined,

    // PR-related fields
    prBranch: record.prBranch || undefined,
    prApproved: record.prApproved ? JSON.parse(record.prApproved) : undefined,
    prState: record.prState ? JSON.parse(record.prState) : undefined,

    // Backend configuration
    backendType: (record.backendType || undefined) as "github" | undefined,
    pullRequest: record.pullRequest ? JSON.parse(record.pullRequest) : undefined,

    // Session liveness tracking fields
    lastActivityAt: record.lastActivityAt || undefined,
    lastCommitHash: record.lastCommitHash || undefined,
    lastCommitMessage: record.lastCommitMessage || undefined,
    commitCount: record.commitCount ?? undefined,
    status: (record.status || undefined) as import("../../session/types").SessionStatus | undefined,
    agentId: record.agentId || undefined,
  };
}
