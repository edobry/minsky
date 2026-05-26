/**
 * Deployment-target declaration for the `cockpit-preview` Railway service
 * (mt#2096).
 *
 * Platform-agnostic in shape; v1 only supports `"railway"`. Project/service
 * IDs are imported from `./railway.config.ts` to avoid duplication.
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
    source: {
      repo: "edobry/minsky",
      branch: "main",
      rootDirectory: "",
    },
    build: {
      builder: "RAILPACK",
      dockerfilePath: "services/cockpit/Dockerfile",
    },
  },
});
