/**
 * `session bindings refresh` command (mt#1628 — iTerm-tab binding v0).
 *
 * Runs one iTerm-tab correlation pass: for every session with a live
 * (pid-confirmed) runtime attachment (mt#2284), classify whether its
 * candidate iTerm tab (from the attachment's self-registered
 * `terminalContext`) is still open right now, and persist the result on
 * `SessionRecord.interfaceBinding`.
 *
 * v0 ships this as an on-demand, operator/CLI-invoked command rather than a
 * scheduled background job — matching the precedent already established by
 * `session ps --reap` (mt#2284's stale-attachment reaper is ALSO manual-only
 * in v0; see `packages/domain/src/session/attachment.ts`). Periodic
 * scheduling (e.g. wiring `runItermCorrelationPass` into the cockpit
 * daemon's `createIntervalSweeper` factory, `src/cockpit/sweepers.ts`) is a
 * natural fast-follow once operator feedback confirms a cadence, but is not
 * required for the v0 slice this task ships — see
 * `docs/architecture/interface-binding-surface-kinds.md`.
 */
import { CommandCategory, type CommandDefinition, type InferParams } from "../../command-registry";
import type {
  PersistenceProvider,
  SqlCapablePersistenceProvider,
} from "@minsky/domain/persistence/types";
import { log } from "@minsky/shared/logger";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { sessionBindingsRefreshCommandParams } from "./session-parameters";

export type SessionBindingsRefreshParams = InferParams<typeof sessionBindingsRefreshCommandParams>;

const BINDINGS_REFRESH_DESCRIPTION =
  "Run one iTerm-tab correlation pass (mt#1628): classifies every session with a live " +
  "runtime attachment (mt#2284) as bound to a currently-open iTerm2 tab (`iterm-tab`) or " +
  "not (`unbound`), and persists the result on the session record. Local-macOS-Minsky " +
  "only -- skips gracefully (no `osascript` invoked) on hosted Minsky or non-darwin hosts.";

export async function executeSessionBindingsRefresh(
  _params: SessionBindingsRefreshParams,
  getDeps: LazySessionDeps,
  getPersistenceProvider?: () => PersistenceProvider | undefined
): Promise<{
  success: true;
  ran: boolean;
  skippedReason?: string;
  updated: Array<{
    sessionId: string;
    binding: { kind: string; surfaceId?: string; lastObservedAt: string };
  }>;
}> {
  const { runItermCorrelationPass } = await import("@minsky/domain/interface-binding/index");

  const provider = getPersistenceProvider?.();
  const sqlProvider = provider as SqlCapablePersistenceProvider | undefined;
  if (!sqlProvider?.getDatabaseConnection) {
    return {
      success: true,
      ran: false,
      skippedReason: "No database connection available -- cannot read stored attachments.",
      updated: [],
    };
  }

  const { buildPresenceClaimRepository } = await import("@minsky/domain/presence/index");
  let repo: ReturnType<typeof buildPresenceClaimRepository> = null;
  try {
    const db = await sqlProvider.getDatabaseConnection();
    if (db) repo = buildPresenceClaimRepository(db);
  } catch (err) {
    log.debug("[session.bindings.refresh] Failed to resolve presence-claim repository", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!repo) {
    return {
      success: true,
      ran: false,
      skippedReason: "Could not build presence-claim repository -- cannot read stored attachments.",
      updated: [],
    };
  }

  const deps = await getDeps();
  const result = await runItermCorrelationPass({
    sessionProvider: deps.sessionProvider,
    presenceRepo: repo,
  });

  return { success: true, ...result };
}

export function createSessionBindingsRefreshCommand(
  getDeps: LazySessionDeps,
  getPersistenceProvider?: () => PersistenceProvider | undefined
): CommandDefinition<typeof sessionBindingsRefreshCommandParams> {
  return {
    id: "session.bindings.refresh",
    category: CommandCategory.SESSION,
    name: "bindings-refresh",
    description: BINDINGS_REFRESH_DESCRIPTION,
    parameters: sessionBindingsRefreshCommandParams,
    mutating: true,
    execute: withErrorLogging("session.bindings.refresh", (params: SessionBindingsRefreshParams) =>
      executeSessionBindingsRefresh(params, getDeps, getPersistenceProvider)
    ),
  };
}
