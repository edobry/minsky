/**
 * Events query service — read path for the system_events table.
 *
 * Provides `listEvents` with optional filtering by event type, time range,
 * and related task ID. Default limit is 50; maximum is 500.
 *
 * @see mt#2092 — Event log Phase 1a
 */

import { and, desc, eq, gte, lte, inArray, isNotNull, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  systemEventsTable,
  eventTypesForCategory,
  type SystemEventRecord,
  type SystemEventType,
  type EventCategory,
  type SystemEvent,
} from "../storage/schemas/system-events-schema";

// ---------------------------------------------------------------------------
// Row → domain mapping
// ---------------------------------------------------------------------------

/**
 * Map a raw Drizzle row (`SystemEventRecord`) to the typed domain `SystemEvent`.
 *
 * Timestamps stored as `Date` in Drizzle are converted to ISO-8601 strings
 * to match the `SystemEvent` interface.
 */
function toSystemEvent(row: SystemEventRecord): SystemEvent {
  return {
    id: row.id,
    eventType: row.eventType,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    actor: row.actor ?? undefined,
    relatedTaskId: row.relatedTaskId ?? undefined,
    relatedSessionId: row.relatedSessionId ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Query options
// ---------------------------------------------------------------------------

export interface ListEventsOptions {
  /** Filter by event type. */
  eventType?: SystemEventType;
  /**
   * Filter by category (read-side classification, mt#2340). Resolves to a
   * `WHERE event_type IN (...)` over the category's member types. When both
   * `category` and `eventType` are set, `eventType` is the narrower filter and
   * both apply (AND); an `eventType` outside the category yields no rows.
   */
  category?: EventCategory;
  /** Lower bound (inclusive) — ISO-8601 string. */
  since?: string;
  /** Upper bound (inclusive) — ISO-8601 string. */
  until?: string;
  /** Filter by related task ID. */
  relatedTaskId?: string;
  /** Maximum number of results (default: 50, max: 500). */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Query function
// ---------------------------------------------------------------------------

/**
 * List system events with optional filters.
 *
 * Results are ordered by `created_at` DESC (most recent first).
 * Default limit is 50; maximum is 500.
 */
export async function listEvents(
  db: PostgresJsDatabase,
  options: ListEventsOptions = {}
): Promise<SystemEvent[]> {
  const limit = Math.min(options.limit ?? 50, 500);

  // Build WHERE clauses
  const conditions: SQL[] = [];

  if (options.eventType !== undefined) {
    conditions.push(eq(systemEventsTable.eventType, options.eventType));
  }

  if (options.category !== undefined) {
    // Generated WHERE event_type IN (...) from the code-side category map.
    // At v1 volume the existing event_type index covers this; no composite
    // index needed (RFC defers that to post-50K-rows).
    conditions.push(inArray(systemEventsTable.eventType, eventTypesForCategory(options.category)));
  }

  if (options.since !== undefined) {
    conditions.push(gte(systemEventsTable.createdAt, new Date(options.since)));
  }

  if (options.until !== undefined) {
    conditions.push(lte(systemEventsTable.createdAt, new Date(options.until)));
  }

  if (options.relatedTaskId !== undefined) {
    conditions.push(isNotNull(systemEventsTable.relatedTaskId));
    conditions.push(eq(systemEventsTable.relatedTaskId, options.relatedTaskId));
  }

  const query = db
    .select()
    .from(systemEventsTable)
    .orderBy(desc(systemEventsTable.createdAt))
    .limit(limit);

  const rows =
    conditions.length > 0
      ? await query.where(conditions.length === 1 ? conditions[0] : and(...conditions))
      : await query;

  return rows.map(toSystemEvent);
}
