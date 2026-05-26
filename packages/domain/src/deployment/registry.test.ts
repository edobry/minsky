import { afterEach, describe, expect, test } from "bun:test";

import type { DeploymentConfig } from "./config";
import {
  _resetRegistryForTests,
  getRegisteredPlatforms,
  registerAdapter,
  resolveAdapter,
  UnknownDeploymentPlatformError,
} from "./registry";
import type { DeploymentPlatformAdapter } from "./types";

function makeStubAdapter(): DeploymentPlatformAdapter {
  return {
    waitForLatestDeployment: async () => {
      throw new Error("stub");
    },
    getLatestDeploymentStatus: async () => {
      throw new Error("stub");
    },
    getDeploymentLogs: async () => [],
  };
}

describe("deployment registry", () => {
  afterEach(() => {
    _resetRegistryForTests();
  });

  test("resolveAdapter throws UnknownDeploymentPlatformError for unregistered platform", () => {
    const config: DeploymentConfig = {
      platform: "railway",
      railway: { projectId: "p", environmentId: "e", serviceId: "s" },
    };

    let threw: unknown = null;
    try {
      resolveAdapter(config);
    } catch (err) {
      threw = err;
    }

    expect(threw).toBeInstanceOf(UnknownDeploymentPlatformError);
    expect((threw as UnknownDeploymentPlatformError).platform).toBe("railway");
    expect((threw as UnknownDeploymentPlatformError).registered).toEqual([]);
  });

  test("registered adapter is returned by resolveAdapter", () => {
    const stub = makeStubAdapter();
    registerAdapter("railway", () => stub);

    const config: DeploymentConfig = {
      platform: "railway",
      railway: { projectId: "p", environmentId: "e", serviceId: "s" },
    };

    expect(resolveAdapter(config)).toBe(stub);
  });

  test("getRegisteredPlatforms reflects registry state", () => {
    expect(getRegisteredPlatforms()).toEqual([]);
    registerAdapter("railway", () => makeStubAdapter());
    expect(getRegisteredPlatforms()).toEqual(["railway"]);
  });

  test("UnknownDeploymentPlatformError lists registered platforms in its message", () => {
    registerAdapter("railway", () => makeStubAdapter());

    const config = {
      platform: "vercel",
      // We're deliberately constructing an invalid config to test the error path;
      // the runtime cast is what we're exercising.
    } as unknown as DeploymentConfig;

    try {
      resolveAdapter(config);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownDeploymentPlatformError);
      expect((err as Error).message).toContain('"vercel"');
      expect((err as Error).message).toContain("railway");
    }
  });
});
