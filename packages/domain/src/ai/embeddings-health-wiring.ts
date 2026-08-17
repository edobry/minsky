/**
 * Host wiring for `EmbeddingsHealthTracker`'s degradation events (mt#4218).
 *
 * `EmbeddingsHealthTracker` is a per-process singleton, and its event emitter is
 * a dependency the process's ENTRY POINT has to register. So whether an
 * embeddings degradation is recorded depends on who started the process — and
 * an unregistered emitter is indistinguishable, at the `system_events` table,
 * from "no degradation happened". That is the second failure mode
 * `work-completion.mdc §Invocation path required for event/poll mechanisms`
 * names: the mechanism runs, a dependency inside it is dead, and the failure is
 * converted into the same value a legitimately-empty result produces.
 *
 * Until mt#4218 only `minsky mcp start` registered anything. The cockpit daemon
 * runs the per-turn transcript embedding pipeline in-process
 * (`src/cockpit/sweepers.ts`), and the CLI runs `index-embeddings` commands, and
 * neither recorded a single event. Observed 2026-08-17: a degradation ran for
 * six hours while the newest `embeddings.provider_degraded` row in the database
 * was from 2026-07-31.
 *
 * ## Why this is a helper rather than copied wiring
 *
 * A shared helper does NOT by itself make the gap unacquirable — a helper still
 * has to be CALLED, and a host forgetting to call it is precisely the defect
 * above. What it removes is the duplicated provider-to-emitter construction, so
 * a new host's wiring is one line rather than a block that can be subtly wrong.
 * The omission half is covered by `embeddings-health-wiring.test.ts`, which
 * enumerates the known host entry points and fails when one stops registering.
 *
 * ## Why the resolver is a callback, and why it runs per emit
 *
 * Each host resolves persistence differently and that part is genuinely not
 * shareable: the MCP server and the CLI have a DI container, while the cockpit
 * daemon has a module-level singleton (`src/cockpit/shared-persistence.ts`).
 *
 * The resolver is invoked on EVERY emit rather than once at registration, which
 * matters most for the cockpit. Its shared pool is torn down and rebuilt on
 * sustained degradation (`recycleSharedPersistence`), and a handle cached across
 * that boundary raises `CONNECTION_ENDED` forever — postgres-js sets an `ending`
 * flag that nothing clears. That is the mt#3721 failure, observed 2026-08-05
 * with five widget endpoints serving placeholders eight minutes after a
 * successful recycle. Registering a builder rather than an emitter also means a
 * host may register BEFORE persistence is ready, since nothing is resolved until
 * the first degradation.
 *
 * @see mt#2147 — the original MCP-only wiring
 * @see mt#2568 — the per-call builder seam this registers against
 * @see mt#4212 — the incident whose root-cause analysis surfaced this gap
 */

import { log } from "@minsky/shared/logger";
import type { AppContainerInterface } from "../composition/types";
import { buildEventEmitterFromProvider } from "../events/emit-best-effort";
import type { PersistenceProvider } from "../persistence/types";
import { EmbeddingsHealthTracker } from "./embeddings-health-tracker";

/**
 * A host's own way of reaching its persistence provider. Returning `undefined`
 * means "not available right now" — a normal state during startup, and not an
 * error.
 */
export type PersistenceProviderResolver = () => Promise<PersistenceProvider | undefined>;

/**
 * The container-backed resolver, shared by the two DI hosts — the MCP server and
 * the CLI.
 *
 * Lives here rather than in either host so they cannot drift: they are the same
 * lookup, and the point of this module is that a host's wiring is one line. The
 * cockpit daemon has no container and supplies its own resolver instead.
 *
 * Returns `undefined` rather than throwing when persistence is absent or not yet
 * registered, which is the ordinary state during startup — the CLI registers in
 * `createCli`, before its `preAction` hook has initialized anything.
 */
export async function resolveContainerPersistence(
  container: AppContainerInterface
): Promise<PersistenceProvider | undefined> {
  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!persistence) return undefined;

  // Duck-typed for the same reason `buildEventEmitterFromProvider` is: an
  // `instanceof` test is brittle across DI and test bindings that implement the
  // interface structurally rather than nominally.
  const candidate = persistence as PersistenceProvider;
  return typeof (candidate as { getDatabaseConnection?: unknown }).getDatabaseConnection ===
    "function"
    ? candidate
    : undefined;
}

/**
 * Register `resolveProvider` as the source of the tracker's degradation-event
 * emitter for this process. Idempotent in effect: a later call replaces the
 * registration, which is what a test reset wants and what no production host
 * does twice.
 *
 * Changes no emission POLICY. Whether to emit, and the confirmed-emit latch that
 * keeps a transient failure retriable, stay entirely inside
 * `EmbeddingsHealthTracker` (mt#2568, PR #2284 R2).
 */
export function registerEmbeddingsHealthEventEmitter(
  resolveProvider: PersistenceProviderResolver
): void {
  EmbeddingsHealthTracker.registerEventEmitterBuilder(async () => {
    try {
      return await buildEventEmitterFromProvider(await resolveProvider());
    } catch (err) {
      // The tracker catches builder failures too, but its message cannot say
      // which host's resolver threw — and with several hosts registering the
      // same seam, that is the one detail worth having in the log.
      log.debug("embeddings-health-wiring: could not resolve a persistence provider", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  });
}
