import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getConfiguration } from "../../configuration";
import type { VectorStorage, SearchResult } from "./types";
import { log } from "../../../utils/logger";

export class PostgresVectorStorage implements VectorStorage {
  private readonly sql: ReturnType<typeof postgres>;
  private readonly db: ReturnType<typeof drizzle>;

  constructor(
    private readonly connectionString: string,
    private readonly dimension: number
  ) {
    this.sql = postgres(connectionString, { prepare: false, onnotice: () => {} });
    this.db = drizzle(this.sql);
  }

  static async fromSessionDbConfig(dimension: number): Promise<PostgresVectorStorage> {
    const config = await getConfiguration();
    const conn = config.sessiondb?.postgres?.connectionString;
    if (!conn) throw new Error("PostgreSQL connection string not configured (sessiondb.postgres)");
    const storage = new PostgresVectorStorage(conn, dimension);
    await storage.initialize();
    return storage;
  }

  async initialize(): Promise<void> {
    await this.sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
    await this.sql.unsafe(
      `CREATE TABLE IF NOT EXISTS task_embeddings (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        dimension INT NOT NULL,
        embedding vector(${this.dimension}),
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`
    );
    try {
      await this.sql.unsafe(
        "CREATE INDEX IF NOT EXISTS idx_task_embeddings_ivf ON task_embeddings USING ivfflat (embedding vector_l2_ops)"
      );
    } catch {
      // ignore if not supported
    }
  }

  async store(id: string, vector: number[], metadata?: Record<string, any>): Promise<void> {
    const vectorLiteral = `[${vector.join(",")}]`;
    await this.sql.unsafe(
      `INSERT INTO task_embeddings (id, dimension, embedding, metadata, updated_at)
       VALUES ($1, $2, $3::vector, $4::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata, updated_at = NOW()`,
      [id, this.dimension, vectorLiteral, metadata ? JSON.stringify(metadata) : null]
    );
  }

  async search(queryVector: number[], limit = 10, threshold = 0.0): Promise<SearchResult[]> {
    const vectorLiteral = `[${queryVector.join(",")}]`;
    try {
      log.debug("[vector.search] Using Postgres vector storage", {
        limit,
        threshold,
        dimension: this.dimension,
      });
    } catch {
      // ignore debug logging errors
    }
    const rows = await this.sql.unsafe(
      `SELECT id, (embedding <-> $1::vector) AS score
       FROM task_embeddings
       ORDER BY embedding <-> $1::vector
       LIMIT $2`,
      [vectorLiteral, limit]
    );

    const results: SearchResult[] = (rows as any[]).map((r) => ({
      id: String((r as any).id),
      score: Number((r as any).score),
    }));
    try {
      log.debug("[vector.search] Raw ANN rows", {
        count: (rows as any[]).length,
        sample: (rows as any[]).slice(0, 5),
      });
    } catch {
      // ignore debug logging errors
    }
    return results.filter((r) => (isFinite(threshold) ? r.score <= threshold : true));
  }

  async delete(id: string): Promise<void> {
    await this.sql.unsafe(`DELETE FROM task_embeddings WHERE id = $1`, [id]);
  }
}
