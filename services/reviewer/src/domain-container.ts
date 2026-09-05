/**
 * Domain container bootstrap for the reviewer service.
 *
 * Manages the lifecycle of the @minsky/domain container: creates it,
 * initializes it (which opens the DB connection), and exposes the resolved
 * services that background loops need (sessionProvider, taskService,
 * persistenceProvider).
 *
 * Called once at startup from server.ts (import.meta.main block), before
 * the background loops start. The container stays alive for the process
 * lifetime; there is no close() call on graceful shutdown (the DB connection
 * pool drains naturally when the process exits).
 *
 * ## Why a separate module
 *
 * Keeps the domain bootstrap concerns out of server.ts (which is already
 * large) and makes the domain service types importable by individual
 * scheduler modules without duplicating the import chain.
 *
 * @see mt#2121 — reviewer service migration from MCP-over-HTTP to domain imports
 * @see packages/domain/src/composition/domain.ts — createDomainContainer()
 */

import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { SessionProviderInterface } from "@minsky/domain/session";
import type { TaskServiceInterface } from "@minsky/domain/tasks";
import type {
  BasePersistenceProvider,
  SqlCapablePersistenceProvider,
} from "@minsky/domain/persistence/types";
import type { MemoryLookup, AskLookup } from "./short-id-fetch";
import type { RunReviewDeps } from "./review-worker";

export interface DomainServices {
  container: AppContainerInterface;
  sessionProvider: SessionProviderInterface;
  taskService: TaskServiceInterface;
  persistenceProvider: BasePersistenceProvider;
  /**
   * `mem#N` / `ask#N` criteria-reference lookups (mt#3964) — see
   * `short-id-fetch.ts`'s module doc for why these are built here rather
   * than reusing a cockpit-style cached short-id map: the reviewer is a
   * separately deployed service and must not depend on the cockpit daemon
   * being up. `ws#N` needs no equivalent field — `sessionProvider` above
   * already resolves it via `getSession`.
   */
  memoryLookup: MemoryLookup;
  askLookup: AskLookup;
}

/**
 * Resolve a raw drizzle db connection from `persistenceProvider`, or null
 * when it lacks SQL capability. Mirrors `src/adapters/shared/commands/refs.ts`'s
 * `getDb(container)` helper — same capability check, same
 * `getDatabaseConnection()` call — since `refs.status`'s ask/memory/workspace
 * resolvers face exactly the same "resolve a short id against its own table"
 * problem this module solves for the reviewer.
 *
 * Deliberately NOT captured once at boot and reused: `getDatabaseConnection()`
 * is called fresh on each lookup so a pool recycle (mt#3721's lesson, applied
 * here defensively) can't leave a stale handle behind.
 */
async function getSqlDb(
  provider: BasePersistenceProvider
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  if (!provider.capabilities.sql) return null;
  const sqlProvider = provider as SqlCapablePersistenceProvider;
  if (typeof sqlProvider.getDatabaseConnection !== "function") return null;
  return (await sqlProvider.getDatabaseConnection()) ?? null;
}

/**
 * Build a `MemoryLookup` over `persistenceProvider`. Uses the standalone
 * `getMemoryRecordById` (mt#3964) rather than constructing a full
 * `MemoryService` — that would additionally require an `embeddingService`
 * and `vectorStorage`, neither of which a by-id content read touches, and
 * the reviewer has no other reason to hold an embedding client.
 */
function buildMemoryLookup(persistenceProvider: BasePersistenceProvider): MemoryLookup {
  return {
    async get(id: string) {
      const db = await getSqlDb(persistenceProvider);
      if (!db) return null;
      const { getMemoryRecordById } = await import("@minsky/domain/memory");
      return getMemoryRecordById(db, id);
    },
  };
}

/** Build an `AskLookup` over `persistenceProvider`, mirroring `buildMemoryLookup` above. */
function buildAskLookup(persistenceProvider: BasePersistenceProvider): AskLookup {
  return {
    async getById(id: string) {
      const db = await getSqlDb(persistenceProvider);
      if (!db) return null;
      const { DrizzleAskRepository } = await import("@minsky/domain/ask/repository");
      return new DrizzleAskRepository(db).getById(id);
    },
  };
}

