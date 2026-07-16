/**
 * Shared Events Commands
 *
 * Surfaces the system_events table at the CLI/MCP layer.
 *
 * - `events.list`  — read events with optional filters (eventType, since, until,
 *                    relatedTaskId, limit). Read-only inspection of the activity feed.
 * - `events.emit`  — write an event. The remote emission surface for the adoption
 *                    sweeper (runs in services/reviewer/, no direct Postgres access)
 *                    and any other out-of-process producer.
 *
 * @see mt#2092 — Event log Phase 1a
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory, defineCommand } from "../command-registry";
import { log } from "@minsky/shared/logger";
import {
  SYSTEM_EVENT_TYPE_VALUES,
  EVENT_CATEGORY_VALUES,
  type SystemEventType,
  type EventCategory,
  type SystemEvent,
} from "@minsky/domain/storage/schemas/system-events-schema";
import { listEvents, countEvents } from "@minsky/domain/events/query";
import { DrizzleEventEmitter } from "@minsky/domain/events/emitter";
import type { SystemEventInput } from "@minsky/domain/events/emitter";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";

// ---------------------------------------------------------------------------
// DB connection helper (mirrors asks.ts pattern)
// ---------------------------------------------------------------------------

/**
 * Resolve a Drizzle DB connection from the DI container.
 * Returns null when the provider does not support SQL capability or when no
 * DB connection is available.
 */
async function getDb(
  container: AppContainerInterface | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  if (!container?.has("persistence")) return null;
  try {
    const persistenceProvider = container.get("persistence") as SqlCapablePersistenceProvider;
    if (!persistenceProvider.getDatabaseConnection) return null;
    const db = await persistenceProvider.getDatabaseConnection();
    return db ?? null;
  } catch (err: unknown) {
    log.warn("events: could not resolve DB connection", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// events.list
// ---------------------------------------------------------------------------

const eventsListParams = {
  eventType: {
    schema: z
      .enum([...SYSTEM_EVENT_TYPE_VALUES] as [SystemEventType, ...SystemEventType[]])
      .optional(),
    description: `Filter by event type (${SYSTEM_EVENT_TYPE_VALUES.join(" | ")})`,
    required: false,
  },
  category: {
    schema: z.enum([...EVENT_CATEGORY_VALUES] as [EventCategory, ...EventCategory[]]).optional(),
    description: `Filter by category (${EVENT_CATEGORY_VALUES.join(
      " | "
    )}) — the activity feed defaults to 'actionable'`,
    required: false,
  },
  since: {
    schema: z.string().optional(),
    description: "Lower bound (inclusive) — ISO-8601 timestamp",
    required: false,
  },
  until: {
    schema: z.string().optional(),
    description: "Upper bound (inclusive) — ISO-8601 timestamp",
    required: false,
  },
  relatedTaskId: {
    schema: z.string().optional(),
    description: "Filter by related task ID (e.g. mt#123)",
    required: false,
  },
  limit: {
    schema: z.number().int().positive(),
    description: "Maximum number of results (default: 50, max: 500)",
    required: false,
    defaultValue: 50,
  },
};

interface EventsListResult {
  events: SystemEvent[];
  /**
   * True count of everything matching the filters, BEFORE the SQL-level
   * `limit` (mt#2817 — previously this field was `events.length`, i.e. the
   * post-limit count mislabeled as "total"; a caller could not tell whether
   * a full page meant "that's everything" or "there's more past the cap").
   */
  total: number;
  limit: number;
  /** Number of events actually returned in `events` (mt#2817). */
  returned: number;
  /** `returned < total` — true when this payload does NOT contain every match (mt#2817). */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// events.emit
// ---------------------------------------------------------------------------

const eventsEmitParams = {
  eventType: {
    schema: z.enum([...SYSTEM_EVENT_TYPE_VALUES] as [SystemEventType, ...SystemEventType[]]),
    description: `Event type (one of: ${SYSTEM_EVENT_TYPE_VALUES.join(", ")})`,
    required: true,
  },
  payload: {
    schema: z.record(z.string(), z.unknown()),
    description: "Structured event payload — shape varies by event type",
    required: true,
  },
  actor: {
    schema: z.string().optional(),
    description: "Who emitted the event (AgentId or human-readable identifier)",
    required: false,
  },
  relatedTaskId: {
    schema: z.string().optional(),
    description: "Related Minsky task ID (e.g. mt#123)",
    required: false,
  },
  relatedSessionId: {
    schema: z.string().optional(),
    description: "Related Minsky session ID",
    required: false,
  },
};

interface EventsEmitResult {
  success: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the events commands in the shared command registry.
 *
 * @param container Optional DI container — when provided, commands resolve
 *   the persistence provider from it to access the DB connection.
 */
export function registerEventsCommands(container?: AppContainerInterface): void {
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "events.list",
      category: CommandCategory.EVENTS,
      name: "list",
      description: "List system events with optional filters (event type, time range, task ID)",
      requiresSetup: true,
      parameters: eventsListParams,
      execute: async (params): Promise<EventsListResult> => {
        const db = await getDb(container);
        if (!db) {
          log.warn("events.list: DB connection unavailable — returning empty results");
          return {
            events: [],
            total: 0,
            limit: (params.limit as number | undefined) ?? 50,
            returned: 0,
            truncated: false,
          };
        }

        const filterOptions = {
          eventType: params.eventType as SystemEventType | undefined,
          category: params.category as EventCategory | undefined,
          since: params.since as string | undefined,
          until: params.until as string | undefined,
          relatedTaskId: params.relatedTaskId as string | undefined,
        };

        // mt#2817: fetch the page AND the true total (same filters, no limit)
        // in parallel so `total` reflects everything matching, not just what
        // fit under the SQL-level cap.
        const [events, total] = await Promise.all([
          listEvents(db, { ...filterOptions, limit: params.limit as number | undefined }),
          countEvents(db, filterOptions),
        ]);

        const limit = (params.limit as number | undefined) ?? 50;

        return {
          events,
          total,
          limit,
          returned: events.length,
          truncated: events.length < total,
        };
      },
    })
  );

  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "events.emit",
      category: CommandCategory.EVENTS,
      name: "emit",
      description:
        "Emit a system event — remote emission surface for the adoption sweeper and other out-of-process producers",
      requiresSetup: true,
      parameters: eventsEmitParams,
      execute: async (params): Promise<EventsEmitResult> => {
        const db = await getDb(container);
        if (!db) {
          log.warn("events.emit: DB connection unavailable — event silently dropped (best-effort)");
          return {
            success: false,
            message:
              "events.emit: DB connection unavailable — event silently dropped (best-effort)",
          };
        }

        const emitter = new DrizzleEventEmitter(db);

        const input: SystemEventInput = {
          eventType: params.eventType as SystemEventType,
          payload: params.payload as Record<string, unknown>,
          actor: params.actor as string | undefined,
          relatedTaskId: params.relatedTaskId as string | undefined,
          relatedSessionId: params.relatedSessionId as string | undefined,
        };

        await emitter.emit(input);

        return {
          success: true,
          message: `Event '${input.eventType}' emitted successfully`,
        };
      },
    })
  );
}
