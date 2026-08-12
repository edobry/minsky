#!/usr/bin/env bun
import "reflect-metadata";
import { setupConfiguration } from "@minsky/domain/config-setup";
import { log } from "../../../src/utils/logger";

await setupConfiguration();

const { createCockpitServer } = await import("../../../src/cockpit/server");
const { initServerSseBroker } = await import("../../../src/cockpit/routes/events");

const PORT = parseInt(process.env.PORT || "3000", 10);

await initServerSseBroker();

// This entrypoint binds 0.0.0.0 for the Railway platform proxy and is reached
// via a Railway-assigned public hostname, which can never satisfy the
// loopback-only Host-header allowlist createCockpitServer enforces by default
// (mt#2538, which ruled this deployment out of its scope).
//
// `isPublicDeployment: true` therefore still turns OFF the two loopback-shaped
// defenses — but as of mt#4023 it turns ON a WebAuthn passkey gate in their
// place, so this flag no longer means "no auth". It previously did, and this
// deployment served the live corpus to anyone holding the URL. See the
// CockpitServerOptions doc comment in src/cockpit/server.ts.
const app = createCockpitServer({ isPublicDeployment: true });
app.listen(PORT, "0.0.0.0", () => {
  const mode = process.env.MINSKY_COCKPIT_PREVIEW === "true" ? " (preview mode)" : "";
  log.info(`Cockpit running on port ${PORT}${mode}`);
});
