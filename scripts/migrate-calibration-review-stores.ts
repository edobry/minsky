#!/usr/bin/env bun
/**
 * Migrate the calibration-review STATE stores out of the repo tree — mt#4880.
 *
 * mt#4880 moved the watermark store, mt#4164's claim store, and the cadence detector's
 * last-warned store from `<repoRoot>/.minsky/` into
 * `getMinskyStateDir()/projects/<key>/`. The CODE change alone leaves the existing
 * contents behind, where nothing reads them: every watermark would read as
 * "never reviewed" and every log would go review-due at once. This moves them.
 *
 * Dry-run by default per `CLAUDE.md §Operational Safety`; `--execute` performs the move.
 *
 *   bun scripts/migrate-calibration-review-stores.ts            # preview
 *   bun scripts/migrate-calibration-review-stores.ts --execute  # move
 *
 * **Read-back before removal**, the pattern mt#4755 used for its four corpora: each file
 * is written to the destination, read back, and compared BYTE-FOR-BYTE against the
 * source; the source is unlinked only if they match. A mismatch aborts that file with a
 * non-zero exit and leaves the source in place — losing a corpus is much worse than
 * leaving a duplicate.
 *
 * **What is deliberately NOT migrated: the lock.**
 * `calibration-review-watermarks.lock` is a mkdir-based mutex held for ~2 file ops, with
 * a 10s staleness bound (`WATERMARK_LOCK_STALE_MS`). A lock present at migration time is
 * either live — in which case moving it would hand a second pass a free lock — or stale,
 * in which case it is garbage. It is reported and left alone; the next pass recreates it
 * at the new path and treats any repo-tree remnant as the dead file it is.
 *
 * **The watermark values are known-stale BY DESIGN — do not "clean them up".** Measured
 * 2026-09-02: 15 of 54 sweep results carry `watermarkStranded: true` (counts recorded
 * against the larger pre-mt#4748 logs). mt#4904 shipped that field plus a
 * `watermark-stranded` review-due leg, so each one self-repairs on its next ack. Moving
 * them byte-identically preserves that; resetting them would discard the record of what
 * was last reviewed and when, for no gain.
 *
 * @see mt#4880 — this task
 * @see mt#4755 — the read-back-then-remove pattern
 * @see mt#4904 — why the stranded values are load-bearing rather than corrupt
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  calibrationReviewStorePath,
  WATERMARK_STORE_FILENAME,
  WATERMARK_LOCK_FILENAME,
  LAST_WARNED_STORE_FILENAME,
  CLAIM_STORE_FILENAME,
} from "@minsky/shared/calibration-review-store-paths";
import { resolveRepoRoot } from "@minsky/domain/guard-events/ingest-runtime";

/** The JSON stores that MOVE. The lock is handled separately — see the module docblock. */
const MIGRATED_FILENAMES = [
  WATERMARK_STORE_FILENAME,
  LAST_WARNED_STORE_FILENAME,
  CLAIM_STORE_FILENAME,
] as const;

interface FileOutcome {
  readonly filename: string;
  readonly status: "moved" | "would-move" | "absent" | "already-present" | "conflict" | "failed";
  readonly detail: string;
}

function migrateOne(filename: string, repoRoot: string, execute: boolean): FileOutcome {
  const source = join(repoRoot, ".minsky", filename);
  const dest = calibrationReviewStorePath(filename, repoRoot);

  if (!existsSync(source)) {
    return { filename, status: "absent", detail: "nothing at the repo-rooted path" };
  }
  const sourceBytes = readFileSync(source);

  if (existsSync(dest)) {
    // Never clobber. Identical content means a previous run already moved it and the
    // unlink did not happen; differing content is a real conflict a human must settle.
    const destBytes = readFileSync(dest);
    if (destBytes.equals(sourceBytes)) {
      if (!execute) {
        return {
          filename,
          status: "already-present",
          detail: "destination identical; would remove the source",
        };
      }
      rmSync(source);
      return { filename, status: "moved", detail: "destination already identical; source removed" };
    }
    return {
      filename,
      status: "conflict",
      detail: `destination exists with DIFFERENT content (${destBytes.length} B vs ${sourceBytes.length} B) — settle by hand`,
    };
  }

  if (!execute) {
    return { filename, status: "would-move", detail: `${sourceBytes.length} B -> ${dest}` };
  }

  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, sourceBytes);

  // Read-back comparison BEFORE the source is touched (mt#4755).
  const readBack = readFileSync(dest);
  if (!readBack.equals(sourceBytes)) {
    return {
      filename,
      status: "failed",
      detail: `read-back mismatch (${readBack.length} B vs ${sourceBytes.length} B) — source LEFT IN PLACE`,
    };
  }
  rmSync(source);
  return {
    filename,
    status: "moved",
    detail: `${sourceBytes.length} B -> ${dest} (read-back verified)`,
  };
}

function reportLock(repoRoot: string): string {
  const source = join(repoRoot, ".minsky", WATERMARK_LOCK_FILENAME);
  if (!existsSync(source)) return "lock: absent (nothing to report)";
  const ageMs = Date.now() - statSync(source).mtimeMs;
  return (
    `lock: present at the repo-rooted path, age ${Math.round(ageMs / 1000)}s — NOT migrated by design. ` +
    "It is a ~2-file-op mutex with a 10s staleness bound; the next pass recreates it at the new path."
  );
}

function main(): void {
  const execute = process.argv.includes("--execute");
  const repoRoot = resolveRepoRoot(process.cwd());

  console.log(`repo root: ${repoRoot}`);
  console.log(
    `destination: ${dirname(calibrationReviewStorePath(WATERMARK_STORE_FILENAME, repoRoot))}`
  );
  console.log(execute ? "mode: EXECUTE" : "mode: dry-run (pass --execute to move)");
  console.log("");

  const outcomes = MIGRATED_FILENAMES.map((f) => migrateOne(f, repoRoot, execute));
  for (const o of outcomes) {
    console.log(`[${o.status}] ${o.filename}: ${o.detail}`);
  }
  console.log(reportLock(repoRoot));

  const bad = outcomes.filter((o) => o.status === "failed" || o.status === "conflict");
  if (bad.length > 0) {
    console.log("");
    console.log(`FAILED — ${bad.length} file(s) need attention; no source was removed for those.`);
    process.exit(1);
  }
  console.log("");
  console.log(
    execute
      ? "OK — every source that existed is now at the destination, read-back verified."
      : "OK — dry run only. Nothing was written."
  );
}

main();
