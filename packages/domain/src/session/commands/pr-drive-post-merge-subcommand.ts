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
    options: { timeoutSeconds?: number; pollIntervalSeconds?: number }
  ) => Promise<DeploymentRecord>;
}

export interface SessionPrDrivePostMergeResult {
  /** Services actually watched (post detection/override). */
  watchedServices: string[];
  /** Per-service terminal deployment record, in `watchedServices` order. */
  results: Array<{ service: string; deployment: DeploymentRecord }>;
  /** True when there was nothing to watch (no deploy-surface changes / empty override). */
  skipped: boolean;
  skipReason?: string;
  /** Deploy-surface files the auto-detection matched (empty when `services` was explicit). */
  matchedFiles: string[];
}

async function defaultWaitForDeployment(
  service: string,
  options: { timeoutSeconds?: number; pollIntervalSeconds?: number }
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
      const resolvedContext = await resolveSessionContextWithFeedback({
        sessionId: params.sessionId,
        task: params.task,
        repo: params.repo,
        sessionProvider: sessionDB,
        allowAutoDetection: true,
      });

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
      };
    }

    const results: Array<{ service: string; deployment: DeploymentRecord }> = [];
    for (const service of services) {
      const deployment = await waitForDeployment(service, {
        timeoutSeconds: params.deployTimeoutSeconds,
        pollIntervalSeconds: params.deployIntervalSeconds,
      });
      results.push({ service, deployment });
    }

    return { watchedServices: services, results, skipped: false, matchedFiles };
  } catch (error) {
    if (error instanceof ResourceNotFoundError || error instanceof MinskyError) {
      throw error;
    }
    throw new MinskyError(
      `Failed to run post-merge deploy watch for session PR: ${getErrorMessage(error)}`
    );
  }
}
