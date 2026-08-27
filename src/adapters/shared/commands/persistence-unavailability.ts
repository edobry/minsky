/**
 * Shared "why can't this command reach the database?" describer (mt#3661).
 *
 * Commands that need a SQL-capable provider build their repository from the DI
 * container and get `null` back when persistence cannot serve them. They then
 * fail LOUDLY — a thrown error, never a plausible-looking empty result — so
 * this is message quality, not correctness.
 *
 * What the bare "persistence provider does not support SQL" text costs is the
 * OPERATOR'S NEXT MOVE. ADR-035 rule 3 requires "configured but failing" to stay
 * distinguishable from "not configured": the first is an outage to wait out, the
 * second is a config to fix. Both produce identical capability flags, so a
 * message that reports only the flag has erased a distinction the provider still
 * holds. `describePersistenceUnavailability` (mt#3636) renders it; this wraps the
 * container-resolution step every adapter-side caller would otherwise repeat.
 *
 * Extracted from `requireAskRepository` in `./asks.ts`, which mt#3636 wrote
 * first; that function now calls this instead of carrying its own copy.
 *
 * NEVER throws. A diagnosis step that fails must not replace the failure it was
 * called to describe — it falls back to the same bare sentence the callers used
 * before this existed.
 */
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import { describePersistenceUnavailability } from "@minsky/domain/persistence/unconfigured-provider";
import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

/** The pre-mt#3661 message, and the fallback when the provider can't be read. */
// sql-capability-message: the fallback constant this module exists to replace
// at call sites — the one place the bare sentence is still the right answer.
export const BARE_SQL_CAPABILITY_MESSAGE = "The active persistence provider is not SQL-capable.";

/**
 * Resolve the persistence provider from `container` and describe why it cannot
 * serve DB-backed work. Returns a sentence intended to follow a caller's prefix.
 *
 * @param logScope short caller name for the warn line if the diagnosis fails
 *   (e.g. `"pr-watch"`), so a failed describe is attributable.
 */
export async function describeContainerPersistenceUnavailability(
  container: AppContainerInterface | undefined,
  logScope: string
): Promise<string> {
  try {
    if (container?.has("persistence")) {
      return describePersistenceUnavailability(container.get("persistence"));
    }
  } catch (err: unknown) {
    log.warn(`${logScope}: could not describe persistence unavailability`, {
      error: getLoggableErrorSummary(err),
    });
  }
  return BARE_SQL_CAPABILITY_MESSAGE;
}
