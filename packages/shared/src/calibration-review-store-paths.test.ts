/**
 * mt#4880 — the calibration-review state stores resolve into the project-keyed
 * state dir, and the key agrees with the one the calibration STREAMS already use.
 */
import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { getMinskyStateDir } from "./paths";
import {
  calibrationReviewStoreDir,
  calibrationReviewStorePath,
  projectStateKey,
  CALIBRATION_REVIEW_STORE_FILENAMES,
  WATERMARK_STORE_FILENAME,
  WATERMARK_LOCK_FILENAME,
  LAST_WARNED_STORE_FILENAME,
  CLAIM_STORE_FILENAME,
} from "./calibration-review-store-paths";
import { projectStateKey as streamProjectStateKey } from "@minsky/domain/guard-events/ingest-runtime";

const REPO = "/Users/someone/Projects/minsky";

describe("projectStateKey agrees with the streams' key (mt#4880)", () => {
  test("byte-identical to the copy the calibration streams resolve through", () => {
    // The whole point of moving these stores is that a watermark INDEXES the
    // calibration logs. If this key diverged from `ingest-runtime.ts`'s, the store
    // would land beside a DIFFERENT project's logs — with no error anywhere, which
    // is the class of silent mis-resolution mt#4748's own docblocks keep warning
    // about. Pinned against the real other implementation, not a fixture.
    for (const root of [REPO, "/tmp/x", "/", "/a/b/c/d/e"]) {
      expect(projectStateKey(root), root).toBe(streamProjectStateKey(root));
    }
  });

  test("is a 16-char hex prefix, and distinct roots do not collide", () => {
    expect(projectStateKey(REPO)).toMatch(/^[0-9a-f]{16}$/);
    expect(projectStateKey(REPO)).not.toBe(projectStateKey(`${REPO}-other`));
  });
});

describe("store paths land in the project-keyed state dir (mt#4880)", () => {
  test("the directory is <stateDir>/projects/<key>", () => {
    expect(calibrationReviewStoreDir(REPO)).toBe(
      join(getMinskyStateDir(), "projects", projectStateKey(REPO))
    );
  });

  test("every store file resolves under that directory", () => {
    for (const filename of CALIBRATION_REVIEW_STORE_FILENAMES) {
      expect(calibrationReviewStorePath(filename, REPO), filename).toBe(
        join(calibrationReviewStoreDir(REPO), filename)
      );
    }
  });

  test("no resolved path is repo-rooted — the ABSENCE of the old shape", () => {
    // Asserting absence as well as presence, per the two-sided regression shape
    // PR #3541 R1 established: both can coexist, and it is the old shape that
    // produces the silent zero.
    for (const filename of CALIBRATION_REVIEW_STORE_FILENAMES) {
      const resolved = calibrationReviewStorePath(filename, REPO);
      expect(resolved.startsWith(REPO), filename).toBe(false);
      expect(resolved, filename).not.toContain(join(REPO, ".minsky"));
    }
  });

  test("the four filenames are pinned, so a rename cannot pass silently", () => {
    // These names are where records have accumulated; a change here orphans a
    // corpus rather than moving it.
    expect([...CALIBRATION_REVIEW_STORE_FILENAMES]).toEqual([
      "calibration-review-watermarks.json",
      "calibration-review-watermarks.lock",
      "calibration-review-cadence-last-warned.json",
      "calibration-review-claims.json",
    ]);
  });

  test("the lock resolves beside the store it guards", () => {
    // A lock left behind in the repo tree while the store moved would serialize
    // nothing that matters — the concurrency bug would be silent, not loud.
    const store = calibrationReviewStorePath(WATERMARK_STORE_FILENAME, REPO);
    const lock = calibrationReviewStorePath(WATERMARK_LOCK_FILENAME, REPO);
    expect(lock.slice(0, lock.lastIndexOf("/"))).toBe(store.slice(0, store.lastIndexOf("/")));
  });

  test("the last-warned and claim stores share that directory too", () => {
    const dir = calibrationReviewStoreDir(REPO);
    expect(calibrationReviewStorePath(LAST_WARNED_STORE_FILENAME, REPO).startsWith(dir)).toBe(true);
    expect(calibrationReviewStorePath(CLAIM_STORE_FILENAME, REPO).startsWith(dir)).toBe(true);
  });
});
