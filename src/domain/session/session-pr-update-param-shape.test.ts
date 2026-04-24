/**
 * Regression test for mt#1261: session_pr_create was passing `name: sessionId`
 * to the internal updateSessionImpl call, but updateSessionImpl destructures
 * `sessionId`. The `as SessionUpdateParameters` cast hid the type mismatch,
 * and the caller's sessionId was silently stripped, producing "Session ID is
 * required" at runtime on every PR creation.
 *
 * Defense:
 *   1. The cast was removed in the fix, so TypeScript now catches the wrong shape.
 *   2. This test guards against re-adding either the buggy key or the cast.
 */
import { describe, it, expect } from "bun:test";
/* eslint-disable custom/no-real-fs-in-tests -- intentional source-text assertion; the check only makes sense against the real file on disk */
import { readFileSync } from "fs";
import { join } from "path";

describe("mt#1261 regression: session-pr-operations update-call shape", () => {
  const source = readFileSync(join(__dirname, "session-pr-operations.ts"), "utf-8");

  it("does not pass `name: sessionId` to updateSessionImpl", () => {
    // Any occurrence of this exact pattern inside the session-pr-operations
    // call to updateSessionImpl indicates the bug is back.
    expect(source).not.toMatch(/name:\s*sessionId,\s*\n\s*repo:\s*params\.repo/);
  });

  it("does not cast updateSessionImpl params to SessionUpdateParameters", () => {
    // The cast hid the original bug. Keeping the call uncast preserves type
    // checking, so any future shape mismatch surfaces at compile time.
    expect(source).not.toMatch(/as import\("\.\.\/schemas"\)\.SessionUpdateParameters/);
  });
});
