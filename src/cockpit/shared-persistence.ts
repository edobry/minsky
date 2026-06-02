/**
 * Shared PersistenceService singleton for cockpit (mt#2102).
 *
 * All cockpit widgets and server endpoints use this single instance instead of
 * creating their own. Avoids opening redundant postgres-js pools — each cockpit
 * process would otherwise hold its own pool of up to
 * DEFAULT_POSTGRES_MAX_CONNECTIONS sockets against the shared Supabase
 * transaction pooler (port 6543). The pooler's practical ceiling is in the
 * thousands (memory 63fbc195), so this is pool hygiene, not deadlock avoidance:
 * the prior "max 3 per instance = deadlock risk" framing predated the
 * 2026-04-24 session->transaction pooler migration and was retired by mt#2224.
 *
 * Init-coalescing: concurrent callers await the same initialization promise.
 * Failure-reset: if initialize() rejects, the promise is cleared so retries work.
 */
import type { PersistenceService } from "@minsky/domain/persistence/service";
import type { PersistenceProvider } from "@minsky/domain/persistence/types";
import { log } from "@minsky/shared/logger";

/**
 * Default deadline for the one-time PersistenceService.initialize() call.
 * If initialize() neither resolves nor rejects within this window (a hang —
 * e.g. an Octokit network call with no timeout, mt#2245), the cached init
 * promise is cleared so the NEXT caller retries with fresh state instead of
 * joining a promise that will never settle (the "zombie singleton" wedge that
 * would otherwise affect every DB-backed widget). Mirrors the Promise.race
 * init-timeout pattern at widgets/agents.ts:156-160. (mt#2244)
 */
export const PERSISTENCE_INIT_TIMEOUT_MS = 10_000;

/** Thrown when PersistenceService.initialize() exceeds the init deadline. */
export class PersistenceInitTimeoutError extends Error {
  constructor(readonly elapsedMs: number) {
    super(`PersistenceService.initialize() timed out after ${elapsedMs}ms`);
    this.name = "PersistenceInitTimeoutError";
  }
}

/**
 * Factory for the PersistenceService instance. Defaults to dynamically importing
 * and constructing the real service; overridable as a test seam so the
 * init-timeout/reset behaviour can be unit-tested without a live database — and
 * without `mock.module`, which persists across bun:test files and would poison
 * other suites (see adapters/shared/commands/observability.test.ts).
 */
export type PersistenceServiceFactory = () => Promise<PersistenceService>;

const defaultServiceFactory: PersistenceServiceFactory = async () => {
  const { PersistenceService } = await import("@minsky/domain/persistence/service");
  return new PersistenceService();
};

let _instance: PersistenceService | null = null;
let _initPromise: Promise<PersistenceService> | null = null;

export async function getSharedPersistenceService(
  initTimeoutMs: number = PERSISTENCE_INIT_TIMEOUT_MS,
  createService: PersistenceServiceFactory = defaultServiceFactory
): Promise<PersistenceService> {
  if (_instance) return _instance;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const startedAt = Date.now();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const svc = await createService();
      try {
        await Promise.race([
          svc.initialize(),
          new Promise<never>((_resolve, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new PersistenceInitTimeoutError(Date.now() - startedAt)),
              initTimeoutMs
            );
          }),
        ]);
      } finally {
        // Always clear the timer so a settled initialize() doesn't leave a
        // dangling handle holding the event loop open.
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
      _instance = svc;
      return svc;
    } catch (err) {
      // Clear the cached promise so the NEXT caller retries with fresh state,
      // whether initialize() rejected OR timed out. Without the timeout+reset a
      // hang would wedge every subsequent caller forever (mt#2244).
      _initPromise = null;
      if (err instanceof PersistenceInitTimeoutError) {
        log.warn(
          `[shared-persistence] PersistenceService.initialize() timed out after ` +
            `${err.elapsedMs}ms — cleared cached init promise so the next caller retries`
        );
      }
      throw err;
    }
  })();

  return _initPromise;
}

export async function getSharedProvider(): Promise<PersistenceProvider> {
  const svc = await getSharedPersistenceService();
  return svc.getProvider();
}

/**
 * Test-only: reset the cached singleton + init promise so each test starts from
 * a clean slate. Exported because the singleton state is module-level and bun
 * shares module state across test files in one process (the same hazard noted
 * in adapters/shared/commands/observability.test.ts). Not for production use.
 */
export function __resetSharedPersistenceForTests(): void {
  _instance = null;
  _initPromise = null;
}
