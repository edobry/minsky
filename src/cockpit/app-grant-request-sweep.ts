/**
 * App-grant request resolution tick (mt#4693).
 *
 * The cockpit-side invocation path for the domain resolver: one pass that closes
 * every pending App-grant request whose repository the installation now covers.
 * The decision logic lives in
 * `@minsky/domain/setup/app-grant-request-resolver`; this module is only the
 * glue that gives it a production caller and keeps its failures off the sweep it
 * rides on.
 *
 * **Why it rides the stale-ask tick rather than owning a timer.** Same
 * repository, same cadence, and the same job as its credential sibling —
 * reconciling pending asks against what is actually true now. A second interval
 * would buy nothing, and per `sweepers.ts` an interval invisible to the sweep
 * liveness snapshot is exactly what mt#4313 exists to stop shipping.
 *
 * **Why a sweep at all.** The grant happens in a browser on github.com. Minsky
 * receives no webhook for an installation-repository change it did not make, so
 * there is nothing to call back from — coverage presence is the only signal, and
 * polling for it is the mechanism rather than a fallback.
 *
 * @see packages/domain/src/setup/app-grant-request-resolver.ts — the resolver this invokes
 * @see src/cockpit/credential-request-sweep.ts — the sibling this is modelled on
 */
import { log } from "@minsky/shared/logger";
import type { AskRepository } from "@minsky/domain/ask/repository";

/**
 * Run one App-grant request resolution pass.
 *
 * Never throws: a failure here must not mask the sweep this rides on, nor be
 * masked by it, so the error is logged and the tick continues. Idempotent —
 * terminal rows are filtered out by the resolver's selector, so a second pass
 * over the same requests does nothing.
 *
 * Both the resolver and the configuration are imported dynamically because this
 * runs inside an already-async tick, and the cockpit boot path should not pay
 * for the GitHub App subsystem until a tick actually fires.
 */
export async function runAppGrantRequestResolutionTick(repo: AskRepository): Promise<void> {
  try {
    const [{ getConfiguration }, { createTokenProvider }, { GitHubAppTokenProvider }] =
      await Promise.all([
        import("@minsky/domain/configuration"),
        import("@minsky/domain/auth"),
        import("@minsky/domain/auth/github-app-token-provider"),
      ]);

    const cfg = getConfiguration();
    const provider = createTokenProvider(cfg.github ?? {}, cfg.github?.token ?? "");
    // No App configured means no installation to poll — not an error, and the
    // overwhelmingly common case for an instance that never onboarded one.
    if (!(provider instanceof GitHubAppTokenProvider)) return;

    const { createAppGrantRequestResolverDeps, resolveSatisfiedAppGrantRequests } = await import(
      "@minsky/domain/setup/app-grant-request-resolver"
    );

    const outcome = await resolveSatisfiedAppGrantRequests(
      createAppGrantRequestResolverDeps(repo, provider)
    );
    if (outcome.satisfied.length > 0 || outcome.raced.length > 0) {
      log.info("cockpit: app-grant requests resolved", {
        satisfied: outcome.satisfied.length,
        raced: outcome.raced.length,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("cockpit: app-grant request resolution failed", { message });
  }
}
