import { afterEach, beforeEach, describe, expect, test } from "bun:test";

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
  // Reset in BOTH beforeEach and afterEach (mt#2647 hardening). `registry.ts`
  // holds a module-level singleton Map; `@minsky/domain/deployment`'s
  // `import "./railway"` side effect registers the "railway" adapter into
  // that SAME singleton at module-load time. When another test file (or an
  // adjacent source module imported for unrelated reasons, e.g. this repo's
  // deployment-config resolvers) triggers that import before this describe
  // block's first test runs, an afterEach-only reset leaves the very first
  // test's initial state dependent on cross-file module-load order — flaky
  // under some bun test invocations that batch many directories together.
  // A beforeEach reset makes every test in this file order-independent.
  beforeEach(() => {
    _resetRegistryForTests();
  });
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
