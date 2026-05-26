import { describe, expect, test } from "bun:test";

import { railwayAdapterFactory, RailwayDeploymentAdapter } from "./adapter";
import type { DeploymentConfig } from "../config";

describe("railwayAdapterFactory", () => {
  test("builds a RailwayDeploymentAdapter from a railway config", () => {
    const config: DeploymentConfig = {
      platform: "railway",
      railway: { projectId: "p", environmentId: "e", serviceId: "s" },
    };
    const adapter = railwayAdapterFactory(config);
    expect(adapter).toBeInstanceOf(RailwayDeploymentAdapter);
  });

  test("throws when called with a non-railway platform", () => {
    const config = {
      platform: "vercel",
      vercel: {},
    } as unknown as DeploymentConfig;

    expect(() => railwayAdapterFactory(config)).toThrow(/non-railway/);
  });
});
