/**
 * Guard-events commands (mt#4035, mt#3334 phase 3).
 *
 * `guard-events.ingest` — run one sweep tick of the guard/calibration
 * exhaust ingest over every registered stream (`stream-sources.ts`). Called
 * from TWO invocation paths that share this exact command:
 *
 *  - The SessionEnd hook (`.minsky/hooks/guard-events-ingest-on-session-end.ts`)
 *    spawns `minsky guard-events ingest` as a LATENCY optimization.
 *  - The cockpit daemon sweeper (`startGuardEventsSweepBackstop`,
 *    `src/cockpit/sweepers.ts`) calls the same underlying
 *    `runGuardEventsIngestSweep` on a periodic cadence — THE CORRECTNESS
 *    LAYER (ADR-017 / mt#2313: SessionEnd does not fire, or complete, on
 *    `/exit`, `/clear`, or an async kill).
 *
 * DI pattern mirrors `transcripts.ts`: the persistence provider is resolved
 * from `context.container` at execute time, not at registration time.
 *
 * @see packages/domain/src/guard-events/ingest-service.ts — the orchestration
 * @see packages/domain/src/guard-events/ingest-runtime.ts — the real deps this wires
 */
import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../command-registry";
import type { SharedCommandRegistry } from "../command-registry";
import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

export interface GuardEventsIngestResult {
  streamsChecked: number;
  totalRead: number;
  totalInserted: number;
  totalErrors: number;
  perStream: Array<{
    stream: string;
    read: number;
    inserted: number;
    skippedNoFile: boolean;
    truncated: boolean;
    error?: string;
  }>;
}

export function registerGuardEventsCommands(
  _container?: AppContainerInterface,
  registry?: SharedCommandRegistry
): void {
  const targetRegistry = registry ?? sharedCommandRegistry;

  targetRegistry.registerCommand({
    id: "guard-events.ingest",
    category: CommandCategory.OBSERVABILITY,
    name: "ingest",
    description:
      "Run one sweep tick of the guard/calibration exhaust ingest (mt#3334 phase 3): reads new " +
      "content since each stream's persisted high-water mark and batch-inserts into guard_events " +
      "(ON CONFLICT dedupe_key DO NOTHING). Incremental and idempotent — safe to re-run over an " +
      "already-ingested span. Called by the SessionEnd hook (latency) and the cockpit sweep " +
      "(correctness — SessionEnd does not reliably fire, per ADR-017/mt#2313).",
    parameters: {
      maxRecordsPerStreamPerTick: {
        schema: z.number().int().positive(),
        description:
          "Cap on new records read per stream per invocation (bounds tick duration on a large " +
          "backlog, e.g. a fresh-deploy fire-log with no prior ingest). Default: 20000.",
        required: false,
      },
    },
    async execute(params, context): Promise<GuardEventsIngestResult> {
      const persistenceProvider = (() => {
        if (context.container?.has("persistence")) {
          return context.container.get(
            "persistence"
          ) as import("@minsky/domain/persistence/types").SqlCapablePersistenceProvider;
        }
        return null;
      })();

      if (!persistenceProvider) {
        throw new Error(
          "DI container missing 'persistence'. Ensure the container was initialized before " +
            "running this command."
        );
      }

      const db = await persistenceProvider.getDatabaseConnection();
      if (!db) {
        throw new Error(
          "getDatabaseConnection() returned null. guard-events.ingest requires a PostgreSQL " +
            "backend with Drizzle ORM."
        );
      }

      const { buildGuardEventsIngestDeps } = await import(
        "@minsky/domain/guard-events/ingest-runtime"
      );
      const { runGuardEventsIngestSweep } = await import(
        "@minsky/domain/guard-events/ingest-service"
      );

      const maxRecordsPerStreamPerTick = params.maxRecordsPerStreamPerTick as number | undefined;
      const deps = buildGuardEventsIngestDeps(
        db as import("drizzle-orm/postgres-js").PostgresJsDatabase,
        { maxRecordsPerStreamPerTick }
      );

      try {
        const summary = await runGuardEventsIngestSweep(deps);
        // SC2: log every per-stream error as the actual error — never
        // collapse a real failure into a silent "nothing to ingest".
        for (const s of summary.perStream) {
          if (s.error) {
            log.warn("guard-events.ingest: stream failed", { stream: s.stream, error: s.error });
          }
        }
        // Unconditional (mt#4035 R1, same reasoning as the cockpit sweep tick):
        // a zero-guarded log here would make "checked everything, nothing new"
        // indistinguishable from a run that never happened.
        log.info("guard-events.ingest complete", {
          streamsChecked: summary.streamsChecked,
          totalRead: summary.totalRead,
          totalInserted: summary.totalInserted,
          totalErrors: summary.totalErrors,
          streamsWithNewRecords: summary.perStream.filter((s) => s.read > 0).length,
        });
        return summary;
      } catch (err) {
        log.error("guard-events.ingest failed", { error: getLoggableErrorSummary(err) });
        throw err;
      }
    },
  });

  log.debug("Guard-events commands registered");
}
