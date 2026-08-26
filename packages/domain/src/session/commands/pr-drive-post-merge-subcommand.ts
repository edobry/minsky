/**
 * Session PR Drive — Post-Merge Deploy Watch (mt#2647)
 *
 * The second mode of `session.pr.drive` (`postMerge: true`). Since the merge
 * call itself stays with the orchestrator (see `pr-drive-subcommand.ts`'s
 * doc-comment for why), this mode is invoked AFTER the orchestrator's own
 * `session.pr.merge` call succeeds, to compose the existing
 * `deployment.wait-for-latest` waiter across every deploy service the merged
 * PR affected — reusing `findAffectedServices` (mt#2647,
 * `@minsky/domain/deployment`) for detection instead of reimplementing a
 * deploy-surface classifier.
 *
 * Affected-service resolution:
 *  - `params.services` (explicit) wins when provided — no PR-diff lookup.
 *  - Otherwise, the session's merged PR's changed files are listed via
 *    `RepositoryBackend.review.listChangedFiles` and matched through
 *    `findAffectedServices` against the services that declare a
 *    `deploy.config.ts` (`listServicesWithDeployConfig`).
 *  - Zero affected services (not a deploy-surface PR, or the explicit list
 *    was empty) resolves with `skipped: true` — nothing to watch.
 */

import { MinskyError, ResourceNotFoundError, getErrorMessage } from "../../errors/index";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import type { SessionProviderInterface } from "../types";
import type { RepositoryBackend } from "../../repository/index";
import { createRepositoryBackendFromSession } from "../session-pr-operations";
import {
  findAffectedServices,
  listServicesWithDeployConfig,
  resolveAdapter,
  resolveDeploymentConfig,
  assessBuildIdentity,
  type BuildIdentity,
  type DeploymentRecord,
} from "../../deployment/index";

export interface SessionPrDrivePostMergeParams {
  sessionId?: string;
  task?: string;
  repo?: string;
  /** Explicit affected-services override — skips changed-file auto-detection. */
  services?: string[];
  /** Max seconds to wait for each service's deployment (default 600). */
  deployTimeoutSeconds?: number;
  /** Poll interval in seconds for each service's deployment wait (default 10). */
  deployIntervalSeconds?: number;
  /**
   * ISO8601 timestamp of the merge this watch is verifying — `mergeInfo.mergeDate`
   * from the `session.pr.merge` that immediately preceded this call (mt#3890).
   *
   * Threaded to `waitForLatestDeployment`'s `notBefore` so a deployment that
   * predates the merge cannot satisfy the watch. Without it the watch accepts
   * whatever deployment is newest — which is how `minsky-mcp` reported a
   * healthy post-merge deploy for 4.5 days while its redeploy step was
   * silently unauthorized and no deployment was ever created.
   *
   * Omitting it is still permitted (existing callers, and the manual
   * `--postMerge` invocation) but the result records `deployBoundApplied:
   * false` so an unbounded — and therefore unfalsifiable — check is visible
   * rather than silent.
   */
  mergedAt?: string;
  /**
   * The merge COMMIT this watch is verifying — `mergeInfo.commitHash` from the
   * same `session.pr.merge` that supplied `mergedAt` (mt#4583).
   *
   * `mergedAt` bounds the deployment's TIME; this names its IDENTITY. They are
   * different questions and the first does not answer the second: on a busy
   * branch a NEIGHBOURING merge's deployment lands inside the window and
   * satisfies the bound. Each per-service result therefore carries a
   * `buildIdentity` verdict; `deployBoundApplied` reports only that the TIME
   * bound was applied, which is exactly as reassuring — and exactly as
   * uninformative about identity — as the SUCCESS it accompanies.
   */
  mergedCommitSha?: string;
}

