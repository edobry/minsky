/**
 * Deployment-target declaration for the `minsky-site` marketing service.
 *
 * Platform-agnostic in shape; v1 only supports `"railway"`. Project/service
 * IDs are imported from `./railway.config.ts` to avoid duplication — that
 * file is the env-var synthesizer manifest and the canonical source for
 * Railway identifiers. IDs are placeholders pending principal-authorized
 * service provisioning (see railway.config.ts header comment).
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
  },
});
