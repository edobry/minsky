/**
 * Deployment-target declaration for the `minsky-reviewer-webhook` Railway service.
 *
 * Platform-agnostic in shape; v1 only supports `"railway"`. Project/service
 * IDs are imported from `./railway.config.ts` to avoid duplication — that
 * file is the env-var synthesizer manifest and the canonical source for
 * Railway identifiers (see its header for the resource-ID-update protocol
 * if the service is ever recreated).
 *
 * Mirrors the shape of `services/site/deploy.config.ts`. The reviewer is
 * built from a Dockerfile (`services/reviewer/Dockerfile`) while services/site
 * uses Nixpacks; both ship to Railway as separately-deployed services, and
 * `defineDeployment`'s discriminator gates only on `platform: "railway"` plus
 * the three IDs — the underlying build method is irrelevant to the abstraction.
 *
 * # Consumer (how this file is found)
 *
 * `src/domain/deployment/service-resolver.ts` (`loadDeploymentConfig`, line ~90)
 * resolves a service name into a config path purely by convention:
 *
 *     resolve(projectRoot, "services", service, "deploy.config.ts")
 *
 * So `mcp__minsky__deployment_status service:"reviewer"` mechanically reads
 * this file — no registry update or service-name mapping is required.
 * `listServicesWithDeployConfig` (line ~64) walks `services/` and includes
 * any directory containing `deploy.config.ts`; after this file lands, the
 * walk returns `["reviewer", "site"]` (sorted).
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
      // Empty string = repo root. The reviewer build context is the repo
      // root because the Dockerfile uses workspace COPY semantics
      // (services/reviewer/Dockerfile copies from / to enable the
      // @minsky/shared workspace dep).
      rootDirectory: "",
    },
    build: {
      // Live state has RAILPACK builder despite dockerfilePath being set —
      // RAILPACK is Railway's evolved build system; it picks up the
      // Dockerfile path automatically when declared.
      builder: "RAILPACK",
      dockerfilePath: "services/reviewer/Dockerfile",
    },
  },
});
