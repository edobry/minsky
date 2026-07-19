/**
 * Cockpit scheduled-follow-up routes (mt#2322 — the "minimal surface to
 * create/list follow-ups" named in that task's Scope).
 *
 *   GET  /api/follow-ups           — list follow-ups (optional ?status= filter)
 *   POST /api/follow-ups           — create a follow-up
 *   POST /api/follow-ups/:id/cancel — cancel a pending follow-up
 *
 * The daemon's follow-up sweeper (`src/cockpit/sweepers.ts`'s
 * `startFollowUpSweeper`) picks up and fires due rows independently of these
 * routes — this module is only the read/write surface, mirroring the
 * separation between `routes/sweeps.ts` (liveness read) and the sweep loops
 * themselves.
 */
import type express from "express";
import type { FollowUpService } from "@minsky/domain/scheduler/follow-up-service";
import { FOLLOW_UP_STATUS_VALUES } from "@minsky/domain/storage/schemas/scheduled-follow-ups-schema";
import { getServerFollowUpService } from "../db-providers";

/** Options accepted by {@link mountFollowUpRoutes}. */
export interface FollowUpRoutesOptions {
  /** Override the FollowUpService used by every endpoint (used in tests). */
  followUpServiceOverride?: FollowUpService | null;
}

function isValidStatus(value: string): value is (typeof FOLLOW_UP_STATUS_VALUES)[number] {
  return (FOLLOW_UP_STATUS_VALUES as readonly string[]).includes(value);
}

/** Mount the /api/follow-ups* routes on `app`. */
export function mountFollowUpRoutes(app: express.Express, opts: FollowUpRoutesOptions = {}): void {
  const { followUpServiceOverride } = opts;

  const resolveService = async (): Promise<FollowUpService | null> =>
    followUpServiceOverride !== undefined ? followUpServiceOverride : getServerFollowUpService();

  /**
   * GET /api/follow-ups — list follow-ups, optionally filtered by status.
   *
   * Query: ?status=pending|fired|cancelled|failed (optional)
   * Returns: { followUps: ScheduledFollowUpRecord[], total: number }
   */
  app.get("/api/follow-ups", async (req, res) => {
    try {
      const service = await resolveService();
      if (!service) {
        res.status(503).json({
          error: "Follow-up service unavailable — persistence provider does not support SQL",
        });
        return;
      }

      const statusParam = req.query.status;
      if (statusParam !== undefined) {
        if (typeof statusParam !== "string" || !isValidStatus(statusParam)) {
          res.status(400).json({
            error: `Invalid status filter; expected one of: ${FOLLOW_UP_STATUS_VALUES.join(", ")}`,
          });
          return;
        }
      }

      const followUps = await service.list(
        typeof statusParam === "string" && isValidStatus(statusParam)
          ? { status: statusParam }
          : undefined
      );

      res.json({ followUps, total: followUps.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/follow-ups — create a scheduled follow-up.
   *
   * Body: { message: string, dueAt: string (ISO-8601), payload?: object,
   *         relatedTaskId?: string, relatedSessionId?: string }
   *
   * Trust-boundary guard: only these five fields are read from the request
   * body — nothing else (e.g. status, firedAt) is ever accepted from a
   * client, matching the pattern in `routes/asks.ts`'s resolve endpoint.
   */
  app.post("/api/follow-ups", async (req, res) => {
    try {
      const service = await resolveService();
      if (!service) {
        res.status(503).json({
          error: "Follow-up service unavailable — persistence provider does not support SQL",
        });
        return;
      }

      const body = req.body as {
        message?: unknown;
        dueAt?: unknown;
        payload?: unknown;
        relatedTaskId?: unknown;
        relatedSessionId?: unknown;
      };

      if (typeof body.message !== "string" || body.message.trim().length === 0) {
        res.status(400).json({ error: "message is required and must be a non-empty string" });
        return;
      }
      if (typeof body.dueAt !== "string" || Number.isNaN(new Date(body.dueAt).getTime())) {
        res.status(400).json({ error: "dueAt is required and must be a valid ISO-8601 string" });
        return;
      }

      const followUp = await service.create({
        message: body.message,
        dueAt: body.dueAt,
        payload:
          body.payload && typeof body.payload === "object"
            ? (body.payload as Record<string, unknown>)
            : undefined,
        relatedTaskId: typeof body.relatedTaskId === "string" ? body.relatedTaskId : undefined,
        relatedSessionId:
          typeof body.relatedSessionId === "string" ? body.relatedSessionId : undefined,
      });

      res.status(201).json({ followUp });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /**
   * POST /api/follow-ups/:id/cancel — cancel a pending follow-up.
   *
   * Returns 200 on success, 404 if the id does not exist or is no longer
   * pending (already fired/cancelled/failed) — `FollowUpService.cancel` is a
   * status-guarded UPDATE, so both cases collapse to "0 rows affected" and
   * are reported identically (matching the read surface's own inability to
   * distinguish them without a second lookup).
   */
  app.post("/api/follow-ups/:id/cancel", async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "Follow-up ID required" });
      return;
    }
    try {
      const service = await resolveService();
      if (!service) {
        res.status(503).json({
          error: "Follow-up service unavailable — persistence provider does not support SQL",
        });
        return;
      }

      const cancelled = await service.cancel(id);
      if (!cancelled) {
        res.status(404).json({
          error: `Follow-up ${id} not found or no longer pending`,
        });
        return;
      }

      res.json({ ok: true, id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });
}
