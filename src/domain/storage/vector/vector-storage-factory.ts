import { getConfiguration } from "../../configuration";
import type { VectorStorage } from "./types";
import { PostgresVectorStorage } from "./postgres-vector-storage";
import { MemoryVectorStorage } from "./memory-vector-storage";

export async function createVectorStorageFromConfig(dimension: number): Promise<VectorStorage> {
  const config = await getConfiguration();
  const backend = (config as any).vectorStorage?.backend || "postgres";

  switch (backend) {
    case "postgres": {
      const vsConfig = (config as any).vectorStorage?.postgres || {};
      const useSessionDb = vsConfig.useSessionDb !== false; // default true
      if (useSessionDb) {
        return PostgresVectorStorage.forTasksEmbeddingsFromConfig(dimension);
      }
      const conn =
        vsConfig.connectionString || (config as any).sessiondb?.postgres?.connectionString;
      if (!conn) {
        throw new Error("PostgreSQL connection string not configured for vectorStorage.postgres");
      }
      const storage = new PostgresVectorStorage(conn, dimension, {
        tableName: "tasks_embeddings",
        idColumn: "task_id",
        embeddingColumn: "vector",
        lastIndexedAtColumn: "indexed_at",
        contentHashColumn: "content_hash",
      });
      await storage.initialize();
      return storage;
    }

    case "memory": {
      return new MemoryVectorStorage(dimension);
    }

    default:
      throw new Error(`Vector storage backend not supported: ${String(backend)}`);
  }
}

/**
 * Create a VectorStorage configured for rules embeddings.
 * Domain-specific convenience that keeps PostgresVectorStorage generic.
 */
export async function createRulesVectorStorageFromConfig(
  dimension: number
): Promise<VectorStorage> {
  const config = await getConfiguration();
  const backend = (config as any).vectorStorage?.backend || "postgres";

  switch (backend) {
    case "postgres": {
      const vsConfig = (config as any).vectorStorage?.postgres || {};
      const tableName = vsConfig.rulesTable || "rules_embeddings";
      const conn =
        vsConfig.connectionString || (config as any).sessiondb?.postgres?.connectionString;
      if (!conn) {
        throw new Error("PostgreSQL connection string not configured for vectorStorage.postgres");
      }
      const storage = new PostgresVectorStorage(conn, dimension, {
        tableName,
        idColumn: "rule_id",
        embeddingColumn: "vector",
        lastIndexedAtColumn: "indexed_at",
        metadataColumn: "metadata",
        contentHashColumn: "content_hash",
      });
      await storage.initialize();
      return storage;
    }

    case "memory": {
      return new MemoryVectorStorage(dimension);
    }

    default:
      throw new Error(`Vector storage backend not supported: ${String(backend)}`);
  }
}

/**
 * Create a VectorStorage configured for tool embeddings.
 * Domain-specific convenience that keeps PostgresVectorStorage generic.
 */
export async function createToolsVectorStorageFromConfig(
  dimension: number
): Promise<VectorStorage> {
  const config = await getConfiguration();
  const backend = (config as any).vectorStorage?.backend || "postgres";

  switch (backend) {
    case "postgres": {
      const vsConfig = (config as any).vectorStorage?.postgres || {};
      const tableName = vsConfig.toolsTable || "tool_embeddings";
      const conn =
        vsConfig.connectionString || (config as any).sessiondb?.postgres?.connectionString;
      if (!conn) {
        throw new Error("PostgreSQL connection string not configured for vectorStorage.postgres");
      }
      const storage = new PostgresVectorStorage(conn, dimension, {
        tableName,
        idColumn: "tool_id",
        embeddingColumn: "vector",
        lastIndexedAtColumn: "indexed_at",
        metadataColumn: "metadata",
        contentHashColumn: "content_hash",
      });
      await storage.initialize();
      return storage;
    }

    case "memory": {
      return new MemoryVectorStorage(dimension);
    }

    default:
      throw new Error(`Vector storage backend not supported: ${String(backend)}`);
  }
}
