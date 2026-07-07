#!/usr/bin/env bun
import "reflect-metadata";
import { setupConfiguration } from "@minsky/domain/config-setup";
import { log } from "../../../src/utils/logger";

await setupConfiguration();

const { createCockpitServer } = await import("../../../src/cockpit/server");
const { initServerSseBroker } = await import("../../../src/cockpit/routes/events");

const PORT = parseInt(process.env.PORT || "3000", 10);

await initServerSseBroker();

const app = createCockpitServer();
app.listen(PORT, "0.0.0.0", () => {
  const mode = process.env.MINSKY_COCKPIT_PREVIEW === "true" ? " (preview mode)" : "";
  log.info(`Cockpit running on port ${PORT}${mode}`);
});
