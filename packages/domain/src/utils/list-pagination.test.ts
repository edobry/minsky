import { describe, test, expect } from "bun:test";
import { applyListCap, computeListTruncation, DEFAULT_LIST_CAP } from "./list-pagination";

describe("computeListTruncation", () => {
  test("truncated is false when returned equals total", () => {
    expect(computeListTruncation(10, 10)).toEqual({ returned: 10, total: 10, truncated: false });
  });

  test("truncated is true when returned is less than total", () => {
    expect(computeListTruncation(600, 500)).toEqual({
      returned: 500,
      total: 600,
      truncated: true,
    });
  });
});

describe("applyListCap", () => {
  test("returns everything unsliced when under the default cap", () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const { items: sliced, meta } = applyListCap(items);
    expect(sliced).toEqual(items);
    expect(meta).toEqual({ returned: 10, total: 10, truncated: false });
  });

  test("applies the default cap and reports truncation when over it", () => {
    const items = Array.from({ length: DEFAULT_LIST_CAP + 137 }, (_, i) => i);
    const { items: sliced, meta } = applyListCap(items);
    expect(sliced.length).toBe(DEFAULT_LIST_CAP);
    expect(meta).toEqual({
      returned: DEFAULT_LIST_CAP,
      total: DEFAULT_LIST_CAP + 137,
      truncated: true,
    });
  });

  test("honors an explicit requested limit smaller than the default cap", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const { items: sliced, meta } = applyListCap(items, 5);
    expect(sliced.length).toBe(5);
    expect(meta).toEqual({ returned: 5, total: 50, truncated: true });
  });

  test("an explicit requested limit larger than total is not truncated", () => {
    const items = Array.from({ length: 3 }, (_, i) => i);
    const { items: sliced, meta } = applyListCap(items, 1000);
    expect(sliced.length).toBe(3);
    expect(meta).toEqual({ returned: 3, total: 3, truncated: false });
  });

  test("ignores a non-positive requested limit and falls back to the default cap", () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const { items: sliced, meta } = applyListCap(items, 0);
    expect(sliced.length).toBe(10);
    expect(meta.truncated).toBe(false);
  });
});
