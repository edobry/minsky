/**
 * Deployment-target declaration for the `minsky-mcp` service.
 *
 * Platform-agnostic in shape; v1 only supports `"railway"`. Project/service
 * IDs are imported from `./railway.config.ts` to avoid duplication — that
 * file is the env-var synthesizer manifest (mt#1437) and the canonical
 * source for Railway identifiers.
 *
 * Updated in mt#2107: switched from RAILPACK builder to image-based deploy
 * using the GHCR image `ghcr.io/edobry/minsky:latest`. The `build` block is
 * removed because image-based deploys do not use Railway's build system.
 *
 * Note on `source.repo` + `source.branch`: the live serviceInstance returns
 * `source: null` for the repo binding. minsky-mcp deploys via the GHCR
 * image declared in `source.image`. The `source.repo` and `source.branch`
 * fields are intentionally omitted so the synthesizer does not try to
 * reconcile a non-existent repo binding.
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
      // Image-based deploy: Railway pulls the pre-built GHCR image instead
      // of building from source. No build block is required for this mode.
      image: "ghcr.io/edobry/minsky:latest",
    },
  },
});
