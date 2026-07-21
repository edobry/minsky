/**
 * DrizzleSessionRepository
 *
 * Canonical SQL-CRUD persistence for the sessions domain (ADR-018 Shape 1).
 * Implements `SessionProviderInterface` directly against the `sessions`
 * Postgres table via Drizzle, constructed with a `PostgresJsDatabase` obtained
 * from `PersistenceProvider.getDatabaseConnection()` at composition time.
 *
 * Replaces the mt#091-era `SessionDbAdapter` portable-storage layer (the
 * generic storage abstraction over a `sessions` state container). The
 * portability rationale (a JSON/file backend) was deleted years ago
 * (#402 / mt#714); sessions are Postgres-only (the SQLite-as-full-backend
 * story is mt#434 / PGlite).
 *
 * Reference pattern: `packages/domain/src/ask/repository.ts`
 * (`DrizzleAskRepository` + `FakeAskRepository`). The in-memory test double
 * is `FakeSessionProvider` (`session/fake-session-provider.ts`).
 *
 * Migration handling: this repository assumes a current schema, like every
 * other domain repository (ask, pr-watch). Migration *application* happens at
 * `PostgresPersistenceProvider.initialize()` (auto-migrate opt-in, default OFF
 * per mt#2560); drift *detection* is owned by `persistence check` (mt#1641). The former lazy
 * session-init `enforceMigrationsUpToDate` belt-and-suspenders is intentionally
 * not carried over (mt#2329).
 */

