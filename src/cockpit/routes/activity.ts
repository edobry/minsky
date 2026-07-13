/**
 * Cockpit activity-feed route (mt#2615 — extracted from server.ts).
 *
 *   GET /api/activity — list system events for the activity feed (mt#2092)
 */
import type express from "express";
import { getContextInspectorDb } from "../db-providers";

/** Mount /api/activity on `app`. */
export function mountActivityRoutes(app: express.Express): void {
  /**
   * GET /api/activity — list system events for the activity feed (mt#2092)
   *
   * Query params (mt#2340):
   *   - eventType: filter by a single event type. Must be a valid
   *                SystemEventType; an invalid value is a 400.
   *   - category:  filter by category — `actionable` or `informational`.
   *                Omit the param entirely to include ALL categories (the
   *                client drops it rather than sending a sentinel). An invalid
   *                value is a 400 (no `all` sentinel; strict at the boundary
   *                so a typo can't silently produce an empty `IN ()` filter).
   *   - since:     ISO-8601 inclusive lower bound on `created_at`. Invalid
   *                (unparseable) values are a 400 (mt#2600 — time-scrubber
   *                replay window). The domain `listEvents` already supports
   *                this filter; this route only adds boundary validation.
   *   - until:     ISO-8601 inclusive upper bound on `created_at`. Same
   *                validation as `since` (mt#2600).
   *   - limit:     max results (default 100, max 500)
   *
   * Returns: { events: SystemEvent[], total: number, limit: number }
   */
  app.get("/api/activity", async (req, res) => {
    try {
      const db = await getContextInspectorDb();
      if (!db) {
        res.status(503).json({
          error: "DB unavailable — persistence provider does not support SQL",
        });
        return;
      }

      const { listEvents } = await import("@minsky/domain/events/query");
      const { SYSTEM_EVENT_TYPE_VALUES, EVENT_CATEGORY_VALUES } = await import(
        "@minsky/domain/storage/schemas/system-events-schema"
      );
      type SystemEventType =
        import("@minsky/domain/storage/schemas/system-events-schema").SystemEventType;
      type EventCategory =
        import("@minsky/domain/storage/schemas/system-events-schema").EventCategory;

      // Validate filter params strictly at the trust boundary. Invalid values
      // are rejected with 400 rather than cast through — a bogus `category`
      // would otherwise resolve to an empty `WHERE event_type IN ()` and
      // silently return zero rows (mt#2340 R1 review).
      const rawEventType = req.query["eventType"];
      let eventType: SystemEventType | undefined;
      if (typeof rawEventType === "string") {
        if (!(SYSTEM_EVENT_TYPE_VALUES as readonly string[]).includes(rawEventType)) {
          res.status(400).json({
            error: `Invalid eventType '${rawEventType}'. Valid values: ${SYSTEM_EVENT_TYPE_VALUES.join(", ")}`,
          });
          return;
        }
        eventType = rawEventType as SystemEventType;
      }

      const rawCategory = req.query["category"];
      let category: EventCategory | undefined;
      if (typeof rawCategory === "string") {
        if (!(EVENT_CATEGORY_VALUES as readonly string[]).includes(rawCategory)) {
          res.status(400).json({
            error: `Invalid category '${rawCategory}'. Valid values: ${EVENT_CATEGORY_VALUES.join(", ")} (omit the param for all categories)`,
          });
          return;
        }
        category = rawCategory as EventCategory;
      }

      // since/until (mt#2600 — time-scrubber replay window). Validated at the
      // boundary the same way eventType/category are: an unparseable value is
      // a 400 rather than silently falling through to `new Date(NaN)`, which
      // Drizzle would otherwise happily serialize as "Invalid Date" and the
      // query would run with a nonsensical bound instead of failing loudly.
      let since: string | undefined;
      const rawSince = req.query["since"];
      if (typeof rawSince === "string") {
        if (isNaN(Date.parse(rawSince))) {
          res.status(400).json({ error: `Invalid since '${rawSince}' — must be ISO-8601` });
          return;
        }
        since = rawSince;
      }

      let until: string | undefined;
      const rawUntil = req.query["until"];
      if (typeof rawUntil === "string") {
        if (isNaN(Date.parse(rawUntil))) {
          res.status(400).json({ error: `Invalid until '${rawUntil}' — must be ISO-8601` });
          return;
        }
        until = rawUntil;
      }

      const limitParam =
        typeof req.query["limit"] === "string" ? parseInt(req.query["limit"], 10) : 100;
      const limit = isNaN(limitParam) ? 100 : Math.min(Math.max(limitParam, 1), 500);

      const events = await listEvents(db, { eventType, category, since, until, limit });

      res.json({ events, total: events.length, limit });
    } catch (err: unknown) {
      res.status(500).json({
        error: `Failed to list events: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}
