/**
 * Deployment-target declaration for the `cockpit-preview` Railway service
 * (mt#2096; real Railway IDs filled in mt#2401 after the project was
 * provisioned).
 *
 * Platform-agnostic in shape; v1 only supports `"railway"`. The canonical
 * IaC source is `infra/index.ts` (Pulumi with TF bridge, mt#2110); these IDs
 * mirror the `cockpit` block there.
 *
 * See docs/deployment-platforms.md for the full design.
 */

import { defineDeployment } from "@minsky/shared/deployment-config";

export default defineDeployment({
  platform: "railway",
  // Health URL for post-deploy health monitor (mt#1302). Cockpit exposes /api/health
  // (not /health) — verified via cockpit-preview.yml.
  // Source of truth — do not hardcode this URL in monitor scripts.
  healthUrl: "https://cockpit-preview-production.up.railway.app/api/health",
  railway: {
    projectId: "62db6727-ed10-415e-afc5-7188c9983c81",
    environmentId: "cc3d2bc3-13cc-4061-9633-cd58f48dc3fe",
    serviceId: "83273eef-b451-42af-b3e4-7e1c42b8bb50",
    // No `source` binding, deliberately (mt#3996; mirrors infra/index.ts
    // cockpitService, mt#3832). This service is deployed ONLY by
    // .github/workflows/cockpit-preview.yml (`railway up --service
    // cockpit-preview`): PR-push previews plus a restore-from-main on PR close,
    // for PRs touching src/cockpit/** or services/cockpit/**. Pushes to main do
    // NOT auto-deploy it — declaring repo+branch here would assert (and, if
    // applied to the live service, arm) a Railway-native trigger with none of
    // the workflow's path scoping, so a push to main would stomp an in-review
    // PR's preview. The live service keeps a residual repo link with NO branch
    // trigger (repoTriggers empty, verified via Railway GraphQL 2026-08-12);
    // clearing that residual is mt#3318's remaining item.
    build: {
      builder: "RAILPACK",
      dockerfilePath: "services/cockpit/Dockerfile",
    },
  },
});