import { injectable } from "tsyringe";
import { eq, and, gte, lte, sql, notInArray, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { isAllProjects } from "../project/scope";
import { join } from "path";

import { log } from "@minsky/shared/logger";
import { first } from "@minsky/shared/array-safety";
import { getMinskyStateDir } from "@minsky/shared/paths";

import type { SessionProviderInterface, SessionRecord, SessionListOptions } from "./types";
import { validateQualifiedTaskId } from "../tasks/task-id-utils";
import { getErrorMessage } from "../errors/index";
import {
  postgresSessions,
  toPostgresInsert,
  fromPostgresSelect,
} from "../storage/schemas/session-schema";
import { withPgPoolRetry } from "../persistence/postgres-retry";
import type { PersistenceProvider } from "../persistence/types";
import { createSessionProviderWithAutoRepair } from "./session-auto-repair-provider";
import type { WorkspaceId } from "../ids";
import { nextShortId } from "../utils/short-id";
import {
  classifyEntityIdInput,
  resolveEntityIdPrefix,
  idPrefixResolutionError,
} from "../utils/id-prefix-resolver";

/** Short-id prefix for sessions/workspaces (mt#2967, ADR-029) — "ws" (workspace). */
const SESSION_SHORT_ID_PREFIX = "ws";

// Re-export the interface for use by extracted modules that historically
// imported it from `session-db-adapter` (now deleted).
export type { SessionProviderInterface };

/**
 * Map a logical domain field name to the corresponding Postgres column.
 * Accepts camelCase field names (as used in SessionRecord) as well as the
 * snake_case column names. Carried over verbatim from the retired
 * PostgresStorage so list ordering behavior is preserved exactly.
 */
function pickPostgresOrderColumn(field: string) {
  switch (field) {
    case "lastActivityAt":
    case "last_activity_at":
      return postgresSessions.lastActivityAt;
    case "createdAt":
    case "created_at":
      return postgresSessions.createdAt;
    case "session":
    case "sessionId":
      return postgresSessions.sessionId;
    case "taskId":
    case "task_id":
      return postgresSessions.taskId;
    default:
      throw new Error(`Unsupported orderBy field for Postgres: ${field}`);
  }
}

@injectable()
export class DrizzleSessionRepository implements SessionProviderInterface {
  constructor(private readonly db: PostgresJsDatabase) {}

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    log.debug(`Getting session: ${sessionId}`);
    return withPgPoolRetry(async () => {
      const resolvedId = await this.resolveToCanonicalSessionId(sessionId);
      const result = await this.db
        .select()
        .from(postgresSessions)
        .where(eq(postgresSessions.sessionId, resolvedId as WorkspaceId))
        .limit(1);
      return result.length > 0 ? fromPostgresSelect(first(result, "session query")) : null;
    }, "drizzle-session-repository.getSession");
  }

  /**
   * Resolve raw session-id input (mt#2967) to the canonical uuid `sessionId`,
   * for use by `getSession`/`updateSession`/`deleteSession` alike (PR #2140
   * R1: `updateSession`/`deleteSession` must resolve too — reusing a raw
   * `ws#N`/prefix input that only `getSession` resolved internally silently
   * no-ops the subsequent write).
   *
   * Two steps, in order:
   *
   *  1. **Exact match FIRST, unconditionally**, regardless of input shape.
   *     This is the pre-mt#2967 behavior and must never regress for any
   *     existing uuid or custom session NAME — including a legacy
   *     hex-shaped custom name. (PR #2140 R1 BLOCKING: an earlier version of
   *     this method routed anything 8+ hex chars through short-id/prefix
   *     resolution FIRST; a hex-like legacy session NAME that happened to
   *     share its prefix with an unrelated uuid or `ws#N` row could then
   *     throw an ambiguity error instead of exact-matching the name it
   *     actually is. Trying the exact match first means a real row named
   *     exactly that string is found immediately and prefix resolution is
   *     never reached for it.)
   *  2. **If no exact match**, try `ws#N` short-id / 8+ char hex-prefix
   *     resolution (mt#2967 net-new capability) via the shared
   *     `resolveEntityIdPrefix` (`../utils/id-prefix-resolver.ts`).
   *
   * Returns the raw input UNCHANGED when neither step finds a match, so the
   * caller's own not-found handling (`getSession` returning null,
   * `updateSession`/`deleteSession` finding zero rows) behaves exactly as it
   * did before this task for a genuinely nonexistent id.
   *
   * Throws only on a genuine ambiguity (two+ rows sharing the same
   * short-id/hex-prefix, with no row exactly named the input) — mirrors the
   * ask/memory resolver contract.
   */
  private async resolveToCanonicalSessionId(input: string): Promise<string> {
    const exactMatch = await this.db
      .select({ sessionId: postgresSessions.sessionId })
      .from(postgresSessions)
      .where(eq(postgresSessions.sessionId, input as WorkspaceId))
      .limit(1);
    if (exactMatch.length > 0) {
      return input;
    }

    const classification = classifyEntityIdInput(input);
    if (classification.kind === "invalid" || classification.kind === "resolved") {
      // "invalid": not short-id/hex-prefix shaped — no further resolution
      // possible. "resolved" (a full uuid): the exact match above already
      // covers this shape and just failed — also genuinely not found.
      return input;
    }

    // "short_id" (ws#N) or "prefix" (8+ char hex fragment) with no exact
    // name match — try short-id/prefix resolution.
    const resolution = await resolveEntityIdPrefix({
      db: this.db,
      table: postgresSessions,
      idColumn: postgresSessions.sessionId,
      shortIdColumn: postgresSessions.shortId,
      shortIdPrefix: SESSION_SHORT_ID_PREFIX,
      input,
      entityName: "session",
    });
    if (resolution.kind === "resolved") return resolution.id;
    if (resolution.kind === "not_found") return input;
    throw idPrefixResolutionError("session", resolution);
  }

  /**
   * Compute the next `ws#N` short id (mt#2967) — mirrors
   * `MemoryService.nextMemoryShortId` / `DrizzleAskRepository.nextAskShortId`.
   * Two paths, tried in order:
   *
   * 1. Real-DB-optimized path: a targeted query —
   *    `WHERE short_id ~ '^ws#[0-9]+$' ORDER BY (substring(... from
   *    4))::bigint DESC LIMIT 1` — fetches ONLY the single highest-numbered
   *    row's `short_id`, never the whole table.
   * 2. Fallback: unfiltered single-column select + client-side fold via the
   *    shared `nextShortId` foundation util, for DBs/test fakes that don't
   *    support the full `.where().orderBy().limit()` chain.
   *
   * Branching is a CAPABILITY PROBE (try/catch), not a static type check —
   * several existing test fakes for this repository model the Drizzle chain
   * with plain objects that don't implement the full chain, so path 1
   * reliably fails fast against them and path 2 runs instead.
   *
   * Sessions have no tombstone table analogous to tasks' `deleted_task_ids`
   * — the max is computed over live short ids only, so a deleted session's
   * short id MAY be reissued to a new session. Acceptable for v1 (mirrors
   * memory's mt#2966 same v1 decision).
   */
  private async nextSessionShortId(): Promise<string> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const top = (await (this.db as any)
        .select({ shortId: postgresSessions.shortId })
        .from(postgresSessions)
        .where(sql`${postgresSessions.shortId} ~ '^ws#[0-9]+$'`)
        .orderBy(sql`(substring(${postgresSessions.shortId} from 4))::bigint DESC`)
        .limit(1)) as Array<{ shortId: string | null }>;
      const liveIds = Array.isArray(top) && top[0]?.shortId ? [top[0].shortId as string] : [];
      return nextShortId(SESSION_SHORT_ID_PREFIX, liveIds, []);
    } catch {
      // Fallback: this db doesn't support the full targeted-query chain.
    }

    const rows = (await this.db
      .select({ shortId: postgresSessions.shortId })
      .from(postgresSessions)) as Array<{ shortId: string | null }>;
    const liveIds = (Array.isArray(rows) ? rows : [])
      .map((r) => r.shortId)
      .filter((s): s is string => typeof s === "string");
    return nextShortId(SESSION_SHORT_ID_PREFIX, liveIds, []);
  }

  async listSessions(options?: SessionListOptions): Promise<SessionRecord[]> {
    log.debug(
      options ? `Listing sessions with options: ${JSON.stringify(options)}` : "Listing all sessions"
    );
    return withPgPoolRetry(async () => {
      const conditions: SQL[] = [];
      if (options?.taskId) {
        // Compare against the QUALIFIED stored form (e.g. "mt#283") — that is the
        // actual storage format (verified: real rows hold "mt#971", "md#..."), and
        // it matches getSessionByTaskId's comparison. validateQualifiedTaskId
        // normalizes the query to the qualified form; if it cannot (already
        // qualified, or invalid), fall back to the raw value so a qualified id still
        // matches. (Previously this stripped the prefix to a plain id, which never
        // matched the qualified storage — the listSessions({taskId}) filter was a
        // no-result no-op. mt#2329 PR #1625 R1 BLOCKING.)
        let normalizedTaskId = options.taskId;
        try {
          normalizedTaskId = validateQualifiedTaskId(options.taskId) ?? options.taskId;
        } catch {
          /* invalid id — fall back to the raw value */
        }
        conditions.push(eq(postgresSessions.taskId, normalizedTaskId));
      }
      if (options?.repoName) {
        conditions.push(eq(postgresSessions.repoName, options.repoName));
      }
      if (options?.statusNotIn && options.statusNotIn.length > 0) {
        const excluded = options.statusNotIn;
        conditions.push(
          sql`(${postgresSessions.status} IS NULL OR ${notInArray(postgresSessions.status, excluded)})`
        );
      }
      if (options?.createdAfter) {
        conditions.push(gte(postgresSessions.createdAt, new Date(options.createdAfter)));
      }
      if (options?.createdBefore) {
        conditions.push(lte(postgresSessions.createdAt, new Date(options.createdBefore)));
      }
      // Project scope filter (ADR-021, mt#2416)
      if (options?.projectScope && !isAllProjects(options.projectScope)) {
        conditions.push(eq(postgresSessions.projectId, options.projectScope));
      }

      const orderBy = (options?.orderBy ?? []).map((spec) => {
        // Map the logical field name onto the actual Postgres column.
        // Accept both camelCase domain field names and snake_case column names.
        //
        // NULLS placement: Postgres defaults DESC -> NULLS FIRST and ASC -> NULLS LAST.
        // For session lists we want never-touched rows (NULL lastActivityAt) to sort
        // to the *end* regardless of direction so they don't crowd out recently
        // active sessions on the first page.
        const column = pickPostgresOrderColumn(spec.field);
        return spec.direction === "desc"
          ? sql`${column} DESC NULLS LAST`
          : sql`${column} ASC NULLS LAST`;
      });

      let query = this.db.select().from(postgresSessions).$dynamic();
      if (conditions.length > 0) {
        query = query.where(and(...conditions));
      }
      if (orderBy.length > 0) {
        query = query.orderBy(...orderBy);
      }
      if (typeof options?.limit === "number") {
        query = query.limit(options.limit);
      }
      if (typeof options?.offset === "number" && options.offset > 0) {
        query = query.offset(options.offset);
      }

      const results = await query;
      log.debug(`listSessions: Retrieved ${results.length} raw records`);
      return results.map((record, index: number) => {
        try {
          return fromPostgresSelect(record);
        } catch (mappingError) {
          log.error(`Error mapping session record ${index}: ${getErrorMessage(mappingError)}`);
          throw mappingError;
        }
      });
    }, "drizzle-session-repository.listSessions");
  }

  async getSessionByTaskId(taskId: string): Promise<SessionRecord | null> {
    // Validate and normalize task ID (preserves SessionDbAdapter behavior:
    // compares the QUALIFIED form against the stored taskId).
    let validatedTaskId: string | null;
    try {
      validatedTaskId = validateQualifiedTaskId(taskId);
    } catch (error) {
      log.warn(`Task ID validation failed: ${getErrorMessage(error)}`);
      return null;
    }

    if (!validatedTaskId) {
      return null;
    }

    const sessions = await this.listSessions();
    log.debug(`Looking for taskId: '${validatedTaskId}' in ${sessions.length} sessions`);
    const found = sessions.find((session) => session.taskId === validatedTaskId);
    log.debug(`Found session: ${found ? "YES" : "NO"}`);
    return found ?? null;
  }

  /**
   * Mints the next `ws#N` short id (mt#2967) and retries on a short_id
   * collision — the short-id proposal (SELECT max) and the INSERT are not
   * atomic, so a concurrent writer may claim the proposed id between the
   * two. The unique index on `short_id` turns that race into a clean
   * `onConflictDoNothing` no-op we detect and retry against, mirroring
   * `MemoryService.create` (mt#2966) and `MinskyTaskBackend.tryInsertTask`
   * (mt#2205). A conflict on the `sessionId` PRIMARY KEY itself (a genuine
   * "session already exists" bug) is NOT caught by this `onConflictDoNothing`
   * target and still throws, preserving pre-mt#2967 behavior for that case.
   */
  async addSession(record: SessionRecord): Promise<void> {
    log.debug(`Adding session: ${record.sessionId}`);
    const MAX_RETRIES = 5;
    try {
      await withPgPoolRetry(async () => {
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          const shortId = await this.nextSessionShortId();
          const rows = await this.db
            .insert(postgresSessions)
            .values({ ...toPostgresInsert(record), shortId })
            .onConflictDoNothing({ target: postgresSessions.shortId })
            .returning({ sessionId: postgresSessions.sessionId });
          if (rows.length > 0) {
            return;
          }
          // short_id collision — another writer took it; loop and re-propose.
        }
        throw new Error(
          `Failed to allocate a unique session short id after ${MAX_RETRIES} attempts. ` +
            "This indicates extremely high concurrent session creation — please retry."
        );
      }, "drizzle-session-repository.addSession");
      log.debug(`Session added successfully: ${record.sessionId}`);
    } catch (error) {
      log.error(`Failed to add session '${record.sessionId}': ${getErrorMessage(error)}`);
      throw error;
    }
  }

  /**
   * mt#2967 PR #2140 R1: resolves a `ws#N`/hex-prefix/legacy-name input to
   * the canonical `sessionId` BEFORE the update, then uses that resolved id
   * for both the existence read and the write. Without this, a caller that
   * only validated existence via a raw `getSession(rawInput)` call (which
   * resolves internally) and then reused `rawInput` here would silently
   * match zero rows — `updateSession` did no resolution of its own.
   */
  async updateSession(
    sessionId: string,
    updates: Partial<Omit<SessionRecord, "sessionId">>
  ): Promise<void> {
    log.debug(`Updating session: ${sessionId}`);
    try {
      const updated = await withPgPoolRetry(async () => {
        const resolvedId = await this.resolveToCanonicalSessionId(sessionId);
        const existing = await this.getSessionInternal(resolvedId);
        if (!existing) {
          return null;
        }
        // Merge contract: { ...existing, ...updates } (shallow). undefined clears.
        const merged = { ...existing, ...updates };
        await this.db
          .update(postgresSessions)
          .set(toPostgresInsert(merged as SessionRecord))
          .where(eq(postgresSessions.sessionId, resolvedId as WorkspaceId));
        return merged;
      }, "drizzle-session-repository.updateSession");
      if (!updated) {
        throw new Error(`Session '${sessionId}' not found`);
      }
      log.debug(`Session updated successfully: ${sessionId}`);
    } catch (error) {
      log.error(`Failed to update session '${sessionId}': ${getErrorMessage(error)}`);
      throw error;
    }
  }

  /**
   * mt#2967 PR #2140 R1: same resolve-before-write fix as `updateSession` —
   * a raw `ws#N`/hex-prefix input must resolve to the canonical id before
   * the delete AND before the attachment-teardown call below, or an
   * already-resolved-elsewhere caller's delete silently matches zero rows.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    log.debug(`Deleting session: ${sessionId}`);
    const resolvedId = await withPgPoolRetry(
      () => this.resolveToCanonicalSessionId(sessionId),
      "drizzle-session-repository.deleteSession.resolve"
    );
    // Storage errors (permission denied, corruption, etc.) propagate so callers
    // can surface them. `false` is only "session not found" — a legitimate
    // idempotent-delete outcome.
    const deleted = await withPgPoolRetry(async () => {
      const rows = await this.db
        .delete(postgresSessions)
        .where(eq(postgresSessions.sessionId, resolvedId as WorkspaceId))
        .returning({ sessionId: postgresSessions.sessionId });
      return rows.length > 0;
    }, "drizzle-session-repository.deleteSession");
    log.debug(
      deleted ? `Session deleted: ${resolvedId}` : `Session not found for deletion: ${resolvedId}`
    );

    // mt#2284: teardown — clear any runtime-attachment records for this
    // session so no dangling "attached" row survives session removal. This
    // is the single chokepoint every deletion path (session.delete,
    // session.cleanup, the stale-attachment reaper's own bookkeeping) goes
    // through, so wiring it here covers all of them without threading a new
    // dependency through each caller. Best-effort: never blocks or fails the
    // session deletion itself.
    if (deleted) {
      try {
        const { buildPresenceClaimRepository } = await import("../presence/index");
        const { clearSessionAttachments } = await import("./attachment");
        const presenceRepo = buildPresenceClaimRepository(this.db);
        if (presenceRepo) {
          await clearSessionAttachments(presenceRepo, resolvedId);
        }
      } catch (err) {
        log.debug("Failed to clear session attachment records on delete (non-blocking)", {
          sessionId: resolvedId,
          error: getErrorMessage(err),
        });
      }
    }

    return deleted;
  }

  async getRepoPath(record: SessionRecord | Record<string, unknown>): Promise<string> {
    const rec = record as SessionRecord;
    if (rec?.repoPath) {
      return rec.repoPath;
    }
    if (!rec?.sessionId) {
      throw new Error("Session record is required");
    }
    // Simplified session-based path structure: <stateDir>/sessions/<sessionId>/
    return join(getMinskyStateDir(), "sessions", rec.sessionId);
  }

  async getSessionWorkdir(sessionId: string): Promise<string> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found or has no working directory`);
    }
    // Single source of truth with getRepoPath: prefer the stored repoPath when
    // present, else the derived <stateDir>/sessions/<id> layout. (R1 BLOCKING:
    // align the two path accessors so they cannot silently drift.)
    return this.getRepoPath(session);
  }

  /**
   * Non-retrying single-session read for use inside an already-retried closure
   * (updateSession), avoiding nested retry/backoff doubling.
   */
  private async getSessionInternal(sessionId: string): Promise<SessionRecord | null> {
    const result = await this.db
      .select()
      .from(postgresSessions)
      .where(eq(postgresSessions.sessionId, sessionId as WorkspaceId))
      .limit(1);
    return result.length > 0 ? fromPostgresSelect(first(result, "session query")) : null;
  }
}

