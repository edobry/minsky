#!/usr/bin/env bun
/**
 * Backlog theme clustering — the mt#5128 artifact (Prioritization Phase 1a).
 *
 * Reads every open, non-package task's embedding from `tasks_embeddings`
 * (joined to `tasks` at read time — ADR-013's post-filter shape), clusters
 * them by theme, and prints "the backlog's mass by theme" as markdown so the
 * principal can declare standing pointings against what is actually there.
 *
 * READ-ONLY. No row is written. Nothing here is ranked; clusters are listed by
 * size only and no score, rank, or priority is rendered.
 *
 * Usage:
 *   bun scripts/backlog-theme-clusters.ts            # markdown to stdout
 *   bun scripts/backlog-theme-clusters.ts --json     # the ThemeClusterResult + meta as JSON
 *   bun scripts/backlog-theme-clusters.ts --k=10     # fix k instead of sweeping
 *   bun scripts/backlog-theme-clusters.ts --seed=7   # different k-means++ seeding
 *
 * Requires a SQL-capable persistence provider (Postgres). Exits 2 with a SKIP
 * line when none is configured.
 */

import "reflect-metadata";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, eq, notInArray, ne } from "drizzle-orm";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

import type {
  ThemeClusterItem,
  ThemeClusterOptions,
} from "@minsky/domain/tasks/backlog-theme-clusters";

const TERMINAL = ["DONE", "CLOSED"];
const EXCLUDED_KIND = "work-package";

interface CliArgs {
  json: boolean;
  k?: number;
  seed?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { json: false };
  for (const arg of argv) {
    if (arg === "--json") out.json = true;
    else if (arg.startsWith("--k=")) out.k = Number.parseInt(arg.slice(4), 10);
    else if (arg.startsWith("--seed=")) out.seed = Number.parseInt(arg.slice(7), 10);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun scripts/backlog-theme-clusters.ts [--json] [--k=N] [--seed=N]");
      process.exit(0);
    }
  }
  if (out.k !== undefined && !(out.k >= 1)) throw new Error(`--k must be a positive integer`);
  if (out.seed !== undefined && !Number.isFinite(out.seed))
    throw new Error(`--seed must be a number`);
  return out;
}

/** Mirrors scripts/backfill-agent-transcripts-model.ts's bootstrapDb() convention. */
async function bootstrapDb(): Promise<PostgresJsDatabase | null> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");

  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });
  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  interface SqlCapablePersistence {
    getDatabaseConnection: () => Promise<PostgresJsDatabase | null>;
  }
  const isSqlCapable = (p: unknown): p is SqlCapablePersistence =>
    !!p &&
    !!(p as { capabilities?: { sql?: boolean } }).capabilities?.sql &&
    typeof (p as { getDatabaseConnection?: unknown }).getDatabaseConnection === "function";
  if (!isSqlCapable(persistence)) return null;
  return persistence.getDatabaseConnection();
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    // intentional-swallow: a malformed tags column is treated as untagged; the row still clusters.
    return [];
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = await bootstrapDb();
  if (!db) {
    console.log("SKIP: no SQL-capable persistence provider configured (Postgres required).");
    process.exit(2);
  }

  const { tasksTable, tasksEmbeddingsTable } = await import(
    "@minsky/domain/storage/schemas/task-embeddings"
  );
  const { resolveProjectIdentity } = await import("@minsky/domain/project/identity");
  const { resolveScopeOutcome } = await import("@minsky/domain/project/scope-resolver");
  const { clusterBacklogThemes } = await import("@minsky/domain/tasks/backlog-theme-clusters");
  const { renderThemeClustersMarkdown } = await import(
    "@minsky/domain/tasks/backlog-theme-clusters-render"
  );

  const identity = resolveProjectIdentity({ repoPath: process.cwd() });
  const scope = await resolveScopeOutcome(identity, db);
  const projectFilter =
    scope.kind === "resolved" ? eq(tasksTable.projectId, scope.projectId) : undefined;

  const asOf = new Date();
  const rows = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      tags: tasksTable.tags,
      updatedAt: tasksTable.updatedAt,
      vector: tasksEmbeddingsTable.vector,
    })
    .from(tasksTable)
    .leftJoin(tasksEmbeddingsTable, eq(tasksEmbeddingsTable.id, tasksTable.id))
    .where(
      and(
        notInArray(tasksTable.status, TERMINAL),
        ne(tasksTable.kind, EXCLUDED_KIND),
        projectFilter
      )
    );

  const items: ThemeClusterItem[] = [];
  const missingEmbedding: string[] = [];
  for (const row of rows) {
    if (!row.vector) {
      missingEmbedding.push(row.id);
      continue;
    }
    items.push({
      id: row.id,
      title: row.title ?? "",
      tags: parseTags(row.tags),
      vector: row.vector,
      updatedAtMs: row.updatedAt ? new Date(row.updatedAt).getTime() : asOf.getTime(),
    });
  }

  const options: ThemeClusterOptions = { nowMs: asOf.getTime() };
  if (args.k !== undefined) options.k = args.k;
  if (args.seed !== undefined) options.seed = args.seed;
  const result = clusterBacklogThemes(items, options);
  const meta = {
    asOf: asOf.toISOString(),
    openTaskCount: rows.length,
    missingEmbedding,
  };

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          meta: { ...meta, projectScope: scope.kind === "resolved" ? scope.projectId : "all" },
          result,
        },
        null,
        2
      )
    );
  } else {
    console.log(renderThemeClustersMarkdown(result, meta));
    console.log(
      `Project scope: ${scope.kind === "resolved" ? scope.projectId : "all projects (identity did not resolve)"}`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`FAILED: ${getLoggableErrorSummary(err)}`);
    process.exit(1);
  });
