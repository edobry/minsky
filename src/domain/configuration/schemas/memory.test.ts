import { describe, it, expect } from "bun:test";
import { memoryConfigSchema, memoryLoadingModeSchema } from "./memory";

describe("memoryLoadingModeSchema", () => {
  it("accepts 'on_demand'", () => {
    expect(memoryLoadingModeSchema.parse("on_demand")).toBe("on_demand");
  });

  it("accepts 'legacy'", () => {
    expect(memoryLoadingModeSchema.parse("legacy")).toBe("legacy");
  });

  it("rejects unknown values", () => {
    expect(() => memoryLoadingModeSchema.parse("eager")).toThrow();
    expect(() => memoryLoadingModeSchema.parse("always")).toThrow();
    expect(() => memoryLoadingModeSchema.parse("")).toThrow();
  });
});

describe("memoryConfigSchema", () => {
  it("defaults loadingMode to 'on_demand'", () => {
    const result = memoryConfigSchema.parse({});
    expect(result.loadingMode).toBe("on_demand");
  });

  it("defaults to on_demand when input is undefined", () => {
    const result = memoryConfigSchema.parse(undefined);
    expect(result.loadingMode).toBe("on_demand");
  });

  it("accepts explicit on_demand", () => {
    const result = memoryConfigSchema.parse({ loadingMode: "on_demand" });
    expect(result.loadingMode).toBe("on_demand");
  });

  it("accepts explicit legacy", () => {
    const result = memoryConfigSchema.parse({ loadingMode: "legacy" });
    expect(result.loadingMode).toBe("legacy");
  });

  it("rejects unknown loadingMode values", () => {
    expect(() => memoryConfigSchema.parse({ loadingMode: "unknown" })).toThrow();
  });
});
