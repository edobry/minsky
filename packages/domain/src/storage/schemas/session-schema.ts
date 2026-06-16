/**
 * Drizzle Schema for Session Records
 *
 * This module defines the PostgreSQL schema for session records using Drizzle
 * ORM. Sessions are Postgres-only (ADR-018); the former SQLite session schema
 * was retired with the DatabaseStorage layer (mt#2329).
 */

import {
  pgTable,
  varchar,
  timestamp,
  text as pgText,
  integer as pgInteger,
  uuid,
} from "drizzle-orm/pg-core";
import type { SessionRecord } from "../../session/session-db";

// PostgreSQL Schema
export const postgresSessions = pgTable("sessions", {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  sessionId: varchar("session", { length: 255 })!.primaryKey(),
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

  // Project scoping (mt#2415, Phase 1.2). Nullable; backfilled to the Minsky
  // project; NOT NULL deferred to Phase 1.3 (mt#2416). projects.repo_url is
  // canonical; repo_name/repo_url here stay as a denormalized cache.
  // Plain uuid column — no DB-level FK per project convention (ask-schema.ts).
  projectId: uuid("project_id"),
});

// Type exports for better type inference
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
 * Convert SessionRecord to PostgreSQL insert format
 */
export function toPostgresInsert(record: SessionRecord): PostgresSessionInsert {
  return {
    sessionId: record.sessionId,
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
    sessionId: record.sessionId,
    repoName: record.repoName,
    repoUrl: record.repoUrl,
    createdAt: record.createdAt.toISOString(),
    taskId: record.taskId || undefined,

    // PR-related fields
    prBranch: record.prBranch || undefined,
    prApproved: record.prApproved ? JSON.parse(record.prApproved) : undefined,
    prState: record.prState ? JSON.parse(record.prState) : undefined,

    // Backend configuration
    backendType: (record.backendType || undefined) as SessionRecord["backendType"],
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
