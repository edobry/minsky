import { describe, it, expect } from "bun:test";
import { deepMergeConfigs } from "./deep-merge";

describe("deepMergeConfigs", () => {
  it("shallow merge: source keys overwrite target keys", () => {
    const target = { a: 1, b: 2 };
    const source = { b: 20, c: 30 };
    expect(deepMergeConfigs(target, source)).toEqual({ a: 1, b: 20, c: 30 });
  });

  it("deep merge: nested objects are merged recursively", () => {
    const target = { a: { x: 1, y: 2 } };
    const source = { a: { y: 20, z: 30 } };
    expect(deepMergeConfigs(target, source)).toEqual({ a: { x: 1, y: 20, z: 30 } });
  });

  it("arrays in source replace (not merge) target arrays", () => {
    const target = { arr: [1, 2, 3] };
    const source = { arr: [4, 5] };
    expect(deepMergeConfigs(target, source)).toEqual({ arr: [4, 5] });
  });

  it("undefined values in source do not overwrite defined target values", () => {
    const target = { a: 1 };
    const source = { a: undefined, b: 2 } as Record<string, unknown>;
    const result = deepMergeConfigs(target, source);
    expect(result.a).toBe(1);
    expect(result.b).toBe(2);
  });

  it("null in source overwrites target value", () => {
    const target = { a: 1 };
    const source = { a: null };
    expect(deepMergeConfigs(target, source)).toEqual({ a: null });
  });

  it("empty source returns copy of target", () => {
    const target = { a: 1, b: 2 };
    expect(deepMergeConfigs(target, {})).toEqual({ a: 1, b: 2 });
  });

  it("empty target returns copy of source", () => {
    const source = { a: 1, b: 2 };
    expect(deepMergeConfigs({}, source)).toEqual({ a: 1, b: 2 });
  });

  it("both empty returns empty object", () => {
    expect(deepMergeConfigs({}, {})).toEqual({});
  });

  it("does not mutate target", () => {
    const target = { a: 1 };
    const source = { a: 2 };
    deepMergeConfigs(target, source);
    expect(target.a).toBe(1);
  });

  it("does not mutate source", () => {
    const target = { a: { x: 1 } };
    const source = { a: { y: 2 } };
    deepMergeConfigs(target, source);
    expect((source.a as Record<string, unknown>).x).toBeUndefined();
  });

  it("deeply nested merge works correctly", () => {
    const target = { level1: { level2: { level3: { a: 1, b: 2 } } } };
    const source = { level1: { level2: { level3: { b: 20, c: 30 } } } };
    expect(deepMergeConfigs(target, source)).toEqual({
      level1: { level2: { level3: { a: 1, b: 20, c: 30 } } },
    });
  });
});
