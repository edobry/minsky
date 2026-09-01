/**
 * mt#4783 SC3 / AT3 — the census read refuses a partial scan instead of reporting a number.
 *
 * The defect this guards is silent by construction: `list({})` capped at 500 over a 1,347-record
 * corpus returns a plausible array, and every figure derived from it is internally consistent.
 * So the assertions below are about the scan's ability to FAIL — a probe that returns the same
 * result when the system is broken is not verification (mem#704).
 *
 * The stubs model ROW COUNTS, which is the whole subject here; record contents are irrelevant,
 * hence the minimal cast in `rows()`.
 */

import { describe, expect, test } from "bun:test";
import type { MemoryRecord } from "@minsky/domain/memory/types";
import {
  listEveryMemory,
  MEMORY_CENSUS_PAGE_SIZE,
  type MemoryCensusSource,
} from "./list-every-memory";

/** `n` distinct placeholder records. Only the count matters to `listEveryMemory`. */
function rows(n: number, tag = "m"): MemoryRecord[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${tag}-${i}` }) as MemoryRecord);
}

/**
 * A service whose corpus is `total` records, paging correctly, reporting `count()` as
 * `reportedCount` (defaults to the true total). Records every offset it was asked for, so a test
 * can assert the walk actually advanced rather than inferring it from the result length.
 */
function fakeService(opts: {
  total: number;
  reportedCount?: number;
  /** Cap every page at this many rows regardless of the requested limit — the mt#4761 defect. */
  hardCap?: number;
}): MemoryCensusSource & { offsets: number[] } {
  const { total, reportedCount = total, hardCap } = opts;
  const all = rows(total);
  const offsets: number[] = [];

  return {
    offsets,
    async list(filter) {
      const offset = filter?.offset ?? 0;
      const limit = filter?.limit ?? MEMORY_CENSUS_PAGE_SIZE;
      offsets.push(offset);
      const page = all.slice(offset, offset + limit);
      return hardCap === undefined ? page : page.slice(0, hardCap);
    },
    async count() {
      return reportedCount;
    },
  };
}

describe("listEveryMemory", () => {
  test("throws rather than returning a partial scan when paging stops short", async () => {
    // Pagination that yields only the first page — the shape a silently-capped read produces.
    const service: MemoryCensusSource = {
      async list(filter) {
        return (filter?.offset ?? 0) === 0 ? rows(MEMORY_CENSUS_PAGE_SIZE) : [];
      },
      async count() {
        return 1347;
      },
    };

    // The assertion is on the REFUSAL, not on a returned number: one full page out of 1347 is
    // exactly what the un-fixed callers printed before exiting 0. Derived from the page size
    // rather than restating it — the constant tracks DEFAULT_LIST_CAP.
    await expect(listEveryMemory(service)).rejects.toThrow(
      new RegExp(`Scan covered ${MEMORY_CENSUS_PAGE_SIZE} of at least 1347 memories`)
    );
  });

  test("throws when the service exposes no count(), rather than trusting list()", async () => {
    // `count` is OPTIONAL on MemoryServiceSurface, and consumers that omit it are documented as
    // treating list()'s result as the full set. A census caller must not inherit that.
    const countless = {
      async list() {
        return rows(3);
      },
    } as MemoryCensusSource;

    await expect(listEveryMemory(countless)).rejects.toThrow(/exposes no count\(\)/);
  });

  test("returns every record across multiple pages, walking offsets in order", async () => {
    const service = fakeService({ total: 1347 });

    const all = await listEveryMemory(service);

    expect(all).toHaveLength(1347);
    expect(service.offsets).toEqual([0, MEMORY_CENSUS_PAGE_SIZE, MEMORY_CENSUS_PAGE_SIZE * 2]);
    // Distinct records, not one page repeated — a walk that ignored `offset` would still return
    // 1347 rows here and pass a length-only assertion.
    expect(new Set(all.map((m) => m.id)).size).toBe(1347);
  });

  test("terminates on an empty final page when the total is an exact multiple of the page size", async () => {
    const service = fakeService({ total: 1000 });

    const all = await listEveryMemory(service);

    expect(all).toHaveLength(1000);
    // The third call returns an empty page and is what ends the loop; without it this walk
    // would not terminate.
    expect(service.offsets).toEqual([0, MEMORY_CENSUS_PAGE_SIZE, MEMORY_CENSUS_PAGE_SIZE * 2]);
  });

  test("tolerates a record inserted mid-scan (scan larger than the floor)", async () => {
    // Floor taken before the insert; the scan sees one more. Comparing with `<` absorbs this.
    const service = fakeService({ total: 1001, reportedCount: 1000 });

    const all = await listEveryMemory(service);

    expect(all).toHaveLength(1001);
  });

  test("refuses when the service silently caps every page below the requested limit", async () => {
    // The mt#4761 defect in its native form: the service honours `offset` but returns fewer rows
    // than asked for, so the walk ends after one short page.
    const service = fakeService({ total: 1347, hardCap: 100 });

    await expect(listEveryMemory(service)).rejects.toThrow(
      /Scan covered 100 of at least 1347 memories/
    );
  });
});
