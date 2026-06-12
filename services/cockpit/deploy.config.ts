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
    source: {
      repo: "edobry/minsky",
      branch: "main",
      // "/" (repo root), matching infra/index.ts and the live Railway value
      // (mt#2449). This field is the drift-detection baseline; "" diverged from
      // the live "/" and would false-positive drift. Repo-root services use "/"
      // here (cf. services/minsky-ops); services/site uses its subdir.
      rootDirectory: "/",
    },
    build: {
      builder: "RAILPACK",
      dockerfilePath: "services/cockpit/Dockerfile",
    },
  },
});
