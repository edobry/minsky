/**
 * `minsky-ops` EngProd toil-miner loop tick (mt#3330).
 *
 * Thin ops-loop adapter: resolves the domain container's persistence
 * provider into a raw Postgres connection, builds the direct-provider
 * `CognitionProvider` (AI-as-API, no MCP/agent loop — mirrors
 * `src/cockpit/sweepers.ts`'s `buildRealTitleSweepDeps`) and the
 * `TaskSimilarityService` (reusing the sanctioned factory from
 * `similarity-commands.ts` rather than re-deriving embedding/vector-storage
 * wiring), and delegates the mining/curation work to
 * `packages/domain/src/engprod/toil-miner-tick.ts`.
 *
 * Registered via `registerLoop` in `start-command.ts` with envPrefix
 * `TOIL_MINER` — disabled by default; production enablement is an explicit
 * operator step after deploy (see this task's PR body).
 */

import type { AppContainerInterface } from "@minsky/domain/composition/types";
import { isSqlCapable } from "@minsky/domain/persistence/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import { describePersistenceUnavailability } from "@minsky/domain/persistence/unconfigured-provider";
import { log } from "@minsky/shared/logger";
import { createTaskSimilarityService } from "../../adapters/shared/commands/tasks/similarity-commands";

/**
 * Parse a strictly-positive integer from an env var. Mirrors
 * `parsePositiveIntEnv` in `start-command.ts` — duplicated (rather than
 * imported) to avoid a circular import between this file and
 * `start-command.ts` (which imports `toilMinerOpsTick` from here).
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\+?\d+$/.test(raw)) {
    throw new Error(`minsky-ops: ${name} must be a positive integer (got "${raw}")`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`minsky-ops: ${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}

/** Parse a positive float (0 < value) from an env var, or return the fallback. */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`minsky-ops: ${name} must be a positive number (got "${raw}")`);
  }
  return value;
}

export async function toilMinerOpsTick(container: AppContainerInterface): Promise<void> {
  const taskService = container.get("taskService");
  const persistence = container.get("persistence");

  // Capability, not method presence (mt#4543). PR #2620 R1 caught this same class here
  // and answered it with the try/catch below, because the `in` check could not: the
  // placeholder DEFINES the method. Asking the capability makes the guard the thing that
  // fires, and the catch below belt-to-braces a provider that claims sql and still fails.
  if (!isSqlCapable(persistence)) {
    throw new Error(
      // Provider already in hand — the domain helper directly (mt#3661).
      `engprod_toil_miner: not SQL-capable — ${describePersistenceUnavailability(persistence)}`
    );
  }
  const sqlPersistence: SqlCapablePersistenceProvider = persistence;
  let db: Awaited<ReturnType<SqlCapablePersistenceProvider["getDatabaseConnection"]>>;
  try {
    db = await sqlPersistence.getDatabaseConnection();
  } catch (err: unknown) {
    // CORRECTED by mt#4543 (PR #3324 R1). This comment used to read: the placeholder
    // "DEFINES getDatabaseConnection (it throws from it), so it passes the capability
    // check above — meaning THIS is the degraded path's actual exit, not that branch."
    // That was true of the `in` check PR #2620 R1 was written against, and the guard
    // above now asks `capabilities.sql`, which the placeholder reports as false. So the
    // GUARD is the degraded path's exit and this catch is no longer where that case
    // lands.
    //
    // It still earns its place: a provider that CLAIMS sql and fails anyway reaches
    // here, and its error already carries the cause — it was just missing the
    // `engprod_toil_miner:` prefix every other exit has, so the same failure read two
    // different ways in an ops log depending on provider shape.
    throw new Error(`engprod_toil_miner: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  if (!db) {
    throw new Error(
      `engprod_toil_miner: getDatabaseConnection() returned null — ${describePersistenceUnavailability(persistence)}`
    );
  }

  const { getConfiguration } = await import("@minsky/domain/configuration");
  const { DefaultAICompletionService } = await import("@minsky/domain/ai/completion-service");
  const { DirectCognitionProvider } = await import("@minsky/domain/cognition/providers/direct");
  const { toilMinerTick } = await import("@minsky/domain/engprod/toil-miner-tick");

  const configService = {
    loadConfiguration: () => Promise.resolve({ resolved: getConfiguration() }),
  };
  const cognitionProvider = new DirectCognitionProvider(
    new DefaultAICompletionService(configService)
  );

  const taskSimilarityService = await createTaskSimilarityService(persistence, taskService);

  log.info("toil_miner.tick_starting", { event: "toil_miner.tick_starting" });

  await toilMinerTick(
    { db, taskService, cognitionProvider, taskSimilarityService },
    {
      windowDays: envInt("TOIL_MINER_WINDOW_DAYS", 14),
      minFrequency: envInt("TOIL_MINER_MIN_FREQUENCY", 3),
      minSessions: envInt("TOIL_MINER_MIN_SESSIONS", 2),
      minChainLength: envInt("TOIL_MINER_MIN_CHAIN_LENGTH", 2),
      maxChainLength: envInt("TOIL_MINER_MAX_CHAIN_LENGTH", 6),
      llmCap: envInt("TOIL_MINER_LLM_CAP", 10),
      budgetCap: envInt("TOIL_MINER_BUDGET_CAP", 5),
      similarityThreshold: envFloat("TOIL_MINER_SIMILARITY_THRESHOLD", 0.2),
      // mt#3429 SC2: fraction of a name-cluster's occurrences a single
      // arg_fingerprint sequence must cover to be proposed as a refined
      // cluster instead of excluded as low-distinctiveness noise.
      fingerprintConcentrationThreshold: envFloat(
        "TOIL_MINER_FINGERPRINT_CONCENTRATION_THRESHOLD",
        0.2
      ),
    }
  );
}
