/**
 * Deployment-target declaration for the `minsky-reviewer-webhook` Railway service.
 *
 * Platform-agnostic in shape; v1 only supports `"railway"`. Railway IDs
 * are inlined here — the canonical IaC source is now `infra/index.ts`
 * (Pulumi with TF bridge, mt#2110).
 *
 * # Consumer (how this file is found)
 *
 * `src/domain/deployment/service-resolver.ts` (`loadDeploymentConfig`)
 * resolves a service name into a config path purely by convention:
 *
 *     resolve(projectRoot, "services", service, "deploy.config.ts")
 *
 * See docs/deployment-platforms.md for the full design.
 *
 * # mt#3117 — converted from repo-source to image-source deploy
 *
 * Previously this service deployed via Railway's native repo+Dockerfile
 * source build (`build.builder: "RAILPACK"` / `dockerfilePath`), triggered
 * by Railway's own GitHub webhook on every push to `main` matching
 * `services/reviewer/railway.json`'s `build.watchPatterns`. That native
 * trigger is now disabled — `.github/workflows/deploy-reviewer.yml` builds,
 * smoke-tests, migrates, and pushes the image instead — and this config is
 * switched to `source.image`, the SAME shape
 * `services/minsky-mcp/deploy.config.ts` already uses. `railway.json` is
 * retired: mt#2472 established that Railway rejects `config_path`
 * alongside `source_image` ("Invalid Attribute Combination"), so a
 * source-build railway.json cannot coexist with this image-source config.
 * See `infra/index.ts`'s `reviewerService` resource for the corresponding
 * Pulumi-side change, and `services/reviewer/DEPLOY.md` for the live
 * dashboard flip this implies (an operator step performed after merge,
 * NOT part of this PR).
 */

import { defineDeployment } from "@minsky/shared/deployment-config";

export default defineDeployment({
  platform: "railway",
  // Health URL for post-deploy health monitor (mt#1302).
  // Source of truth — do not hardcode this URL in monitor scripts.
  healthUrl: "https://minsky-reviewer-webhook-production.up.railway.app/health",
  railway: {
    projectId: "41e5ee9c-49e6-44ff-9bfe-7f03d0e94d4b",
    environmentId: "b3ea3f5d-8560-40ea-8824-17fe3ca0b32a",
    serviceId: "3913e8a4-81ab-465a-aad8-b76b5e3f66ed",
    source: {
      image: "ghcr.io/edobry/minsky-reviewer:latest",
    },
  },
});