export interface SessionPrDrivePostMergeDependencies {
  sessionDB: SessionProviderInterface;
  /** Test seam: override backend creation. Defaults to the session-derived backend. */
  createBackend?: (
    sessionRecord: Parameters<typeof createRepositoryBackendFromSession>[0],
    sessionDB: SessionProviderInterface
  ) => Promise<RepositoryBackend>;
  /** Test seam: list services that declare a deploy.config.ts. Defaults to filesystem scan. */
  listAvailableServices?: () => string[];
  /**
   * Test seam: wait for a service's latest deployment. Defaults to
   * `resolveDeploymentConfig(service)` + `resolveAdapter(config).waitForLatestDeployment(...)`
   * — the same production path `deployment.wait-for-latest` uses.
   */
  waitForDeployment?: (
    service: string,
    options: { timeoutSeconds?: number; pollIntervalSeconds?: number; notBefore?: string }
  ) => Promise<DeploymentRecord>;
}

export interface SessionPrDrivePostMergeResult {
  /** Services actually watched (post detection/override). */
  watchedServices: string[];
  /**
   * Per-service terminal deployment record, in `watchedServices` order.
   *
   * `buildIdentity` (mt#4583) answers whether THAT service's deployment carries
   * the merge named by `mergedCommitSha` — a different question from
   * `deployBoundApplied` below, which reports only that the TIME bound was
   * applied. Per-service because services deploy independently: one can carry
   * this merge while another still serves a neighbour's build, and a single
   * aggregate verdict would hide that.
   *
   * `indeterminate` is NOT a pass. It is the expected verdict for an
   * image-source service, whose deployment record carries no commit at all.
   */
  results: Array<{
    service: string;
    deployment: DeploymentRecord;
    buildIdentity: BuildIdentity;
    buildIdentityReason: string;
  }>;
  /** True when there was nothing to watch (no deploy-surface changes / empty override). */
  skipped: boolean;
  skipReason?: string;
  /** Deploy-surface files the auto-detection matched (empty when `services` was explicit). */
  matchedFiles: string[];
  /**
   * Whether the deployment waits were bounded to deployments created after the
   * merge (mt#3890). False when no `mergedAt` was supplied, in which case a
   * PRE-EXISTING deployment can satisfy the watch and a SUCCESS here is not
   * evidence that this merge deployed. Surfaced so an unfalsifiable check is
   * visible in the result rather than indistinguishable from a real one.
   */
  deployBoundApplied: boolean;
}

async function defaultWaitForDeployment(
  service: string,
  options: { timeoutSeconds?: number; pollIntervalSeconds?: number; notBefore?: string }
): Promise<DeploymentRecord> {
  const { config } = await resolveDeploymentConfig(service);
  const adapter = resolveAdapter(config);
  return adapter.waitForLatestDeployment(options);
}

/**
 * Watch every deploy service affected by a just-merged session PR through to
 * a terminal deployment state. Call AFTER the orchestrator's own
 * `session.pr.merge` succeeds — this function does not merge anything.
 */
