#!/usr/bin/env bun
/**
 * Verification artifact for mt#2401 — cockpit-preview deploy.config.ts now
 * carries the real provisioned Railway IDs (replacing the PLACEHOLDER_* stubs
 * from mt#2096) so deploy observability (`deployment_status` /
 * `deployment_wait-for-latest service:"cockpit"`) routes to a live service
 * instead of returning "Not Authorized at service".
 *
 * Two layers:
 *
 *   1. STATIC (always runs, no auth): resolve the cockpit deploy config the
 *      same way the deployment tooling does, and assert the railway IDs are
 *      real — no `PLACEHOLDER`/`REPLACE` strings, and each is a well-formed
 *      UUID. This alone is a regression guard against the exact drift this
 *      task fixed (a placeholder ID silently surviving past provisioning).
 *
 *   2. LIVE (gated on ~/.railway/config.json): resolve the Railway adapter and
 *      call getLatestDeploymentStatus(). A successful return proves the IDs
 *      resolve to a real Railway service (the pre-fix config threw
 *      "Not Authorized at service" here). SKIPs gracefully (exit 0) when the
 *      Railway CLI credential is absent, so it is safe in env-less CI /
 *      subagent contexts.
 *
 * Usage:
 *   bun scripts/smoke-mt2401-cockpit-deploy-config.ts
 *
 * Exit codes: 0 = pass or skip, non-zero = fail.
 */

import "reflect-metadata";

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveAdapter, resolveDeploymentConfig } from "@minsky/domain/deployment";

/** The service whose deploy config this smoke test verifies. */
const SERVICE = "cockpit";

const RAILWAY_CONFIG = join(homedir(), ".railway", "config.json");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<number> {
  // --- Layer 1: static config check (always runs) -------------------------
  const { config } = await resolveDeploymentConfig(SERVICE);

  if (config.platform !== "railway") {
    console.error(`FAIL: expected platform "railway", got "${config.platform}"`);
    return 1;
  }

  const { projectId, environmentId, serviceId } = config.railway;
  const ids = { projectId, environmentId, serviceId };

  const failures: string[] = [];
  for (const [name, value] of Object.entries(ids)) {
    if (/PLACEHOLDER|REPLACE/i.test(value)) {
      failures.push(`${name} is still a placeholder: "${value}"`);
    } else if (!UUID_RE.test(value)) {
      failures.push(`${name} is not a well-formed UUID: "${value}"`);
    }
  }

  if (failures.length > 0) {
    console.error(`FAIL (static):\n - ${failures.join("\n - ")}`);
    return 1;
  }

  console.log(`PASS (static): cockpit deploy.config.ts IDs are real UUIDs:`);
  console.log(JSON.stringify(ids, null, 2));

  // --- Layer 2: live resolution check (gated on Railway auth) -------------
  if (!existsSync(RAILWAY_CONFIG)) {
    console.log(
      `SKIP (live): ${RAILWAY_CONFIG} not present — Railway CLI not authenticated. ` +
        `Static check passed; run with a Railway credential to verify live routing.`
    );
    return 0;
  }

  const adapter = resolveAdapter(config);
  const record = await adapter.getLatestDeploymentStatus();
  console.log(`PASS (live): cockpit IDs resolve to a real Railway deployment record:`);
  console.log(JSON.stringify(record, null, 2));
  // Note: the record's status may be FAILED — that is a separate deploy-health
  // concern (see mt#2401 PR body). The point of this check is that the IDs
  // RESOLVE (no "Not Authorized at service"), which restores observability.
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FAIL: uncaught error", err);
    process.exit(1);
  });
