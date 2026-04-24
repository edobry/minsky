import { injectable } from "tsyringe";
import postgres from "postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { VectorStorage, SearchResult, SearchOptions } from "./types";
import { log } from "../../../utils/logger";
import { withPgPoolRetry } from "../../persistence/postgres-retry";

export interface PostgresVectorStorageConfig {
  tableName: string;
  idColumn: string; // e.g., task_id
  embeddingColumn: string; // e.g., vector or embedding
  dimensionColumn?: string; // optional legacy column; most schemas dropped it
  lastIndexedAtColumn?: string; // e.g., indexed_at or last_indexed_at
  metadataColumn?: string; // e.g., metadata (JSONB)
  contentHashColumn?: string; // e.g., content_hash (TEXT)
}

@injectable()
export class PostgresVectorStorage implements VectorStorage {
  private readonly sql: ReturnType<typeof postgres>;
  private readonly db: PostgresJsDatabase;

  constructor(
    sql: ReturnType<typeof postgres>,
    db: PostgresJsDatabase,
    private readonly dimension: number,
    private readonly config: PostgresVectorStorageConfig
  ) {
    this.sql = sql;
    this.db = db;
  }

  async initialize(): Promise<void> {
    await withPgPoolRetry(
      () => this.sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector"),
      "postgres-vector-storage.initialize"
    );
    // Tables are managed by Drizzle migrations. No-op here to avoid drift.
  }

  async store(id: string, vector: number[], _metadata?: Record<string, unknown>): Promise<void> {
    return withPgPoolRetry(
      () => this.storeInternal(id, vector, _metadata),
      "postgres-vector-storage.store"
    );
  }

  private async storeInternal(
    id: string,
    vector: number[],
    _metadata?: Record<string, unknown>
  ): Promise<void> {
    const vectorLiteral = `[${vector.join(",")}]`;

    const cols: string[] = [this.config.idColumn, this.config.embeddingColumn];
    const placeholders: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- postgres.js sql.unsafe() requires ParameterOrJSON<never>[] which doesn't accept unknown
    const values: any[] = [];
    let paramIndex = 1;

    // id
    placeholders.push(`$${paramIndex++}`);
    values.push(id);

    // optional dimension column (legacy schemas)
    if (this.config.dimensionColumn) {
      cols.splice(1, 0, this.config.dimensionColumn);
      placeholders.push(`$${paramIndex++}`);
      values.push(this.dimension);
    }

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

    const updateSets: string[] = [
      `${this.config.embeddingColumn} = EXCLUDED.${this.config.embeddingColumn}`,
    ];
    if (this.config.dimensionColumn) {
      updateSets.push(`${this.config.dimensionColumn} = EXCLUDED.${this.config.dimensionColumn}`);
    }
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

  async getMetadata(id: string): Promise<Record<string, unknown> | null> {
    return withPgPoolRetry(
      () => this.getMetadataInternal(id),
      "postgres-vector-storage.getMetadata"
    );
  }

  private async getMetadataInternal(id: string): Promise<Record<string, unknown> | null> {
    const cols: string[] = [this.config.idColumn];
    if (this.config.contentHashColumn) cols.push(this.config.contentHashColumn);
    if (this.config.lastIndexedAtColumn) cols.push(this.config.lastIndexedAtColumn);
    if (this.config.metadataColumn) cols.push(this.config.metadataColumn);

    const rows = await this.sql.unsafe(
      `SELECT ${cols.join(", ")} FROM ${this.config.tableName} WHERE ${this.config.idColumn} = $1 LIMIT 1`,
      [id]
    );
    const row = (rows as Record<string, unknown>[])[0];
    if (!row) return null;
    const out: Record<string, unknown> = {};
    for (const c of cols) out[c] = (row as Record<string, unknown>)[c];
    return out;
  }

  async search(queryVector: number[], options: SearchOptions = {}): Promise<SearchResult[]> {
    return withPgPoolRetry(
      () => this.searchInternal(queryVector, options),
      "postgres-vector-storage.search"
    );
  }

  private async searchInternal(
    queryVector: number[],
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    const { limit = 10, threshold, filters } = options;
    const vectorLiteral = `[${queryVector.join(",")}]`;

    try {
      log.debug("[vector.search] Using Postgres vector storage", {
        limit,
        threshold,
        filters,
        dimension: this.dimension,
        table: this.config.tableName,
      });
    } catch {
      // ignore debug logging errors
    }

    // Build WHERE clause for filters
    let whereClause = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- postgres.js sql.unsafe() requires ParameterOrJSON<never>[] which doesn't accept unknown
    const queryParams: any[] = [vectorLiteral, limit];
    let paramIndex = 3;

    if (filters && Object.keys(filters).length > 0) {
      const filterConditions: string[] = [];
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null) {
          // Handle exclusion filters (e.g., statusExclude: ['DONE', 'CLOSED'])
          if (key.endsWith("Exclude") && Array.isArray(value) && value.length > 0) {
            const columnName = key.replace("Exclude", "");
            const placeholders = value.map(() => `$${paramIndex++}`).join(", ");
            filterConditions.push(`${columnName} NOT IN (${placeholders})`);
            queryParams.push(...value);
          } else {
            // Handle regular equality filters (e.g., status: 'TODO')
            filterConditions.push(`${key} = $${paramIndex}`);
            queryParams.push(value);
            paramIndex++;
          }
        }
      }
      if (filterConditions.length > 0) {
        whereClause = `WHERE ${filterConditions.join(" AND ")}`;
      }
    }

    const query = `
      SELECT ${this.config.idColumn} AS id, (${this.config.embeddingColumn} <-> $1::vector) AS score
      FROM ${this.config.tableName}
      ${whereClause}
      ORDER BY ${this.config.embeddingColumn} <-> $1::vector
      LIMIT $2
    `;

    const rows = await this.sql.unsafe(query, queryParams);

    const results: SearchResult[] = (rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      score: Number(r.score),
    }));

    return results.filter((r) =>
      isFinite(threshold as number) ? r.score <= (threshold as number) : true
    );
  }

  async delete(id: string): Promise<void> {
    await withPgPoolRetry(
      () =>
        this.sql.unsafe(`DELETE FROM ${this.config.tableName} WHERE ${this.config.idColumn} = $1`, [
          id,
        ]),
      "postgres-vector-storage.delete"
    );
  }
}
