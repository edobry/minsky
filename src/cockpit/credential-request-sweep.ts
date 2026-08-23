/**
 * Credential-request resolution tick (mt#4030).
 *
 * The cockpit-side invocation path for the domain resolver: one pass that closes
 * every pending credential request whose credential has since appeared. The
 * decision logic lives in `@minsky/domain/credentials/request-resolver`; this
 * module is only the glue that gives it a production caller and keeps its
 * failures off the sweep it rides on.
 *
 * **Why it rides the stale-ask tick rather than owning a timer.** Same
 * repository, same cadence, and the same job — reconciling pending asks against
 * what is actually true now. A second interval would buy nothing and add a
 * second thing to reason about.
 *
 * **Why presence is the whole signal.** The request must resolve however the
 * credential arrived: through the cockpit form, through `config credentials add`
 * in a terminal, or because it was already configured before the request was
 * filed. That is what makes this a sweep rather than a callback on the add
 * route, and why there is no second place for the principal to confirm.
 *
 * @see packages/domain/src/credentials/request-resolver.ts — the resolver this invokes
 * @see packages/domain/src/credentials/request.ts — the pure decision logic beneath it
 */
import { log } from "@minsky/shared/logger";
import type { AskRepository } from "@minsky/domain/ask/repository";

/**
 * Run one credential-request resolution pass.
 *
 * Never throws: a failure here must not mask the sweep this rides on, nor be
 * masked by it, so the error is logged and the tick continues. Idempotent —
 * terminal rows are filtered out by the resolver's selector, so a second pass
 * over the same requests does nothing.
 *
 * The resolver is imported dynamically because this runs inside an already-async
 * tick and the cockpit boot path should not pay for the credentials subsystem
 * until a tick actually fires.
 */
export async function runCredentialRequestResolutionTick(repo: AskRepository): Promise<void> {
  try {
    const { createCredentialRequestResolverDeps, resolveSatisfiedCredentialRequests } =
      await import("@minsky/domain/credentials/request-resolver");
    const outcome = await resolveSatisfiedCredentialRequests(
      createCredentialRequestResolverDeps(repo)
    );
    if (outcome.satisfied.length > 0 || outcome.raced.length > 0) {
      log.info("cockpit: credential requests resolved", {
        satisfied: outcome.satisfied.length,
        raced: outcome.raced.length,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("cockpit: credential-request resolution failed", { message });
  }
}