/**
 * Boot the domain container and return resolved services.
 *
 * Calls createDomainContainer() which handles configuration initialization
 * idempotently (setupConfiguration() if not yet called). Calls
 * container.initialize() to resolve all factories and open the DB connection.
 *
 * Throws on misconfiguration (missing MINSKY_PERSISTENCE_POSTGRES_URL) or
 * DB connection failure — these are fatal at startup.
 */
export async function bootDomainContainer(): Promise<DomainServices> {
  const { createDomainContainer } = await import("@minsky/domain/composition/domain");

  const container = await createDomainContainer();
  await container.initialize();

  const sessionProvider = container.get("sessionProvider");
  const taskService = container.get("taskService");
  const persistenceProvider = container.get("persistence");
  const memoryLookup = buildMemoryLookup(persistenceProvider);
  const askLookup = buildAskLookup(persistenceProvider);

  return { container, sessionProvider, taskService, persistenceProvider, memoryLookup, askLookup };
}

/**
 * The subset of `RunReviewDeps` that carries DOMAIN CONTEXT into a review —
 * as opposed to the test seams that make up the rest of that interface.
 *
 * Every one of these is silently optional in `runReview`, and each degrades a
 * different part of the review rather than failing it:
 *
 * | Missing dep           | Consequence                                              |
 * | --------------------- | -------------------------------------------------------- |
 * | `taskService`         | `resolveTaskSpec` → null → `specVerification: []`         |
 * | `persistenceProvider` | `resolveTier` skips ProvenanceService → `Tier: unknown`   |
 * | `memoryLookup`        | `mem#N` criteria references unresolved (mt#3964)          |
 * | `askLookup`           | `ask#N` criteria references unresolved (mt#3964)          |
 * | `sessionLookup`       | `ws#N` criteria references unresolved (mt#3964)           |
 *
 * @see mt#4998 — the defect that motivated extracting this.
 */
export type ReviewDomainDeps = Pick<
  RunReviewDeps,
  "taskService" | "persistenceProvider" | "memoryLookup" | "askLookup" | "sessionLookup"
>;

/**
 * Map booted `DomainServices` onto the review's domain-context deps.
 *
 * ## Why this exists rather than each caller spreading the fields itself
 *
 * There are three `runReview` entry points — the webhook handler, boot
 * recovery, and the missed-review sweeper's retrigger — and until mt#4998 each
 * assembled this object by hand. Two did it identically; the sweeper passed
 * only `{ db }`, so EVERY sweeper-initiated review ran with no tier resolution
 * and no bound-task spec, posting `Tier: unknown` with an empty
 * `specVerification` array. Nothing failed, because each dep degrades quietly
 * by design (see the table above) — the review simply came out weaker than the
 * one a webhook would have produced for the same commit.
 *
 * A hand-assembled dep list is exactly the shape that admits that defect: the
 * omission is invisible at the call site and invisible in the output. One
 * builder means a fourth entry point cannot repeat it.
 *
 * Returns `{}` when the container never booted (DB-less or degraded start), so
 * callers keep today's graceful-degradation behaviour rather than throwing —
 * the sweeper is a best-effort safety net and must still run without a
 * container.
 *
 * @see mt#2121 — the direct-domain-import path these deps came from.
 * @see mt#4998 — the sweeper omission this closes.
 */
export function buildReviewDomainDeps(domainServices?: DomainServices): ReviewDomainDeps {
  if (!domainServices) return {};
  return {
    taskService: domainServices.taskService,
    persistenceProvider: domainServices.persistenceProvider,
    // mt#3964: mem#N / ask#N / ws#N criteria-reference resolution.
    memoryLookup: domainServices.memoryLookup,
    askLookup: domainServices.askLookup,
    sessionLookup: domainServices.sessionProvider,
  };
}
