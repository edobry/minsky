/**
 * Deployment-target declaration for the `minsky-mcp` service.
 *
 * Platform-agnostic in shape; v1 only supports `"railway"`. Project/service
 * IDs are imported from `./railway.config.ts` to avoid duplication — that
 * file is the env-var synthesizer manifest (mt#1437) and the canonical
 * source for Railway identifiers.
 *
 * Source + build blocks declared per mt#2001 — match live Railway state
 * discovered 2026-05-21 via `fetchServiceInstanceState`. The synthesizer
 * (mt#2000) reports clean diff against this declaration.
 *
 * Note on `source` field: the live serviceInstance returns `source: null`
 * (no repo binding visible on the instance). minsky-mcp deploys via
 * project-level Railway GitHub App integration. The `source` block is
 * intentionally omitted here so the synthesizer's partial-spec diff
 * does not reconcile it.
 *
 * See docs/deployment-platforms.md for the full design.
 */

import { defineDeployment } from "@minsky/shared/deployment-config";
import railwayConfig from "./railway.config";

export default defineDeployment({
  platform: "railway",
  railway: {
    projectId: railwayConfig.projectId,
    environmentId: railwayConfig.environmentId,
    serviceId: railwayConfig.serviceId,
    // source intentionally omitted — live state has source: null (project-
    // level GitHub App integration; no serviceInstance.source binding).
    build: {
      // Live state confirmed RAILPACK (Railway's evolved build system,
      // successor to NIXPACKS for this project).
      builder: "RAILPACK",
    },
  },
});
