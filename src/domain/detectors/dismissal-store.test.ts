/**
 * Tests for the dismissal store.
 *
 * Acceptance test AT2: per-repoUrl scoping — a dismissal in repoUrl A
 * does not suppress the same signature in repoUrl B.
 *
 * Tests use InMemoryDismissalStore to avoid Postgres dependency.
 * The same interface is satisfied by DismissalStore (Postgres-backed).
 *
 * Reference: mt#1574 §Acceptance Tests
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { InMemoryDismissalStore } from "./dismissal-store";

const SIG_FOO = "policy-coverage@v1::Write::src/foo.ts";
const SIG_BAR = "policy-coverage@v1::Write::src/bar.ts";
const REPO_A = "https://github.com/org/repo-a";
const REPO_B = "https://github.com/org/repo-b";
const REPO = "https://github.com/org/repo";

describe("InMemoryDismissalStore", () => {
  let store: InMemoryDismissalStore;

  beforeEach(() => {
    store = new InMemoryDismissalStore();
  });

  describe("AT2: per-repoUrl scoping", () => {
    it("signature dismissed in repo A does not suppress in repo B", async () => {
      await store.recordDismissal(SIG_FOO, REPO_A, "dismiss");

      const inA = await store.isDismissed(SIG_FOO, REPO_A);
      const inB = await store.isDismissed(SIG_FOO, REPO_B);

      expect(inA).toBe(true);
      expect(inB).toBe(false);
    });

    it("two different signatures in the same repo are independent", async () => {
      await store.recordDismissal(SIG_FOO, REPO, "dismiss");

      expect(await store.isDismissed(SIG_FOO, REPO)).toBe(true);
      expect(await store.isDismissed(SIG_BAR, REPO)).toBe(false);
    });

    it("same signature dismissed in both repos is dismissed in both", async () => {
      await store.recordDismissal(SIG_FOO, REPO_A, "dismiss");
      await store.recordDismissal(SIG_FOO, REPO_B, "dismiss");

      expect(await store.isDismissed(SIG_FOO, REPO_A)).toBe(true);
      expect(await store.isDismissed(SIG_FOO, REPO_B)).toBe(true);
    });
  });

  describe("basic record/query", () => {
    it("returns false for an unknown signature before any record", async () => {
      const result = await store.isDismissed("unknown-sig", REPO);
      expect(result).toBe(false);
    });

    it("returns true after recording a dismissal", async () => {
      await store.recordDismissal("test-sig", REPO, "dismiss");
      expect(await store.isDismissed("test-sig", REPO)).toBe(true);
    });

    it("stores the dismissal response opaquely", async () => {
      await store.recordDismissal(
        "test-sig",
        REPO,
        JSON.stringify({ action: "snooze", until: "2026-06-01" })
      );
      expect(await store.isDismissed("test-sig", REPO)).toBe(true);
    });
  });

  describe("countDismissals", () => {
    it("returns 0 for unknown signatures", async () => {
      const result = await store.countDismissals("unknown", REPO);
      expect(result).toBe(0);
    });

    it("counts multiple dismissals for the same signature and repo", async () => {
      await store.recordDismissal("repeated-sig", REPO, "dismiss");
      await store.recordDismissal("repeated-sig", REPO, "dismiss");
      await store.recordDismissal("repeated-sig", REPO, "dismiss");

      const result = await store.countDismissals("repeated-sig", REPO);
      expect(result).toBe(3);
    });

    it("countDismissals respects repoUrl scoping", async () => {
      await store.recordDismissal("shared-sig", REPO_A, "dismiss");
      await store.recordDismissal("shared-sig", REPO_A, "dismiss");
      await store.recordDismissal("shared-sig", REPO_B, "dismiss");

      expect(await store.countDismissals("shared-sig", REPO_A)).toBe(2);
      expect(await store.countDismissals("shared-sig", REPO_B)).toBe(1);
    });
  });
});
