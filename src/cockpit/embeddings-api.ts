import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { EmbeddingsHealthTracker } from "@minsky/domain/ai/embeddings-health-tracker";
import { log } from "@minsky/shared/logger";

export interface ConsumerCoverage {
  consumer: string;
  total: number;
  indexed: number;
  missing: number;
  orphaned: number;
  coveragePct: number;
  lastIndexed: string | null;
  /** Whether total/missing/orphaned are meaningful (false for self-contained tables) */
  hasDomainTable: boolean;
  /** Present when the query failed — surfaces the error for diagnostics */
  error?: string;
}

export interface EmbeddingsOverview {
  health: import("@minsky/domain/ai/embeddings-health-tracker").EmbeddingsHealthSummary;
  consumers: ConsumerCoverage[];
}

interface ConsumerConfig {
  consumer: string;
  embeddingsTable: string;
  embeddingsIdCol: string;
  domainTable?: string;
  domainIdCol?: string;
}

const CONSUMERS: ConsumerConfig[] = [
  {
    consumer: "tasks",
    embeddingsTable: "tasks_embeddings",
    embeddingsIdCol: "task_id",
    domainTable: "tasks",
    domainIdCol: "id",
  },
  {
    consumer: "memories",
    embeddingsTable: "memories_embeddings",
    embeddingsIdCol: "memory_id",
    domainTable: "memories",
    domainIdCol: "id",
  },
  {
    consumer: "principal_corpus",
    embeddingsTable: "principal_corpus_embeddings",
    embeddingsIdCol: "tweet_id",
  },
  {
    consumer: "knowledge",
    embeddingsTable: "knowledge_embeddings",
    embeddingsIdCol: "document_id",
  },
];

async function queryCoverage(
  db: PostgresJsDatabase,
  config: ConsumerConfig
): Promise<ConsumerCoverage> {
  const { sql } = await import("drizzle-orm");

  const indexedResult = await db.execute<{ cnt: number }>(
    sql.raw(`SELECT count(*)::int AS cnt FROM "${config.embeddingsTable}"`)
  );
  const indexed = indexedResult[0]?.cnt ?? 0;

  const lastResult = await db.execute<{ last_indexed: string | null }>(
    sql.raw(`SELECT max(indexed_at) AS last_indexed FROM "${config.embeddingsTable}"`)
  );
  const lastIndexed = lastResult[0]?.last_indexed ?? null;

  if (!config.domainTable) {
    return {
      consumer: config.consumer,
      total: indexed,
      indexed,
      missing: 0,
      orphaned: 0,
      coveragePct: 100,
      lastIndexed,
      hasDomainTable: false,
    };
  }

  const totalResult = await db.execute<{ cnt: number }>(
    sql.raw(`SELECT count(*)::int AS cnt FROM "${config.domainTable}"`)
  );
  const total = totalResult[0]?.cnt ?? 0;

  const missingResult = await db.execute<{ cnt: number }>(
    sql.raw(
      `SELECT count(*)::int AS cnt FROM "${config.domainTable}" d` +
        ` LEFT JOIN "${config.embeddingsTable}" e ON d."${config.domainIdCol}" = e."${config.embeddingsIdCol}"` +
        ` WHERE e."${config.embeddingsIdCol}" IS NULL`
    )
  );
  const missing = missingResult[0]?.cnt ?? 0;

  const orphanedResult = await db.execute<{ cnt: number }>(
    sql.raw(
      `SELECT count(*)::int AS cnt FROM "${config.embeddingsTable}" e` +
        ` WHERE NOT EXISTS (SELECT 1 FROM "${config.domainTable}" d WHERE d."${config.domainIdCol}" = e."${config.embeddingsIdCol}")`
    )
  );
  const orphaned = orphanedResult[0]?.cnt ?? 0;

  return {
    consumer: config.consumer,
    total,
    indexed,
    missing,
    orphaned,
    coveragePct: total > 0 ? Math.round((indexed / total) * 100) : 100,
    lastIndexed,
    hasDomainTable: true,
  };
}

export async function getEmbeddingsOverview(db: PostgresJsDatabase): Promise<EmbeddingsOverview> {
  const health = EmbeddingsHealthTracker.getInstance().getSummary();

  const consumers: ConsumerCoverage[] = [];
  for (const config of CONSUMERS) {
    try {
      consumers.push(await queryCoverage(db, config));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to query coverage for ${config.consumer}: ${errorMsg}`);
      consumers.push({
        consumer: config.consumer,
        total: 0,
        indexed: 0,
        missing: 0,
        orphaned: 0,
        coveragePct: 0,
        lastIndexed: null,
        hasDomainTable: !!config.domainTable,
        error: errorMsg,
      });
    }
  }

  return { health, consumers };
}

export interface EmbeddingsError {
  id: string;
  provider: string;
  errorCode: string;
  status: string;
  failureCount: number;
  degradedReason: string | null;
  createdAt: string;
}

type ErrorRow = Record<string, unknown> & {
  id: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export async function getEmbeddingsErrors(
  db: PostgresJsDatabase,
  limit = 50
): Promise<EmbeddingsError[]> {
  const { sql } = await import("drizzle-orm");

  const rows = await db.execute<ErrorRow>(
    sql.raw(
      `SELECT id, payload, created_at FROM system_events` +
        ` WHERE event_type = 'embeddings.provider_degraded'` +
        ` ORDER BY created_at DESC LIMIT ${limit}`
    )
  );

  return [...rows].map((row) => ({
    id: row.id,
    provider: String(row.payload?.provider ?? "unknown"),
    errorCode: String(row.payload?.errorCode ?? "unknown"),
    status: String(row.payload?.status ?? "unknown"),
    failureCount: Number(row.payload?.failureCount ?? 0),
    degradedReason: row.payload?.degradedReason ? String(row.payload.degradedReason) : null,
    createdAt: row.created_at,
  }));
}

export const REINDEX_COMMANDS: Record<string, string> = {
  tasks: "tasks index-embeddings",
  principal_corpus: "principal-corpus index-embeddings",
  knowledge: "knowledge sync",
};
