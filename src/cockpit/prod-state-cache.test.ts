/* eslint-disable custom/no-real-fs-in-tests -- testing real fs I/O (cache write + read-back) IS the contract here */
import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildProdStateSnapshot,
  writeProdStateCache,
  refreshProdStateCache,
  type UnsafeSql,
  type ProdStateCacheRecord,
} from "./prod-state-cache";

const okSql: UnsafeSql = { unsafe: async () => [{ total: 48, latest_at: "1718500000000" }] };
const emptySql: UnsafeSql = { unsafe: async () => [] };
const throwSql: UnsafeSql = {
  unsafe: async () => {
    throw new Error("relation drizzle.__drizzle_migrations does not exist");
  },
};

const tmpPath = path.join(os.tmpdir(), `minsky-prod-state-${process.pid}.json`);

afterEach(() => {
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    /* ignore */
  }
});

describe("buildProdStateSnapshot", () => {
  test("reads ledger count + latest-applied timestamp", async () => {
    const snap = await buildProdStateSnapshot(okSql);
    expect(snap).toEqual({ ledgerRows: 48, latestAppliedAtMs: 1718500000000 });
  });

  test("empty ledger result -> null (caller fails open)", async () => {
    expect(await buildProdStateSnapshot(emptySql)).toBeNull();
  });

  test("unreadable ledger (throws) -> null", async () => {
    expect(await buildProdStateSnapshot(throwSql)).toBeNull();
  });

  test("null latest_at -> null latestAppliedAtMs", async () => {
    const sql: UnsafeSql = { unsafe: async () => [{ total: 0, latest_at: null }] };
    const snap = await buildProdStateSnapshot(sql);
    expect(snap).toEqual({ ledgerRows: 0, latestAppliedAtMs: null });
  });
});

describe("writeProdStateCache", () => {
  test("writes a parseable cache record with the injected checkedAt", () => {
    const ok = writeProdStateCache(
      { ledgerRows: 48, latestAppliedAtMs: 1718500000000 },
      "2026-06-16T20:00:00.000Z",
      tmpPath
    );
    expect(ok).toBe(true);
    const parsed = JSON.parse(String(fs.readFileSync(tmpPath, "utf-8"))) as ProdStateCacheRecord;
    expect(parsed).toEqual({
      ledgerRows: 48,
      latestAppliedAtMs: 1718500000000,
      checkedAt: "2026-06-16T20:00:00.000Z",
    });
  });
});

describe("refreshProdStateCache", () => {
  test("null sql -> false, no cache written (last-good preserved)", async () => {
    const ok = await refreshProdStateCache(null, "2026-06-16T20:00:00.000Z", tmpPath);
    expect(ok).toBe(false);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  test("unreadable ledger -> false, no cache written", async () => {
    const ok = await refreshProdStateCache(throwSql, "2026-06-16T20:00:00.000Z", tmpPath);
    expect(ok).toBe(false);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  test("good sql -> true, cache written from the live ledger", async () => {
    const ok = await refreshProdStateCache(okSql, "2026-06-16T20:00:00.000Z", tmpPath);
    expect(ok).toBe(true);
    const parsed = JSON.parse(String(fs.readFileSync(tmpPath, "utf-8"))) as ProdStateCacheRecord;
    expect(parsed.ledgerRows).toBe(48);
    expect(parsed.checkedAt).toBe("2026-06-16T20:00:00.000Z");
  });
});
