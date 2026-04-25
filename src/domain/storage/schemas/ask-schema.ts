/**
 * Ask Storage Schema
 *
 * Drizzle schema for the `asks` table (PostgreSQL only).
 * Follows the two-table pattern used by memories/knowledge (embeddings in separate table).
 * The asks table uses JSONB for payload/response/metadata to store discriminated unions.
 *
 * @see mt#1068 Ask entity spec
 * @see mt#1034 attention-allocation ADR (in-flight; ADR number TBD per mt#1291)
 */

import { pgTable, text, timestamp, pgEnum, index, uuid, jsonb } from "drizzle-orm/pg-core";
import type { AskPayload, AskResponse, TransportBinding } from "../../ask/types";

// ---------------------------------------------------------------------------
// Postgres enums
// ---------------------------------------------------------------------------

export const askKindEnum = pgEnum("ask_kind", [
  "capability.escalate",
  "direction.decide",
  "quality.review",
  "authorization.approve",
  "information.retrieve",
  "coordination.notify",
  "stuck.unblock",
]);

export const askStateEnum = pgEnum("ask_state", [
  "pending",
  "routed",
  "suspended",
  "responded",
  "closed",
]);

// ---------------------------------------------------------------------------
// Asks table
// ---------------------------------------------------------------------------

/**
 * Primary asks table.
 * Stores the domain entity (kind, state, payload, response, lifecycle timestamps).
 */
export const asksTable = pgTable(
  "asks",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Kind + classifier version for schema evolution
    kind: askKindEnum("kind").notNull(),
    classifierVersion: text("classifier_version").notNull().default("v1"),

    // State
    state: askStateEnum("state").notNull().default("pending"),

    // Identity / context
    /** AgentId of the requesting agent (opaque string, ADR-006 format) */
    requestor: text("requestor").notNull(),
    /** Serialized TransportBinding set by the router (mt#1069) */
    routingTarget: jsonb("routing_target").$type<TransportBinding>(),

    // Parent context
    parentTaskId: text("parent_task_id"),
    parentSessionId: text("parent_session_id"),

    // Content
    title: text("title").notNull(),
    question: text("question").notNull(),

    // Discriminated JSONB payload/response
    /** Per-kind payload — discriminated union keyed by `kind` */
    payload: jsonb("payload").$type<AskPayload>().notNull(),
    /** Per-kind response — null until the Ask is responded/closed */
    response: jsonb("response").$type<AskResponse>(),

    // Metadata + deadline
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    deadline: timestamp("deadline", { withTimezone: true }),

    // Lifecycle timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    routedAt: timestamp("routed_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    // Most common filter: list by state (operator surfaces)
    index("idx_asks_state").on(table.state),
    // List asks by parent task
    index("idx_asks_parent_task_id").on(table.parentTaskId),
    // List asks by parent session
    index("idx_asks_parent_session_id").on(table.parentSessionId),
    // Kind + classifierVersion for version-aware queries
    index("idx_asks_kind_classifier").on(table.kind, table.classifierVersion),
    // Requestor lookup
    index("idx_asks_requestor").on(table.requestor),
  ]
);

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------

export type AskRow = typeof asksTable.$inferSelect;
export type AskInsert = typeof asksTable.$inferInsert;
