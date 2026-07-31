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
  inferRunningService,
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

function railwayConfigBody(serviceId: string): string {
  return `
export default {
  platform: "railway",
  railway: { projectId: "p", environmentId: "e", serviceId: "${serviceId}" },
};
`;
}

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

  test("ambiguity error lists ALL candidate service names, not a subset (mt#2821)", async () => {
    mkdirSync(join(projectRoot, "services", "alpha"));
    mkdirSync(join(projectRoot, "services", "beta"));
    mkdirSync(join(projectRoot, "services", "gamma"));
    mkdirSync(join(projectRoot, "services", "delta"));
    for (const svc of ["alpha", "beta", "gamma", "delta"]) {
      writeFileSync(join(projectRoot, "services", svc, "deploy.config.ts"), FIXTURE_CONFIG_BODY);
    }

    let threw: unknown = null;
    try {
      await resolveDeploymentConfig(undefined, projectRoot);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(AmbiguousDeploymentServiceError);
    const error = threw as AmbiguousDeploymentServiceError;
    expect(error.availableServices).toEqual(["alpha", "beta", "delta", "gamma"]);
    // The user-facing message (not just the structured field) must also
    // name every candidate — this is what the operator actually reads.
    for (const svc of ["alpha", "beta", "gamma", "delta"]) {
      expect(error.message).toContain(svc);
    }
  });

  describe("multi-service disambiguation fallbacks (mt#2821)", () => {
    beforeEach(() => {
      mkdirSync(join(projectRoot, "services", "alpha"));
      mkdirSync(join(projectRoot, "services", "beta"));
      writeFileSync(
        join(projectRoot, "services", "alpha", "deploy.config.ts"),
        railwayConfigBody("alpha-service-id")
      );
      writeFileSync(
        join(projectRoot, "services", "beta", "deploy.config.ts"),
        railwayConfigBody("beta-service-id")
      );
    });

    test("uses the configured default service when it names a real candidate", async () => {
      const { service } = await resolveDeploymentConfig(undefined, projectRoot, {
        configuredDefaultService: "beta",
      });
      expect(service).toBe("beta");
    });

    test("ignores a configured default that doesn't match any candidate and falls through to the ambiguity error", async () => {
      let threw: unknown = null;
      try {
        await resolveDeploymentConfig(undefined, projectRoot, {
          configuredDefaultService: "not-a-real-service",
        });
      } catch (err) {
        threw = err;
      }
      expect(threw).toBeInstanceOf(AmbiguousDeploymentServiceError);
    });

    describe("inferRunningService (RAILWAY_SERVICE_ID match)", () => {
      const ORIGINAL_ENV = process.env.RAILWAY_SERVICE_ID;

      afterEach(() => {
        if (ORIGINAL_ENV === undefined) {
          delete process.env.RAILWAY_SERVICE_ID;
        } else {
          process.env.RAILWAY_SERVICE_ID = ORIGINAL_ENV;
        }
      });

      test("resolves to undefined when RAILWAY_SERVICE_ID is not set", async () => {
        delete process.env.RAILWAY_SERVICE_ID;
        const result = await inferRunningService(["alpha", "beta"], projectRoot);
        expect(result).toBeUndefined();
      });

      test("matches the candidate whose declared railway.serviceId equals RAILWAY_SERVICE_ID", async () => {
        process.env.RAILWAY_SERVICE_ID = "beta-service-id";
        const result = await inferRunningService(["alpha", "beta"], projectRoot);
        expect(result?.service).toBe("beta");
      });

      test("resolves to undefined when RAILWAY_SERVICE_ID matches no candidate", async () => {
        process.env.RAILWAY_SERVICE_ID = "some-other-service-id";
        const result = await inferRunningService(["alpha", "beta"], projectRoot);
        expect(result).toBeUndefined();
      });

      test("resolveDeploymentConfig falls through to RAILWAY_SERVICE_ID inference when no configured default matches", async () => {
        process.env.RAILWAY_SERVICE_ID = "alpha-service-id";
        const { service } = await resolveDeploymentConfig(undefined, projectRoot, {});
        expect(service).toBe("alpha");
      });

      test("a configured default takes precedence over RAILWAY_SERVICE_ID inference", async () => {
        process.env.RAILWAY_SERVICE_ID = "alpha-service-id";
        const { service } = await resolveDeploymentConfig(undefined, projectRoot, {
          configuredDefaultService: "beta",
        });
        expect(service).toBe("beta");
      });
    });
  });
});
