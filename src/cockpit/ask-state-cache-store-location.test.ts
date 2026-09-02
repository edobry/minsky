/* eslint-disable custom/no-real-fs-in-tests -- mt#4880 SC6 asks for a READ-BACK: a
   watermark written where the writers write it must be found by the cockpit reader.
   `readWatermarkAskIds` reaches for `fs` itself, so a fixture would assert what I put
   in it rather than that the two sides agree about a LOCATION — which is the whole
   claim. Sibling precedent: `scripts/lib/calibration-log-declarations.test.ts`, which
   reads the gate's real source for the same reason. Writes go to a temp dir under the
   XDG root `tests/setup.ts` isolates, never the operator's live state dir. */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  calibrationReviewStorePath,
  calibrationReviewStoreDir,
  WATERMARK_STORE_FILENAME,
} from "@minsky/shared/calibration-review-store-paths";
import { readWatermarkAskIds } from "./ask-state-cache";

const REPO_ROOT = "/tmp/mt4880-fixture-repo";
const ASK_ID = "483dbcb0-788a-4159-9d8a-ba718ba1f2b0";

function writeWatermarkWhereTheWritersWrite(store: unknown): string {
  const path = calibrationReviewStorePath(WATERMARK_STORE_FILENAME, REPO_ROOT);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  return path;
}

afterEach(() => {
  rmSync(calibrationReviewStoreDir(REPO_ROOT), { recursive: true, force: true });
  rmSync(join(REPO_ROOT, ".minsky"), { recursive: true, force: true });
});

describe("mt#4880 — the cockpit reader finds what the writers write", () => {
  test("a watermark at the shared resolver's path is read back", () => {
    // The criterion's substance: writer and reader now resolve through ONE function,
    // so this asserts they agree about a LOCATION, not merely that JSON parses.
    writeWatermarkWhereTheWritersWrite({
      ".minsky/wall-of-text-calibration.jsonl": {
        lastReviewedCount: 7,
        lastReviewedAt: "2026-09-02T00:00:00.000Z",
        openAskId: ASK_ID,
      },
    });
    expect(readWatermarkAskIds(REPO_ROOT)).toEqual([ASK_ID]);
  });

  test("a watermark at the OLD repo-rooted path is NOT read — the absence half", () => {
    // Two-sided regression, per PR #3541 R1: both shapes can coexist on disk, and it
    // is the OLD one that produces the silent wrong answer. Before mt#4880 this file
    // was the only thing read; after it, it must be invisible.
    const stalePath = join(REPO_ROOT, ".minsky", WATERMARK_STORE_FILENAME);
    mkdirSync(dirname(stalePath), { recursive: true });
    writeFileSync(
      stalePath,
      JSON.stringify({ "x.jsonl": { lastReviewedCount: 1, openAskId: ASK_ID } }),
      "utf-8"
    );
    expect(existsSync(stalePath)).toBe(true);
    expect(readWatermarkAskIds(REPO_ROOT)).toEqual([]);
  });

  test("a missing store is an empty read, not a throw", () => {
    // The steady state: the file carries `openAskId` only between a review and its
    // disposition, so absence is ordinary and must not degrade into an error path.
    expect(readWatermarkAskIds(REPO_ROOT)).toEqual([]);
  });
});
