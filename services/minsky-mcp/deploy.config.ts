/**
 * Deployment-target declaration for the `minsky-mcp` service.
 *
 * Platform-agnostic in shape; v1 only supports `"railway"`. Railway IDs
 * are inlined here — the canonical IaC source is now `infra/index.ts`
 * (Pulumi with TF bridge, mt#2110).
 *
 * Updated in mt#2107: switched from RAILPACK builder to image-based deploy
 * using the GHCR image `ghcr.io/edobry/minsky:latest`. The `build` block is
 * removed because image-based deploys do not use Railway's build system.
 *
 * See docs/deployment-platforms.md for the full design.
 */

import { defineDeployment } from "@minsky/shared/deployment-config";

export default defineDeployment({
  platform: "railway",
  railway: {
    projectId: "0e054318-7e19-4489-8e1e-de787965161d",
    environmentId: "0289b171-1514-4540-ac93-19b30da3e2c0",
    serviceId: "a7c5195f-55de-472a-87e4-34e921a15171",
    source: {
      image: "ghcr.io/edobry/minsky:latest",
    },
  },
});
