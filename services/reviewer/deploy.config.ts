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
 */

import { defineDeployment } from "@minsky/shared/deployment-config";

export default defineDeployment({
  platform: "railway",
  railway: {
    projectId: "41e5ee9c-49e6-44ff-9bfe-7f03d0e94d4b",
    environmentId: "b3ea3f5d-8560-40ea-8824-17fe3ca0b32a",
    serviceId: "3913e8a4-81ab-465a-aad8-b76b5e3f66ed",
    source: {
      repo: "edobry/minsky",
      branch: "main",
      rootDirectory: "",
    },
    build: {
      builder: "RAILPACK",
      dockerfilePath: "services/reviewer/Dockerfile",
    },
  },
});
