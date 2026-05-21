/**
 * Railway implementation of `DeploymentPlatformAdapter`. v1 concrete adapter
 * for the platform-agnostic abstraction defined in
 * docs/deployment-platforms.md.
 *
 * Uses the Railway GraphQL primitives in ./graphql-client.ts (extracted from
 * scripts/railway/{status,logs}.ts in mt#1730). No fresh shell-out to the
 * `railway` CLI is introduced.
 *
 * Tracking task: mt#1730.
 */

import { injectable } from "tsyringe";

import type { DeploymentConfig, RailwayDeploymentConfig } from "../config";
import {
  type DeploymentPlatformAdapter,
  type DeploymentRecord,
  type DeploymentStatus,
  DeploymentWaitTimeoutError,
  isTerminalStatus,
  type LogLine,
  type LogType,
  type WaitForLatestOptions,
} from "../types";
import {
  fetchBuildLogs,
  fetchDeploymentById,
  fetchDeploymentLogs,
  fetchDeployments,
  getValidRailwayToken,
  type RailwayDeploymentNode,
} from "./graphql-client";

const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_POLL_INTERVAL_SECONDS = 10;
const DEFAULT_LOG_LINES = 100;

/**
 * Railway-native status → normalized DeploymentStatus.
 * See docs/deployment-platforms.md for the table.
 */
function normalizeStatus(railwayStatus: string): DeploymentStatus {
  switch (railwayStatus.toUpperCase()) {
    case "SUCCESS":
      return "SUCCESS";
    case "FAILED":
      return "FAILED";
    case "CRASHED":
      return "CRASHED";
    case "BUILDING":
    case "INITIALIZING":
    case "WAITING":
      return "BUILDING";
    case "DEPLOYING":
      return "DEPLOYING";
    case "REMOVED":
      return "CANCELLED";
    case "ERROR":
      return "FAILED";
    default:
      return "UNKNOWN";
  }
}

/**
 * Best-effort Railway deployment URL. Railway exposes a `staticUrl` on
 * deployment nodes; when absent, return null.
 */
function deploymentUrl(node: RailwayDeploymentNode): string | null {
  return node.staticUrl ?? null;
}

function toRecord(node: RailwayDeploymentNode): DeploymentRecord {
  const status = normalizeStatus(node.status);
  const createdAt = node.createdAt;
  // Railway does not currently expose a finishedAt on the node; durationMs is
  // unknown until the platform exposes it.
  return {
    id: node.id,
    status,
    commitHash: node.meta?.commitHash ?? null,
    commitMessage: node.meta?.commitMessage ?? null,
    createdAt,
    finishedAt: null,
    durationMs: null,
    url: deploymentUrl(node),
  };
}

@injectable()
export class RailwayDeploymentAdapter implements DeploymentPlatformAdapter {
  constructor(private readonly config: RailwayDeploymentConfig) {}

  async getLatestDeploymentStatus(): Promise<DeploymentRecord> {
    const token = await getValidRailwayToken();
    const deployments = await fetchDeployments(this.config.serviceId, 1, token);
    const latest = deployments[0];
    if (!latest) {
      throw new Error(
        `No deployments found for Railway service ${this.config.serviceId}. ` +
          "Has the service deployed at least once?"
      );
    }
    return toRecord(latest);
  }

  async waitForLatestDeployment(options?: WaitForLatestOptions): Promise<DeploymentRecord> {
    const timeoutSeconds = options?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const pollIntervalSeconds = options?.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
    const deadline = Date.now() + timeoutSeconds * 1000;

    // Identify the deployment we're waiting on at start time. If a new
    // deployment kicks off mid-wait (e.g., another push) we will still be
    // tracking the one that was latest at call time — by design, since the
    // caller's intent is "the deploy I just pushed."
    const token = await getValidRailwayToken();
    const initial = await fetchDeployments(this.config.serviceId, 1, token);
    const initialNode = initial[0];
    if (!initialNode) {
      throw new Error(
        `No deployments found for Railway service ${this.config.serviceId}. ` +
          "Cannot wait — has the service deployed at least once?"
      );
    }
    const targetId = initialNode.id;

    let lastRecord: DeploymentRecord = toRecord(initialNode);
    if (isTerminalStatus(lastRecord.status)) {
      return lastRecord;
    }

    while (Date.now() < deadline) {
      await sleep(pollIntervalSeconds * 1000);

      // Fetch the targeted deployment by ID directly, so we don't depend on
      // it remaining in the service's most-recent-N deployments window —
      // high-frequency deploys would otherwise cause it to fall out of view
      // while still in progress and trip a false-CANCELLED.
      const found = await fetchDeploymentById(targetId, token);
      if (!found) {
        // Railway returned no record for this deployment ID. This is genuinely
        // unusual (deletion / retention) — surface as a typed error rather
        // than silently masking as CANCELLED. Caller can inspect lastRecord
        // for the last known state.
        throw new Error(
          `Railway deployment ${targetId} disappeared during waitForLatestDeployment. ` +
            `Last observed status: ${lastRecord.status}. The deployment may have been ` +
            `deleted; check the Railway dashboard.`
        );
      }
      lastRecord = toRecord(found);
      if (isTerminalStatus(lastRecord.status)) {
        return lastRecord;
      }
    }

    throw new DeploymentWaitTimeoutError(timeoutSeconds, lastRecord.status, lastRecord);
  }

  async getDeploymentLogs(
    deploymentId: string,
    type: LogType,
    lines: number = DEFAULT_LOG_LINES
  ): Promise<LogLine[]> {
    const token = await getValidRailwayToken();
    const entries =
      type === "build"
        ? await fetchBuildLogs(deploymentId, lines, token)
        : await fetchDeploymentLogs(deploymentId, lines, token);
    return entries.map((e) => ({
      timestamp: e.timestamp,
      severity: e.severity,
      message: e.message,
    }));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Adapter factory used by the registry. `config` is the discriminated union;
 * we narrow on the `platform` field and forward the railway-specific block.
 */
export function railwayAdapterFactory(config: DeploymentConfig): RailwayDeploymentAdapter {
  if (config.platform !== "railway") {
    throw new Error(
      `railwayAdapterFactory invoked with non-railway config (platform="${config.platform}")`
    );
  }
  return new RailwayDeploymentAdapter(config.railway);
}
