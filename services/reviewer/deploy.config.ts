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
