import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getConfiguration } from "../../configuration";
import type { VectorStorage, SearchResult } from "./types";
import { log } from "../../../utils/logger";

export interface PostgresVectorStorageConfig {
  tableName: string;
  idColumn: string; // e.g., task_id
  embeddingColumn: string; // e.g., embedding
  dimensionColumn: string; // e.g., dimension
  lastIndexedAtColumn?: string; // e.g., last_indexed_at
  metadataColumn?: string; // e.g., metadata (JSONB)
  contentHashColumn?: string; // e.g., content_hash (TEXT)
}

export class PostgresVectorStorage implements VectorStorage {
  private readonly sql: ReturnType<typeof postgres>;
  private readonly db: ReturnType<typeof drizzle>;

  constructor(
    private readonly connectionString: string,
    private readonly dimension: number,
    private readonly config: PostgresVectorStorageConfig
  ) {
    this.sql = postgres(connectionString, { prepare: false, onnotice: () => {} });
    this.db = drizzle(this.sql);
  }

  static async fromSessionDbConfig(
    dimension: number,
    config: PostgresVectorStorageConfig
  ): Promise<PostgresVectorStorage> {
    const runtimeConfig = await getConfiguration();
    const conn = runtimeConfig.sessiondb?.postgres?.connectionString;
    if (!conn) {
      throw new Error("PostgreSQL connection string not configured (sessiondb.postgres)");
    }
    const storage = new PostgresVectorStorage(conn, dimension, config);
    await storage.initialize();
    return storage;
  }

  // Convenience for task embeddings
  static async forTasksEmbeddingsFromConfig(dimension: number): Promise<PostgresVectorStorage> {
    return PostgresVectorStorage.fromSessionDbConfig(dimension, {
      tableName: "tasks_embeddings",
      idColumn: "task_id",
      embeddingColumn: "vector",
      dimensionColumn: "dimension",
      lastIndexedAtColumn: "indexed_at",
    });
  }

  async initialize(): Promise<void> {
    await this.sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
    // Tables are managed by Drizzle migrations. No-op here to avoid drift.
  }

  async store(id: string, vector: number[], _metadata?: Record<string, any>): Promise<void> {
    const vectorLiteral = `[${vector.join(",")}]`;

    const cols: string[] = [
      this.config.idColumn,
      this.config.dimensionColumn,
      this.config.embeddingColumn,
    ];
    const placeholders: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    // id
    placeholders.push(`$${paramIndex++}`);
    values.push(id);

    // dimension
    placeholders.push(`$${paramIndex++}`);
    values.push(this.dimension);

    // embedding (vector)
    placeholders.push(`$${paramIndex++}::vector`);
    values.push(vectorLiteral);

    // optional metadata JSONB
    if (this.config.metadataColumn) {
      cols.push(this.config.metadataColumn);
      placeholders.push(`$${paramIndex++}::jsonb`);
      values.push(_metadata ? JSON.stringify(_metadata) : JSON.stringify({}));
    }

    // optional content hash TEXT
    if (this.config.contentHashColumn) {
      cols.push(this.config.contentHashColumn);
      placeholders.push(`$${paramIndex++}`);
      values.push(_metadata?.contentHash || null);
    }

    // optional lastIndexedAt
    if (this.config.lastIndexedAtColumn) {
      cols.push(this.config.lastIndexedAtColumn);
      placeholders.push("NOW()");
    }

    // updated_at
    cols.push("updated_at");
    placeholders.push("NOW()");

    const updateSets: string[] = [
      `${this.config.embeddingColumn} = EXCLUDED.${this.config.embeddingColumn}`,
      `${this.config.dimensionColumn} = EXCLUDED.${this.config.dimensionColumn}`,
      `updated_at = NOW()`,
    ];
    if (this.config.metadataColumn) {
      updateSets.push(`${this.config.metadataColumn} = EXCLUDED.${this.config.metadataColumn}`);
    }
    if (this.config.contentHashColumn) {
      updateSets.push(
        `${this.config.contentHashColumn} = EXCLUDED.${this.config.contentHashColumn}`
      );
    }
    if (this.config.lastIndexedAtColumn) {
      updateSets.push(`${this.config.lastIndexedAtColumn} = NOW()`);
    }

    const sql = `INSERT INTO ${this.config.tableName} (${cols.join(", ")})
       VALUES (${placeholders.join(", ")})
       ON CONFLICT (${this.config.idColumn}) DO UPDATE SET ${updateSets.join(", ")}`;

    await this.sql.unsafe(sql, values);
  }

  async search(queryVector: number[], limit = 10, threshold = 0.0): Promise<SearchResult[]> {
    const vectorLiteral = `[${queryVector.join(",")}]`;
    try {
      log.debug("[vector.search] Using Postgres vector storage", {
        limit,
        threshold,
        dimension: this.dimension,
        table: this.config.tableName,
      });
    } catch {
      // ignore debug logging errors
    }

    const rows = await this.sql.unsafe(
      `SELECT ${this.config.idColumn} AS id, (${this.config.embeddingColumn} <-> $1::vector) AS score
       FROM ${this.config.tableName}
       ORDER BY ${this.config.embeddingColumn} <-> $1::vector
       LIMIT $2`,
      [vectorLiteral, limit]
    );

    const results: SearchResult[] = (rows as any[]).map((r) => ({
      id: String((r as any).id),
      score: Number((r as any).score),
    }));

    return results.filter((r) => (isFinite(threshold) ? r.score <= threshold : true));
  }

  async delete(id: string): Promise<void> {
    await this.sql.unsafe(
      `DELETE FROM ${this.config.tableName} WHERE ${this.config.idColumn} = $1`,
      [id]
    );
  }
}
