#!/usr/bin/env bun
import "reflect-metadata";
/**
 * Minimal reproduction for mt#2183.
 *
 * Mimics what src/cockpit/shared-persistence.ts does — initializes the
 * PersistenceService — and logs the exact step that hangs (if any).
 *
 * Compare CLI behavior (this script) vs cockpit-server behavior (long-running
 * Express process) to isolate whether init itself hangs or only inside the
 * cockpit context.
 */

const startMs = Date.now();
function stamp(msg: string) {
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(2);
  console.error(`[+${elapsed}s] ${msg}`);
}

async function main() {
  stamp("script start");

  stamp("calling setupConfiguration() (mimics src/cli.ts bootstrap)...");
  const { setupConfiguration } = await import("@minsky/domain/config-setup");
  await setupConfiguration();
  stamp("setupConfiguration done");

  stamp("importing PersistenceService...");
  const { PersistenceService } = await import("@minsky/domain/persistence/service");
  stamp("import done");

  stamp("constructing PersistenceService...");
  const svc = new PersistenceService();
  stamp("construct done");

  stamp("calling initialize()...");
  const initTimeoutMs = 30_000;
  const initRace = await Promise.race([
    svc
      .initialize()
      .then(() => "ok")
      .catch((e) => `err: ${e instanceof Error ? e.message : String(e)}`),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve(`TIMEOUT after ${initTimeoutMs}ms`), initTimeoutMs)
    ),
  ]);
  stamp(`initialize() result: ${initRace}`);

  if (initRace !== "ok") {
    process.exit(1);
  }

  stamp("getProvider()...");
  const provider = svc.getProvider();
  stamp(`provider: ${provider.constructor.name}`);

  stamp(`capabilities.sql = ${provider.capabilities.sql}`);

  if (provider.capabilities.sql) {
    stamp("getRawSqlConnection()...");
    const rawSql = await (
      provider as { getRawSqlConnection?: () => Promise<unknown> }
    ).getRawSqlConnection?.();
    stamp(`rawSql: ${rawSql ? "present" : "null"}`);

    if (rawSql) {
      stamp("running widget query: subquery-aggregated counts");
      const sql = rawSql as import("postgres").Sql;
      const queryTimeoutMs = 15_000;
      const queryRace = await Promise.race([
        sql
          .unsafe(
            `SELECT
              (SELECT count(*)::int FROM tasks) AS tasks_total,
              (SELECT count(*)::int FROM tasks_embeddings) AS tasks_indexed,
              (SELECT count(*)::int FROM memories) AS memories_total,
              (SELECT count(*)::int FROM memories_embeddings) AS memories_indexed`
          )
          .then(
            (rows) => {
              const r = rows[0] ?? {};
              return `ok: tasks=${r.tasks_indexed}/${r.tasks_total} memories=${r.memories_indexed}/${r.memories_total}`;
            },
            (e) => `err: ${e instanceof Error ? e.message : String(e)}`
          ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve(`TIMEOUT after ${queryTimeoutMs}ms`), queryTimeoutMs)
        ),
      ]);
      stamp(`query result: ${queryRace}`);
    }
  }

  stamp("closing...");
  await svc.close();
  stamp("done");
  process.exit(0);
}

main().catch((e) => {
  console.error("[FATAL]", e);
  process.exit(2);
});
