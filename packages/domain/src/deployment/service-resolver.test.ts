/* eslint-disable custom/no-real-fs-in-tests, custom/no-magic-string-duplication --
 * service-resolver inherently reads the filesystem to enumerate
 * services/<svc>/deploy.config.ts files; we test it against an isolated
 * tmpdir rather than refactoring the resolver to accept an fs dependency.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AmbiguousDeploymentServiceError,
  DeploymentConfigNotFoundError,
  listServicesWithDeployConfig,
  NoDeploymentServicesError,
  resolveDeploymentConfig,
} from "./service-resolver";

const FIXTURE_CONFIG_BODY = `
export default {
  platform: "railway",
  railway: { projectId: "p", environmentId: "e", serviceId: "s" },
};
`;

describe("service-resolver", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "deploy-resolver-"));
    mkdirSync(join(projectRoot, "services"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("listServicesWithDeployConfig returns empty when no services exist", () => {
    expect(listServicesWithDeployConfig(projectRoot)).toEqual([]);
  });

  test("listServicesWithDeployConfig returns service names with deploy.config.ts, sorted", () => {
    mkdirSync(join(projectRoot, "services", "svc-z"));
    mkdirSync(join(projectRoot, "services", "svc-a"));
    mkdirSync(join(projectRoot, "services", "svc-no-config"));
    writeFileSync(join(projectRoot, "services", "svc-z", "deploy.config.ts"), FIXTURE_CONFIG_BODY);
    writeFileSync(join(projectRoot, "services", "svc-a", "deploy.config.ts"), FIXTURE_CONFIG_BODY);

    expect(listServicesWithDeployConfig(projectRoot)).toEqual(["svc-a", "svc-z"]);
  });

  test("resolveDeploymentConfig throws when no services have deploy.config.ts", async () => {
    let threw: unknown = null;
    try {
      await resolveDeploymentConfig(undefined, projectRoot);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(NoDeploymentServicesError);
  });

  test("resolveDeploymentConfig auto-selects when exactly one service is configured", async () => {
    mkdirSync(join(projectRoot, "services", "only"));
    writeFileSync(join(projectRoot, "services", "only", "deploy.config.ts"), FIXTURE_CONFIG_BODY);

    const { service, config } = await resolveDeploymentConfig(undefined, projectRoot);
    expect(service).toBe("only");
    expect(config.platform).toBe("railway");
  });

  test("resolveDeploymentConfig throws ambiguity error when multiple services exist", async () => {
    mkdirSync(join(projectRoot, "services", "alpha"));
    mkdirSync(join(projectRoot, "services", "beta"));
    writeFileSync(join(projectRoot, "services", "alpha", "deploy.config.ts"), FIXTURE_CONFIG_BODY);
    writeFileSync(join(projectRoot, "services", "beta", "deploy.config.ts"), FIXTURE_CONFIG_BODY);

    let threw: unknown = null;
    try {
      await resolveDeploymentConfig(undefined, projectRoot);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(AmbiguousDeploymentServiceError);
    expect((threw as AmbiguousDeploymentServiceError).availableServices).toEqual(["alpha", "beta"]);
  });

  test("resolveDeploymentConfig loads the named service when service is passed", async () => {
    mkdirSync(join(projectRoot, "services", "alpha"));
    mkdirSync(join(projectRoot, "services", "beta"));
    writeFileSync(join(projectRoot, "services", "alpha", "deploy.config.ts"), FIXTURE_CONFIG_BODY);
    writeFileSync(join(projectRoot, "services", "beta", "deploy.config.ts"), FIXTURE_CONFIG_BODY);

    const { service } = await resolveDeploymentConfig("beta", projectRoot);
    expect(service).toBe("beta");
  });

  test("resolveDeploymentConfig throws DeploymentConfigNotFoundError when named service is missing", async () => {
    let threw: unknown = null;
    try {
      await resolveDeploymentConfig("nope", projectRoot);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(DeploymentConfigNotFoundError);
    expect((threw as DeploymentConfigNotFoundError).service).toBe("nope");
  });
});
