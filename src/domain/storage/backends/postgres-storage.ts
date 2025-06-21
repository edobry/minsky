/**
 * PostgresStorage Backend
 * 
 * This module implements the DatabaseStorage interface for PostgreSQL database storage
 * using Drizzle ORM.
 */

import { join } from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import type { DatabaseStorage, DatabaseReadResult, DatabaseWriteResult, DatabaseQueryOptions } from "../database-storage";
import type { SessionRecord, SessionDbState } from "../../session/session-db";
import { sessionsTablePostgres } from "../schemas/session-schema";
import { log } from "../../../utils/logger";

/**
 * PostgreSQL Storage implementation for session records
 */
export class PostgresStorage implements DatabaseStorage<SessionRecord, SessionDbState> {
  private readonly connectionString: string;
  private readonly baseDir: string;
  private pool: Pool | null = null;

  constructor(connectionString?: string, baseDir?: string) {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    
    this.connectionString = connectionString || process.env.MINSKY_POSTGRES_URL || "postgresql://localhost:5432/minsky";
    this.baseDir = baseDir || join(xdgStateHome, "minsky", "git");
  }

  private async getConnection() {
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: this.connectionString,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      });
    }
    return drizzle(this.pool);
  }

  async readState(): Promise<DatabaseReadResult<SessionDbState>> {
    try {
      const db = await this.getConnection();
      const sessions = await db.select().from(sessionsTablePostgres);
      
      return {
        success: true,
        data: {
          sessions: sessions as SessionRecord[],
          baseDir: this.baseDir,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error(`Error reading PostgreSQL database: ${err.message}`);
      return {
        success: false,
        error: err,
      };
    }
  }

  async writeState(state: SessionDbState): Promise<DatabaseWriteResult> {
    try {
      const db = await this.getConnection();
      
      // Clear existing sessions and insert new ones
      await db.delete(sessionsTablePostgres);
      
      if (state.sessions.length > 0) {
        await db.insert(sessionsTablePostgres).values(state.sessions);
      }
      
      return {
        success: true,
        bytesWritten: state.sessions.length,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error(`Error writing PostgreSQL database: ${err.message}`);
      return {
        success: false,
        error: err,
      };
    }
  }

  async getEntity(id: string): Promise<SessionRecord | null> {
    try {
      const db = await this.getConnection();
      const result = await db.select().from(sessionsTablePostgres).where(eq(sessionsTablePostgres.session, id));
      
      return result.length > 0 ? (result[0] as SessionRecord) : null;
    } catch (error) {
      log.error(`Error getting entity: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async getEntities(): Promise<SessionRecord[]> {
    try {
      const db = await this.getConnection();
      const sessions = await db.select().from(sessionsTablePostgres);
      return sessions as SessionRecord[];
    } catch (error) {
      log.error(`Error getting entities: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async createEntity(entity: SessionRecord): Promise<SessionRecord> {
    try {
      const db = await this.getConnection();
      await db.insert(sessionsTablePostgres).values(entity);
      return entity;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error(`Error creating entity: ${err.message}`);
      throw new Error(`Failed to create entity: ${err.message}`);
    }
  }

  async updateEntity(id: string, updates: Partial<SessionRecord>): Promise<SessionRecord | null> {
    try {
      const db = await this.getConnection();
      
      // Filter out the session property from updates
      const safeUpdates: Partial<Omit<SessionRecord, "session">> = {};
      Object.entries(updates).forEach(([key, value]) => {
        if (key !== "session") {
          (safeUpdates as any)[key] = value;
        }
      });
      
      const result = await db.update(sessionsTablePostgres)
        .set(safeUpdates)
        .where(eq(sessionsTablePostgres.session, id))
        .returning();
      
      return result.length > 0 ? (result[0] as SessionRecord) : null;
    } catch (error) {
      log.error(`Error updating entity: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async deleteEntity(id: string): Promise<boolean> {
    try {
      const db = await this.getConnection();
      const result = await db.delete(sessionsTablePostgres)
        .where(eq(sessionsTablePostgres.session, id))
        .returning();
      
      return result.length > 0;
    } catch (error) {
      log.error(`Error deleting entity: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async entityExists(id: string): Promise<boolean> {
    const entity = await this.getEntity(id);
    return entity !== null;
  }

  getStorageLocation(): string {
    return this.connectionString;
  }

  async initialize(): Promise<boolean> {
    try {
      await this.getConnection();
      return true;
    } catch (error) {
      log.error(`Error initializing PostgreSQL storage: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Close the database connection pool
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
