/**
 * Deployment-target declaration for the `minsky-site` marketing service.
 *
 * Platform-agnostic in shape; v1 only supports `"railway"`. Railway IDs
 * are inlined here — the canonical IaC source is now `infra/index.ts`
 * (Pulumi with TF bridge, mt#2110).
 *
 * See docs/deployment-platforms.md for the full design.
 */

import { defineDeployment } from "@minsky/shared/deployment-config";

export default defineDeployment({
  platform: "railway",
  railway: {
    projectId: "825920d3-fb22-4163-a50d-0e04fc724774",
    environmentId: "bd90461e-dacf-487c-8594-b50849ade1f0",
    serviceId: "bb4d7cb4-e929-4ab6-83e2-d19cd34f6805",
    source: {
      repo: "edobry/minsky",
      branch: "main",
      rootDirectory: "services/site",
    },
    build: {
      builder: "NIXPACKS",
    },
  },
});
