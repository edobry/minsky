/**
 * Tests for the `persistence.migrate` command's dry-run/execute precedence.
 *
 * mt#3191: the `--dry-run`/`-n` flag was destructured into an unused
 * `_dryRun` binding and never read — preview-vs-apply was controlled solely
 * by `--execute`, so `persistence migrate --dry-run --execute` silently
 * APPLIED a schema migration against Postgres despite the operator
 * explicitly asking for a preview. This violates CLAUDE.md's
 * `§Operational Safety: Dry-Run First` invariant.
 *
 * Fix direction chosen (per the task spec's (a)/(b) choice): HONOR the flag.
 * `--dry-run` now forces preview and takes precedence over `--execute` via a
 * single exported, unit-testable seam (`resolveMigratePreviewMode` in
 * `./persistence.ts`) shared by both the schema-only migration path and the
 * backend-migration path inside the command handler — so the precedence is
 * explicit in code, not incidental to evaluation order in two places.
 *
 * These tests exercise `resolveMigratePreviewMode` directly rather than the
 * full `persistence.migrate` command handler: the handler's non-schema-only
 * path (`--to postgres`) pulls in live configuration, a session provider,
 * and a Postgres connection that are impractical to construct hermetically,
 * and `bun:test`'s `mock.module()` persists across test files with no
 * per-file unmock (see `observability.test.ts`'s documented rationale for
 * the same tradeoff), so mocking those dependencies risks poisoning other
 * test files. `resolveMigratePreviewMode` is the ACTUAL decision function
 * both command code paths call (see `persistence.ts` lines ~133, ~139, and
 * ~263) — testing it directly proves the real precedence behavior without
 * that risk.
 */

import { describe, test, expect } from "bun:test";
import { resolveMigratePreviewMode } from "./persistence";

describe("resolveMigratePreviewMode (persistence.migrate dry-run/execute precedence, mt#3191)", () => {
  test("--dry-run --execute previews — does NOT apply (dry-run wins)", () => {
    expect(resolveMigratePreviewMode({ execute: true, dryRun: true })).toBe(true);
  });

  test("no flags: default still previews", () => {
    expect(resolveMigratePreviewMode({})).toBe(true);
    expect(resolveMigratePreviewMode({ execute: undefined, dryRun: undefined })).toBe(true);
  });

  test("--execute alone applies (no dry-run requested)", () => {
    expect(resolveMigratePreviewMode({ execute: true, dryRun: false })).toBe(false);
    expect(resolveMigratePreviewMode({ execute: true })).toBe(false);
  });

  test("--dry-run alone previews (redundant with default, but consistent)", () => {
    expect(resolveMigratePreviewMode({ execute: false, dryRun: true })).toBe(true);
    expect(resolveMigratePreviewMode({ dryRun: true })).toBe(true);
  });

  test("neither flag set previews (matches CLAUDE.md dry-run-by-default)", () => {
    expect(resolveMigratePreviewMode({ execute: false, dryRun: false })).toBe(true);
  });
});
