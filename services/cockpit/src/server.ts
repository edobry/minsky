#!/usr/bin/env bun
import "reflect-metadata";
import { setupConfiguration } from "@minsky/domain/config-setup";
import { log } from "../../../src/utils/logger";

await setupConfiguration();

const { createCockpitServer } = await import("../../../src/cockpit/server");
const { initServerSseBroker } = await import("../../../src/cockpit/routes/events");

const PORT = parseInt(process.env.PORT || "3000", 10);

await initServerSseBroker();

// mt#2538: this entrypoint is out of scope for the local-daemon security
// hardening (it deliberately binds 0.0.0.0 for the Railway platform proxy
// and is reached via a Railway-assigned public hostname, which can never
// satisfy the loopback-only Host-header allowlist createCockpitServer now
// enforces by default). `isPublicDeployment: true` preserves this
// deployment's pre-mt#2538 behavior exactly — see the CockpitServerOptions
// doc comment in src/cockpit/server.ts.
const app = createCockpitServer({ isPublicDeployment: true });
app.listen(PORT, "0.0.0.0", () => {
  const mode = process.env.MINSKY_COCKPIT_PREVIEW === "true" ? " (preview mode)" : "";
  log.info(`Cockpit running on port ${PORT}${mode}`);
});
