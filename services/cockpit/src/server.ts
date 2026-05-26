#!/usr/bin/env bun
import "reflect-metadata";
import { createCockpitServer, initServerSseBroker } from "../../../src/cockpit/server";
import { log } from "../../../src/utils/logger";

const PORT = parseInt(process.env.PORT || "3000", 10);

await initServerSseBroker();

const app = createCockpitServer();
app.listen(PORT, "0.0.0.0", () => {
  const mode = process.env.MINSKY_COCKPIT_PREVIEW === "true" ? " (preview mode)" : "";
  log.info(`Cockpit running on port ${PORT}${mode}`);
});
