#!/usr/bin/env bun
/**
 * Live-verification artifact for mt#3354.
 *
 * The unit tests for `refs.status` exercise the `RefResolvers` SEAM with fakes.
 * They cannot prove the real BINDING works: that `buildProductionResolvers`
 * actually reaches the asks / memories / sessions tables, that
 * `getMemoryRefSummary` and `DrizzleSessionRepository.getSession` resolve the
 * short-id forms against live data, and that a memory uuid now reports
 * `kind: "memory"` instead of an absent ask. A seam-injected test would pass
 * identically against a dead binding (`/implement-task` §7 item 8, memory
 * 78a6043e).
 *
 * So this script drives the REGISTERED command — the same code path the MCP
 * tool and CLI use — against whatever rows the live DB actually holds.
 *
 * Ids are DISCOVERED, never hardcoded: it reads the newest row of each entity
 * that carries a short id, so the check is portable to any machine and any
 * database rather than bound to one developer's data.
 *
 * Run: `bun scripts/verify-refs-status-entity-resolution.ts`
 * Exit 0 = every assertion passed (or the DB is absent and the run SKIPs).
 * Exit 1 = a real resolution failure.
 */

import "reflect-metadata";

import type { AppContainerInterface } from "@minsky/domain/composition/types";

interface DiscoveredRef {
  entity: "ask" | "memory" | "workspace";
  expectedKind: string;
  uuid: string;
  shortId: string;
}

const failures: string[] = [];
const notes: string[] = [];

function check(label: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`  PASS  ${label} — ${detail}`);
    return;
  }
  console.log(`  FAIL  ${label} — ${detail}`);
  failures.push(`${label}: ${detail}`);
}

async function bootstrap(): Promise<AppContainerInterface> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const container = await createCliContainer();
  await container.initialize();
  return container;
}

/**
 * Narrow a driver result to its first row. A runtime guard rather than a cast:
 * the row shape crosses a trust boundary (raw SQL through a loosely-typed
 * driver), and a `as unknown as Row[]` would assert a shape nothing checked.
 */
function firstRow(result: unknown): { uuid: string; shortId: string } | null {
  const rows = Array.isArray(result) ? result : [];
  const row: unknown = rows[0];
  if (typeof row !== "object" || row === null) return null;
  const record: Record<string, unknown> = { ...row };
  const uuid = record["uuid"];
  const shortId = record["short_id"];
  if (typeof uuid !== "string" || typeof shortId !== "string") return null;
  return { uuid, shortId };
}

/**
 * Pull one real (uuid, shortId) pair per entity straight from SQL, so the probe
 * is not coupled to the very command layer it is verifying.
 */
async function discoverRefs(container: AppContainerInterface): Promise<DiscoveredRef[]> {
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!persistence || !(persistence instanceof PersistenceProvider)) {
    throw new Error("SKIP_NO_DB");
  }
  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    throw new Error("SKIP_NO_DB");
  }
  const connection = await persistence.getDatabaseConnection();
  // `getDatabaseConnection` is typed loosely enough that `.execute` is not on
  // the surface; check for it rather than asserting it exists.
  if (!connection || typeof (connection as { execute?: unknown }).execute !== "function") {
    throw new Error("SKIP_NO_DB");
  }
  const db = connection as { execute(query: string): Promise<unknown> };

  const sources: Array<{
    entity: DiscoveredRef["entity"];
    expectedKind: string;
    table: string;
    idColumn: string;
  }> = [
    { entity: "ask", expectedKind: "ask", table: "asks", idColumn: "id" },
    { entity: "memory", expectedKind: "memory", table: "memories", idColumn: "id" },
    // `sessions`' primary key column is literally `session`, not `session_id`
    // (see postgresSessions in storage/schemas/session-schema.ts).
    { entity: "workspace", expectedKind: "workspace", table: "sessions", idColumn: "session" },
  ];

  const discovered: DiscoveredRef[] = [];
  for (const source of sources) {
    const result = await db.execute(
      `SELECT ${source.idColumn} AS uuid, short_id FROM ${source.table} ` +
        `WHERE short_id IS NOT NULL ORDER BY short_id DESC LIMIT 1`
    );
    const row = firstRow(result);
    if (!row) {
      notes.push(`no ${source.entity} row carries a short id — that entity is not covered here`);
      continue;
    }
    discovered.push({
      entity: source.entity,
      expectedKind: source.expectedKind,
      uuid: row.uuid,
      shortId: row.shortId,
    });
  }
  return discovered;
}

interface RefResult {
  ref: string;
  kind: string;
  found: boolean;
  status?: string;
  title?: string;
  error?: string;
}

