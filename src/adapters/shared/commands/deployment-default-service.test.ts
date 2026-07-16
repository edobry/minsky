/**
 * readConfiguredDefaultDeploymentService tests (mt#2821).
 *
 * Covers the `deployment.defaultService` config-key lookup that
 * disambiguates deployment_status / deployment_wait-for-latest /
 * deployment_logs when a project declares more than one
 * services/<svc>/deploy.config.ts. Follows the same
 * initializeConfiguration/CustomConfigFactory pattern as
 * packages/domain/src/configuration/bot-identity.test.ts, restoring an
 * unconfigured state at the end so this file doesn't leak a configured
 * default into other tests running in the same process.
 */
import { describe, it, expect } from "bun:test";
import { readConfiguredDefaultDeploymentService } from "./deployment";
import { initializeConfiguration, CustomConfigFactory } from "@minsky/domain/configuration/index";

describe("readConfiguredDefaultDeploymentService", () => {
  it("returns undefined when nothing is configured", async () => {
    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, {
      overrides: {},
      skipValidation: true,
    });

    const result = await readConfiguredDefaultDeploymentService();
    expect(result).toBeUndefined();
  });

  it("returns the configured deployment.defaultService value", async () => {
    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, {
      overrides: {
        deployment: { defaultService: "reviewer" },
      },
      skipValidation: true,
    });

    const result = await readConfiguredDefaultDeploymentService();
    expect(result).toBe("reviewer");

    // Restore an unconfigured state so this file doesn't leak a configured
    // default into other tests running in the same process.
    await initializeConfiguration(factory, {
      overrides: {},
      skipValidation: true,
    });
    expect(await readConfiguredDefaultDeploymentService()).toBeUndefined();
  });

  it("trims whitespace and treats a whitespace-only value as unset", async () => {
    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, {
      overrides: {
        deployment: { defaultService: "   " },
      },
      skipValidation: true,
    });

    expect(await readConfiguredDefaultDeploymentService()).toBeUndefined();

    await initializeConfiguration(factory, {
      overrides: {},
      skipValidation: true,
    });
  });
});