export async function sessionPrDrivePostMerge(
  params: SessionPrDrivePostMergeParams,
  deps: SessionPrDrivePostMergeDependencies
): Promise<SessionPrDrivePostMergeResult> {
  const listAvailableServices = deps.listAvailableServices ?? listServicesWithDeployConfig;
  const waitForDeployment = deps.waitForDeployment ?? defaultWaitForDeployment;

  try {
    let services: string[];
    let matchedFiles: string[] = [];

    if (params.services !== undefined) {
      // An explicit override wins outright — including an explicitly EMPTY
      // array, which means "nothing to watch" and must NOT silently fall
      // through to auto-detection.
      services = [...new Set(params.services)].sort();
    } else {
      const { sessionDB } = deps;

      // This mode runs AFTER a merge, and a successful merge CLEANS UP the
      // session — so `--task` / `--session-id` routinely fails to resolve here
      // for the most ordinary reason there is, and the bare "No session found
      // for task ID" that surfaced gave no hint that (a) this is expected and
      // (b) two working alternatives exist. Naming them is the whole fix: the
      // caller is mid-verification and a dead end costs a re-derivation
      // (mt#4425).
      let resolvedContext;
      try {
        resolvedContext = await resolveSessionContextWithFeedback({
          sessionId: params.sessionId,
          task: params.task,
          repo: params.repo,
          sessionProvider: sessionDB,
          allowAutoDetection: true,
        });
      } catch (err) {
        const target = params.task ?? params.sessionId ?? "(auto-detect)";
        throw new ResourceNotFoundError(
          `Could not resolve a session for ${target} to auto-detect deploy services.\n\n` +
            `If the merge already succeeded this is EXPECTED — merging cleans the session up, ` +
            `so post-merge mode cannot reach it by task or session id afterwards.\n\n` +
            `Two ways forward:\n` +
            `  - Pass an explicit \`services\` list to skip session-based auto-detection.\n` +
            `  - Verify the deploy directly, which needs no session at all:\n` +
            `      bun scripts/verify-deploy.ts <service> --merged-at <iso> --commit <merge-sha>\n\n` +
            `Underlying resolution error: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const sessionRecord = await sessionDB.getSession(resolvedContext.sessionId);
      if (!sessionRecord) {
        throw new ResourceNotFoundError(`Session '${resolvedContext.sessionId}' not found`);
      }

      const prNumber = sessionRecord.pullRequest?.number;
      if (!prNumber) {
        throw new ResourceNotFoundError(
          `No pull request found for session '${resolvedContext.sessionId}'. ` +
            `Cannot auto-detect affected deploy services without a PR — pass an ` +
            `explicit \`services\` list instead.`
        );
      }

      const createBackend = deps.createBackend ?? createRepositoryBackendFromSession;
      const backend = await createBackend(sessionRecord, sessionDB);
      if (!backend.review.listChangedFiles) {
        throw new MinskyError(
          `Repository backend does not support listing changed files. ` +
            `Pass an explicit \`services\` list to session.pr.drive's postMerge mode ` +
            `on this backend.`
        );
      }

      const changedFiles = await backend.review.listChangedFiles(prNumber);
      const available = listAvailableServices();
      const detection = findAffectedServices(
        changedFiles.map((f) => f.filename),
        available
      );
      services = detection.services;
      matchedFiles = detection.matchedFiles;
    }

    if (services.length === 0) {
      return {
        watchedServices: [],
        results: [],
        skipped: true,
        skipReason:
          params.services !== undefined
            ? "explicit services list was empty"
            : "no deploy-surface files changed by this PR",
        matchedFiles,
        // Nothing was watched, so the bound is vacuously irrelevant — report
        // it as applied rather than implying an unbounded check happened.
        deployBoundApplied: true,
      };
    }

    const results: Array<{
      service: string;
      deployment: DeploymentRecord;
      buildIdentity: BuildIdentity;
      buildIdentityReason: string;
    }> = [];
    for (const service of services) {
      const deployment = await waitForDeployment(service, {
        timeoutSeconds: params.deployTimeoutSeconds,
        pollIntervalSeconds: params.deployIntervalSeconds,
        notBefore: params.mergedAt,
      });
      // mt#4583: per-service, because services deploy independently — one can
      // carry this merge while another is still serving a neighbour's build,
      // and a single aggregate verdict would hide that.
      const identity = assessBuildIdentity(deployment, params.mergedCommitSha);
      results.push({
        service,
        deployment,
        buildIdentity: identity.identity,
        buildIdentityReason: identity.reason,
      });
    }

    return {
      watchedServices: services,
      results,
      skipped: false,
      matchedFiles,
      deployBoundApplied: params.mergedAt !== undefined,
    };
  } catch (error) {
    if (error instanceof ResourceNotFoundError || error instanceof MinskyError) {
      throw error;
    }
    throw new MinskyError(
      `Failed to run post-merge deploy watch for session PR: ${getErrorMessage(error)}`
    );
  }
}
