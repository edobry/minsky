/**
 * Deployment-target declaration for the `cockpit-preview` Railway service
 * (mt#2096).
 *
 * Platform-agnostic in shape; v1 only supports `"railway"`. Railway IDs
 * are placeholders — replace after Railway project creation. The canonical
 * IaC source is `infra/index.ts` (Pulumi with TF bridge, mt#2110).
 *
 * See docs/deployment-platforms.md for the full design.
 */

import { defineDeployment } from "@minsky/shared/deployment-config";

export default defineDeployment({
  platform: "railway",
  railway: {
    projectId: "PLACEHOLDER_PROJECT_ID",
    environmentId: "PLACEHOLDER_ENVIRONMENT_ID",
    serviceId: "PLACEHOLDER_SERVICE_ID",
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
