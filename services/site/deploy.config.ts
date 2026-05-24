/**
 * Deployment-target declaration for the `minsky-site` marketing service.
 *
 * Platform-agnostic in shape; v1 only supports `"railway"`. Project/service
 * IDs are imported from `./railway.config.ts` to avoid duplication — that
 * file is the env-var synthesizer manifest and the canonical source for
 * Railway identifiers, and carries the real production resource IDs for
 * the existing `minsky-site` Railway project (see its header for the
 * reuse-of-existing-project decision and the Postgres-cleanup followup).
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
    // Source + build declared per mt#2001 — match live Railway state
    // discovered 2026-05-21 via `fetchServiceInstanceState`. The synthesizer
    // (mt#2000) reports clean diff against this declaration.
    source: {
      repo: "edobry/minsky",
      // branch is write-through (not on serviceInstance read); declared
      // as conventional "main" — synthesizer reports ADD on first run.
      branch: "main",
      rootDirectory: "services/site",
    },
    build: {
      // Live state confirmed NIXPACKS for the static-site Astro build.
      builder: "NIXPACKS",
    },
  },
});
