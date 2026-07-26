/**
 * Tests for `classifySnapshotError` (mt#3131 PR #2245 R1 — centralized
 * snapshot error-code/status contract). The classifier is the ONE client-side
 * site interpreting the snapshot endpoint's error contract; these tests pin
 * both the primary matches and the drift-hardening fallbacks (code matched
 * regardless of status; status matched when the code is missing/unknown).
 */
import { describe, test, expect } from "bun:test";
import { classifySnapshotError, SnapshotError } from "./conversation-snapshot";

describe("classifySnapshotError (mt#3131)", () => {
  test("wrong_id_space code → wrong_id_space", () => {
    const err = new SnapshotError(422, "wrong_id_space", "workspace id, not a conversation id");
    expect(classifySnapshotError(err)).toBe("wrong_id_space");
  });

  test("bare 422 without a code still classifies as wrong_id_space (body-dropping proxy)", () => {
    const err = new SnapshotError(422, undefined, "Snapshot fetch failed (422): <html>");
    expect(classifySnapshotError(err)).toBe("wrong_id_space");
  });

  test("invalid_id code → invalid_id", () => {
    const err = new SnapshotError(404, "invalid_id", '"958f3805" is not a valid conversation id.');
    expect(classifySnapshotError(err)).toBe("invalid_id");
  });

  test("invalid_id code survives a server-side status drift (e.g. 404 → 400)", () => {
    const err = new SnapshotError(400, "invalid_id", "not a valid conversation id");
    expect(classifySnapshotError(err)).toBe("invalid_id");
  });

  test("session_not_found 404 → not_found", () => {
    const err = new SnapshotError(404, "session_not_found", "No transcript found.");
    expect(classifySnapshotError(err)).toBe("not_found");
  });

  test("a 404 with an unrecognized future code falls back to not_found, not other", () => {
    const err = new SnapshotError(404, "some_future_code", "gone");
    expect(classifySnapshotError(err)).toBe("not_found");
  });

  test("a 500 → other", () => {
    const err = new SnapshotError(500, "internal", "An internal error occurred.");
    expect(classifySnapshotError(err)).toBe("other");
  });

  test("a plain (non-Snapshot) Error → other", () => {
    expect(classifySnapshotError(new Error("network down"))).toBe("other");
  });
});
