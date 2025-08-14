import postgres from "postgres";
import { getConfiguration } from "../../configuration";
import type { VectorStorage, SearchResult } from "./types";

export class PostgresVectorStorage implements VectorStorage {
  private readonly sql: ReturnType<typeof postgres>;

  constructor(private readonly connectionString: string, private readonly dimension: number) {
    this.sql = postgres(connectionString, { prepare: false, onnotice: () => {} });
  }

  static async fromSessionDbConfig(dimension: number): Promise<PostgresVectorStorage> {
    const config = await getConfiguration();
    const conn = config.sessiondb?.postgres?.connectionString || process.env.MINSKY_POSTGRES_URL;
    if (!conn) throw new Error("PostgreSQL connection string not configured (sessiondb.postgres)");
    const storage = new PostgresVectorStorage(conn, dimension);
    await storage.initialize();
    return storage;
  }

  async initialize(): Promise<void> {
    // Ensure pgvector extension and embeddings table exist
    await this.sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS task_embeddings (
        id TEXT PRIMARY KEY,
        qualified_task_id TEXT,
        dimension INT NOT NULL,
        embedding vector(${this.dimension}),
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`;
    // Basic ANN index (IVFFlat) if extension supports
    try {
      await this.sql`CREATE INDEX IF NOT EXISTS idx_task_embeddings_ivf ON task_embeddings USING ivfflat (embedding vector_l2_ops)`;
    } catch (e) {
      // ignore if not supported; fallback to sequential scan
    }
  }

  async store(id: string, vector: number[], metadata?: Record<string, any>): Promise<void> {
    await this.sql`
      INSERT INTO task_embeddings (id, dimension, embedding, metadata, updated_at)
      VALUES (${id}, ${this.dimension}, ${vector}::vector, ${metadata || null}, NOW())
      ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata, updated_at = NOW()`;
  }

  async search(queryVector: number[], limit = 10, threshold = 0.0): Promise<SearchResult[]> {
    const rows = await this.sql`
      SELECT id, (embedding <-> ${queryVector}::vector) AS score
      FROM task_embeddings
      ORDER BY embedding <-> ${queryVector}::vector
      LIMIT ${limit}`;

    const results: SearchResult[] = (rows as any[]).map((r) => ({ id: String((r as any).id), score: Number((r as any).score) }));
    return results.filter((r) => (isFinite(threshold) ? r.score <= threshold : true));
  }

  async delete(id: string): Promise<void> {
    await this.sql`DELETE FROM task_embeddings WHERE id = ${id}`;
  }
}
