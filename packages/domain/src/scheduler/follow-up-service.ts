import { and, asc, eq, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  scheduledFollowUpsTable,
  type ScheduledFollowUpRecord,
  type FollowUpStatus,
} from "../storage/schemas/scheduled-follow-ups-schema";

/**
 * FollowUpService — domain service for the scheduled-follow-up primitive
 * (mt#2322, the remaining scope of parent mt#2234).
 *
 * A follow-up is created with a message + `dueAt`; `fireDue()` is the sweep
 * tick body (see `src/cockpit/sweepers.ts`'s `startFollowUpSweeper`) that
 * finds every `pending` row whose `dueAt` has passed and flips it to `fired`.
 * Idempotent by construction: `fireDue()` only touches rows still in
 * `pending` status via a status-guarded UPDATE, so re-running it (the next
 * sweep tick, an overlapping call) never re-fires an already-fired row.
 */
export class FollowUpService {
  constructor(private readonly db: PostgresJsDatabase<Record<string, unknown>>) {}

  /** Create a new pending follow-up. Throws on an unparsable `dueAt`. */
  async create(input: CreateFollowUpInput): Promise<ScheduledFollowUpRecord> {
    const dueAt = input.dueAt instanceof Date ? input.dueAt : new Date(input.dueAt);
    if (Number.isNaN(dueAt.getTime())) {
      throw new Error(`FollowUpService.create: invalid dueAt "${String(input.dueAt)}"`);
    }
    if (!input.message || input.message.trim().length === 0) {
      throw new Error("FollowUpService.create: message must be non-empty");
    }

    const [row] = await this.db
      .insert(scheduledFollowUpsTable)
      .values({
        message: input.message,
        payload: input.payload ?? {},
        dueAt,
        relatedTaskId: input.relatedTaskId,
        relatedSessionId: input.relatedSessionId,
      })
      .returning();

    if (!row) {
      throw new Error("FollowUpService.create: insert returned no row");
    }
    return row;
  }

  /** List follow-ups, optionally filtered by status, ordered by due time ascending. */
  async list(opts?: { status?: FollowUpStatus }): Promise<ScheduledFollowUpRecord[]> {
    const base = this.db.select().from(scheduledFollowUpsTable);
    if (opts?.status) {
      return base
        .where(eq(scheduledFollowUpsTable.status, opts.status))
        .orderBy(asc(scheduledFollowUpsTable.dueAt));
    }
    return base.orderBy(asc(scheduledFollowUpsTable.dueAt));
  }

  /**
   * Cancel a pending follow-up. Returns `false` (no-op) if the row does not
   * exist or is no longer `pending` (already fired/cancelled/failed) — a
   * status-guarded UPDATE, same pattern as `fireDue`.
   */
  async cancel(id: string): Promise<boolean> {
    const result = await this.db
      .update(scheduledFollowUpsTable)
      .set({ status: "cancelled" })
      .where(and(eq(scheduledFollowUpsTable.id, id), eq(scheduledFollowUpsTable.status, "pending")))
      .returning({ id: scheduledFollowUpsTable.id });
    return result.length > 0;
  }

  /**
   * Find every `pending` follow-up whose `dueAt` has passed as of `now` and
   * fire it (status -> "fired", `firedAt` set). This is the sweep tick body.
   *
   * Per-row status-guarded UPDATE keeps this idempotent under overlap: two
   * concurrent calls (or a re-run after a partial failure) can only ever
   * transition a given row out of `pending` once — the second call's guarded
   * UPDATE affects 0 rows for anything already moved.
   *
   * A row whose firing UPDATE itself throws (should be rare — a status flip,
   * not an external call) is marked `failed` with `lastError` set, and is
   * reported in `errored` rather than silently dropped, so the caller's
   * observability layer (the sweep's tracker/log) sees it.
   */
  async fireDue(now: Date = new Date()): Promise<FollowUpFireResult> {
    const due = await this.db
      .select()
      .from(scheduledFollowUpsTable)
      .where(
        and(eq(scheduledFollowUpsTable.status, "pending"), lte(scheduledFollowUpsTable.dueAt, now))
      );

    const fired: ScheduledFollowUpRecord[] = [];
    const errored: Array<{ id: string; error: string }> = [];

    for (const row of due) {
      try {
        const [updated] = await this.db
          .update(scheduledFollowUpsTable)
          .set({ status: "fired", firedAt: now })
          .where(
            and(
              eq(scheduledFollowUpsTable.id, row.id),
              eq(scheduledFollowUpsTable.status, "pending")
            )
          )
          .returning();
        if (updated) fired.push(updated);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errored.push({ id: row.id, error: message });
        try {
          await this.db
            .update(scheduledFollowUpsTable)
            .set({ status: "failed", lastError: message, firedAt: now })
            .where(eq(scheduledFollowUpsTable.id, row.id));
        } catch {
          // Best-effort secondary write; the primary failure is already
          // captured in `errored` for the caller to log/count.
        }
      }
    }

    return { fired, errored };
  }
}

/** Input for {@link FollowUpService.create}. */
export interface CreateFollowUpInput {
  /** Human-readable follow-up text. */
  message: string;
  /** When this follow-up should fire — a Date or an ISO-8601 string. */
  dueAt: Date | string;
  /** Optional free-form structured context. */
  payload?: Record<string, unknown>;
  /** Optional related Minsky task ID (e.g. "mt#123"). */
  relatedTaskId?: string;
  /** Optional related Minsky session ID. */
  relatedSessionId?: string;
}

/** Result of a {@link FollowUpService.fireDue} sweep pass. */
export interface FollowUpFireResult {
  /** Follow-ups successfully flipped from pending -> fired this pass. */
  fired: ScheduledFollowUpRecord[];
  /** Follow-ups whose firing attempt itself errored (marked "failed"). */
  errored: Array<{ id: string; error: string }>;
}
