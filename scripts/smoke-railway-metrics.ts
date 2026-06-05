#!/usr/bin/env bun
/**
 * Live verification artifact for mt#2296 — first-party Railway service-metrics
 * + restart-count domain queries.
 *
 * Resolves the deployment adapter for the `minsky-mcp` service from its
 * canonical deploy config and exercises the two new domain methods against the
 * live Railway GraphQL API:
 *
 *   - getServiceMetrics() → CPU % / memory %
 *   - getRestartCount()   → integer restart count over a 24h window
 *
 * Gating: requires `~/.railway/config.json` (the Railway CLI credential the
 * domain client reads via getValidRailwayToken). When absent, the script
 * SKIPs gracefully (exit 0) so it is safe to run in env-less CI / subagent
 * contexts.
 *
 * Usage:
 *   bun scripts/smoke-railway-metrics.ts
 *
 * Exit codes: 0 = pass or skip, non-zero = fail.
 */

import "reflect-metadata";

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveAdapter } from "@minsky/domain/deployment";

import minskyMcpDeployConfig from "../services/minsky-mcp/deploy.config";

const RAILWAY_CONFIG = join(homedir(), ".railway", "config.json");

async function main(): Promise<number> {
  if (!existsSync(RAILWAY_CONFIG)) {
    console.log(`SKIP: ${RAILWAY_CONFIG} not present — Railway CLI not authenticated.`);
    return 0;
  }

  const adapter = resolveAdapter(minskyMcpDeployConfig);

  if (typeof adapter.getServiceMetrics !== "function") {
    console.error("FAIL: resolved adapter does not implement getServiceMetrics()");
    return 1;
  }
  if (typeof adapter.getRestartCount !== "function") {
    console.error("FAIL: resolved adapter does not implement getRestartCount()");
    return 1;
  }

  const metrics = await adapter.getServiceMetrics();
  const restarts = await adapter.getRestartCount(24);

  const results = { metrics, restarts };
  console.log(JSON.stringify(results, null, 2));

  const failures: string[] = [];
  if (metrics.cpuPercent === null) {
    failures.push("cpuPercent is null (expected a number)");
  }
  if (metrics.memoryPercent === null) {
    failures.push("memoryPercent is null (expected a number)");
  }
  if (!Number.isInteger(restarts.count)) {
    failures.push(`restart count is not an integer: ${restarts.count}`);
  }

  if (failures.length > 0) {
    console.error(`FAIL:\n - ${failures.join("\n - ")}`);
    return 1;
  }

  console.log(
    `PASS: CPU ${metrics.cpuPercent?.toFixed(2)}%, memory ${metrics.memoryPercent?.toFixed(2)}%, ` +
      `restarts(24h)=${restarts.count}`
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FAIL: uncaught error", err);
    process.exit(1);
  });
