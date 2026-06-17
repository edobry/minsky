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
 * `PostgresPersistenceProvider.initialize()` (auto-migrate, default ON); drift
 * *detection* is owned by `persistence check` (mt#1641). The former lazy
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
      const result = await this.db
        .select()
        .from(postgresSessions)
        .where(eq(postgresSessions.sessionId, sessionId))
        .limit(1);
      return result.length > 0 ? fromPostgresSelect(first(result, "session query")) : null;
    }, "drizzle-session-repository.getSession");
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

  async addSession(record: SessionRecord): Promise<void> {
    log.debug(`Adding session: ${record.sessionId}`);
    try {
      await withPgPoolRetry(async () => {
        await this.db.insert(postgresSessions).values(toPostgresInsert(record));
      }, "drizzle-session-repository.addSession");
      log.debug(`Session added successfully: ${record.sessionId}`);
    } catch (error) {
      log.error(`Failed to add session '${record.sessionId}': ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async updateSession(
    sessionId: string,
    updates: Partial<Omit<SessionRecord, "sessionId">>
  ): Promise<void> {
    log.debug(`Updating session: ${sessionId}`);
    try {
      const updated = await withPgPoolRetry(async () => {
        const existing = await this.getSessionInternal(sessionId);
        if (!existing) {
          return null;
        }
        // Merge contract: { ...existing, ...updates } (shallow). undefined clears.
        const merged = { ...existing, ...updates };
        await this.db
          .update(postgresSessions)
          .set(toPostgresInsert(merged as SessionRecord))
          .where(eq(postgresSessions.sessionId, sessionId));
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

  async deleteSession(sessionId: string): Promise<boolean> {
    log.debug(`Deleting session: ${sessionId}`);
    // Storage errors (permission denied, corruption, etc.) propagate so callers
    // can surface them. `false` is only "session not found" — a legitimate
    // idempotent-delete outcome.
    const deleted = await withPgPoolRetry(async () => {
      const rows = await this.db
        .delete(postgresSessions)
        .where(eq(postgresSessions.sessionId, sessionId))
        .returning({ sessionId: postgresSessions.sessionId });
      return rows.length > 0;
    }, "drizzle-session-repository.deleteSession");
    log.debug(
      deleted ? `Session deleted: ${sessionId}` : `Session not found for deletion: ${sessionId}`
    );
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
      .where(eq(postgresSessions.sessionId, sessionId))
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