/**
 * Dependencies for createSessionProvider, injectable for testing.
 */
export interface CreateSessionProviderDeps {
  persistenceService: {
    isInitialized: () => boolean;
    getProvider: () => PersistenceProvider;
  };
}

/**
 * Creates the default SessionProvider: a `DrizzleSessionRepository` (Postgres
 * SQL-CRUD) wrapped with universal session auto-repair.
 *
 * Accepts either a `CreateSessionProviderDeps` wrapper (legacy) or a raw,
 * already-initialized `PersistenceProvider`. The provider's
 * `getDatabaseConnection()` supplies the Drizzle handle the repository runs on.
 */
export async function createSessionProvider(
  _options?: {
    dbPath?: string;
    useNewBackend?: boolean;
  },
  deps?: CreateSessionProviderDeps | PersistenceProvider
): Promise<SessionProviderInterface> {
  if (!deps) {
    throw new Error(
      "Session provider unavailable: no persistence dependency provided. " +
        "Pass an initialized PersistenceProvider (resolve it from the DI " +
        "container, e.g. getPersistenceDeps().persistenceService.getProvider())."
    );
  }

  // Normalize: accept either a raw PersistenceProvider or the legacy deps wrapper
  const provider: PersistenceProvider =
    typeof (deps as CreateSessionProviderDeps).persistenceService === "object"
      ? (deps as CreateSessionProviderDeps).persistenceService.getProvider()
      : (deps as PersistenceProvider);

  log.debug("Creating session provider with auto-repair support");
  const db = await provider.getDatabaseConnection?.();
  if (!db) {
    throw new Error(
      "Session provider unavailable: persistence provider returned no database " +
        "connection. Ensure the provider is initialized and SQL-capable (Postgres)."
    );
  }
  const baseProvider = new DrizzleSessionRepository(db as PostgresJsDatabase);
  return createSessionProviderWithAutoRepair(baseProvider);
}