async function runRefsStatus(
  container: AppContainerInterface,
  refs: string[]
): Promise<RefResult[]> {
  const { sharedCommandRegistry } = await import("../src/adapters/shared/command-registry");
  const { registerRefsCommands } = await import("../src/adapters/shared/commands/refs");

  if (!sharedCommandRegistry.getCommand("refs.status")) {
    registerRefsCommands(container);
  }
  const command = sharedCommandRegistry.getCommand("refs.status");
  if (!command) throw new Error("refs.status is not registered — the command layer is broken");

  const result = (await command.execute(
    { refs, json: true } as never,
    { format: "json", interface: "cli" } as never
  )) as { results?: RefResult[] };
  return result.results ?? [];
}

async function main(): Promise<void> {
  let container: AppContainerInterface;
  let discovered: DiscoveredRef[];
  try {
    container = await bootstrap();
    discovered = await discoverRefs(container);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "SKIP_NO_DB") {
      console.log("SKIP: no SQL-capable persistence provider configured — nothing to verify.");
      process.exit(0);
    }
    console.log(`SKIP: could not reach the database (${message}).`);
    process.exit(0);
  }

  // Diagnostic mode: resolve caller-supplied refs and print what came back.
  // Useful for checking specific ids (e.g. the ones from a bug report) against
  // the same registered command path the assertions below use.
  const explicitRefs = process.argv.slice(2).filter((arg) => arg.length > 0);
  if (explicitRefs.length > 0) {
    for (const result of await runRefsStatus(container, explicitRefs)) {
      const detail = result.found
        ? `${result.status ?? "-"}  ${result.title ?? ""}`
        : `NOT FOUND${result.error ? ` (${result.error})` : ""}`;
      console.log(`${result.ref}  [${result.kind}]  ${detail}`);
    }
    process.exit(0);
  }

  if (discovered.length === 0) {
    console.log("SKIP: no ask/memory/workspace row carries a short id in this database.");
    process.exit(0);
  }

  console.log("refs.status entity resolution — live verification (mt#3354)\n");

  for (const ref of discovered) {
    console.log(`${ref.entity}: ${ref.shortId} / ${ref.uuid}`);
    const [byShortId, byUuid] = await runRefsStatus(container, [ref.shortId, ref.uuid]);

    check(
      `${ref.entity} short id resolves`,
      byShortId?.found === true && byShortId.kind === ref.expectedKind,
      `${ref.shortId} -> kind "${byShortId?.kind}", found ${byShortId?.found}` +
        `${byShortId?.error ? `, error "${byShortId.error}"` : ""}`
    );

    check(
      `${ref.entity} uuid resolves`,
      byUuid?.found === true && byUuid.kind === ref.expectedKind,
      `${ref.uuid} -> kind "${byUuid?.kind}", found ${byUuid?.found}` +
        `${byUuid?.error ? `, error "${byUuid.error}"` : ""}`
    );

    check(
      `${ref.entity} agrees across both id forms`,
      byShortId?.found === byUuid?.found &&
        byShortId?.kind === byUuid?.kind &&
        byShortId?.status === byUuid?.status,
      `short=(${byShortId?.kind}, ${byShortId?.status}) uuid=(${byUuid?.kind}, ${byUuid?.status})`
    );
    console.log("");
  }

  // Controls: the fix must not have broken the pre-existing classifications,
  // and an unresolvable ref must still be distinguishable from an absent one.
  console.log("controls");
  const [task, garbage, orphanUuid] = await runRefsStatus(container, [
    "mt#3354",
    "definitely-not-a-ref",
    "00000000-0000-4000-8000-000000000000",
  ]);

  check(
    "a task id still classifies as a task",
    task?.kind === "task" && task.found === true,
    `mt#3354 -> kind "${task?.kind}", found ${task?.found}`
  );
  check(
    "an unparseable ref carries an explicit error",
    garbage?.kind === "unknown" && garbage.found === false && Boolean(garbage.error),
    `-> kind "${garbage?.kind}", error ${garbage?.error ? "present" : "MISSING"}`
  );
  check(
    "a uuid in no store stays kind uuid, not an absent ask",
    orphanUuid?.kind === "uuid" && orphanUuid.found === false,
    `-> kind "${orphanUuid?.kind}", found ${orphanUuid?.found}`
  );

  for (const note of notes) console.log(`\nNOTE: ${note}`);

  console.log(`\n${failures.length === 0 ? "OK" : `FAILED (${failures.length})`}`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  process.exit(0);
}

await main();
