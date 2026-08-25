import { describe, it, expect } from "bun:test";
import { assertStatusWritePersisted } from "./status-commands";

/**
 * mt#4457 (PR #3342 R1, BLOCKING) — the adapter must not build a success
 * envelope from a write that did not persist.
 *
 * Deriving `changed` from `recordsAffected` was not sufficient on its own: the
 * command would still have returned a success result carrying `changed: false`,
 * which is a success payload for a failed write — the exact class this task
 * removes. This guard is the adapter-side second line of defence, and it stays
 * meaningful even though the domain layer throws first, because the whole point
 * is to hold if that throw regresses or a new backend reports zero silently.
 */
describe("assertStatusWritePersisted", () => {
  const base = { taskId: "mt#1", previousStatus: "PLANNING", newStatus: "READY" };

  it("throws when the write matched zero records", () => {
    expect(() => assertStatusWritePersisted({ ...base, recordsAffected: 0 })).toThrow(
      /did not persist/
    );
  });

  it("names the task, the intended transition, and that the status is unchanged", () => {
    expect(() => assertStatusWritePersisted({ ...base, recordsAffected: 0 })).toThrow(/mt#1/);
    expect(() => assertStatusWritePersisted({ ...base, recordsAffected: 0 })).toThrow(
      /PLANNING -> READY/
    );
    expect(() => assertStatusWritePersisted({ ...base, recordsAffected: 0 })).toThrow(
      /status is unchanged/
    );
  });

  it("throws on more records than the one task addressed, as a corruption signal", () => {
    expect(() => assertStatusWritePersisted({ ...base, recordsAffected: 2 })).toThrow(
      /data corruption or a malformed write predicate/
    );
    // The count is reported, not just the fact of the anomaly — a caller
    // diagnosing this needs to know how far it spread.
    expect(() => assertStatusWritePersisted({ ...base, recordsAffected: 7 })).toThrow(/7 records/);
  });

  it("CONTROL: exactly one record passes", () => {
    expect(() => assertStatusWritePersisted({ ...base, recordsAffected: 1 })).not.toThrow();
  });
});
