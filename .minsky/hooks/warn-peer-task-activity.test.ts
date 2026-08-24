import { describe, expect, test } from "bun:test";
import {
  decidePeerActivity,
  STATUS_CHANGE_WINDOW_MS,
  type TaskEventRow,
} from "./warn-peer-task-activity";
import { PRESENCE_CLAIM_TTL_MS } from "../../packages/domain/src/presence/types";

const NOW = Date.parse("2026-08-24T14:00:00.000Z");

/** Hoisted so the repeated literals do not trip `custom/no-magic-string-duplication`. */
const STATUS_CHANGED = "task.status_changed";
const PEER_SESSION_ID = "6ef3fabf-0256-4805-93a2-b92225fbefe3";

/** Build a row `minutesAgo` before NOW. */
function row(
  eventType: string,
  minutesAgo: number,
  payload: Record<string, unknown> = {}
): TaskEventRow {
  return { eventType, createdAt: new Date(NOW - minutesAgo * 60000), payload };
}

describe("decidePeerActivity", () => {
  test("an empty ledger does not fire — a freshly-filed task is the common case", () => {
    // tasks_create emits no event, so a new task's ledger is genuinely []. The
    // guard must be quiet here or it fires on every task's first transition.
    const result = decidePeerActivity("mt#4494", [], NOW);
    expect(result.fired).toBe(false);
    expect(result.outcome).toBe("decided");
  });

  test("session.started fires with NO window — a session is a durable claim", () => {
    // Deliberately far outside STATUS_CHANGE_WINDOW_MS: a workspace that was
    // created 6 hours ago still exists on disk, so its peer is still a peer.
    const result = decidePeerActivity(
      "mt#4439",
      [row("session.started", 360, { sessionId: PEER_SESSION_ID })],
      NOW
    );
    expect(result.fired).toBe(true);
    expect(result.message).toContain(PEER_SESSION_ID);
    expect(result.message).toContain("360m ago");
  });

  test("a status change inside the window fires", () => {
    const result = decidePeerActivity(
      "mt#4439",
      [row(STATUS_CHANGED, 5, { previousStatus: "PLANNING", newStatus: "READY" })],
      NOW
    );
    expect(result.fired).toBe(true);
    expect(result.message).toContain("PLANNING → READY");
  });

  test("a status change OUTSIDE the window does not fire", () => {
    // Every task accumulates these from its own lifecycle. Unwindowed, the guard
    // would fire on literally every call and be tuned out.
    const outside = STATUS_CHANGE_WINDOW_MS / 60000 + 1;
    const result = decidePeerActivity(
      "mt#4439",
      [row(STATUS_CHANGED, outside, { previousStatus: "TODO", newStatus: "PLANNING" })],
      NOW
    );
    expect(result.fired).toBe(false);
  });

  test("an old session.started still fires even when every status change has aged out", () => {
    // The asymmetry between the two triggers is the point, so it gets its own case.
    const result = decidePeerActivity(
      "mt#4439",
      [
        row("session.started", 400, { sessionId: "6ef3fabf" }),
        row(STATUS_CHANGED, 400, { previousStatus: "READY", newStatus: "IN-PROGRESS" }),
      ],
      NOW
    );
    expect(result.fired).toBe(true);
    expect(result.message).toContain("session 6ef3fabf");
    // The aged-out status row is correctly omitted; only the session line remains.
    expect(result.message).not.toContain("READY → IN-PROGRESS");
  });

  test("replays the mt#4439 originating incident and reports the peer", () => {
    // The real ledger at 13:54Z on 2026-08-24, the moment the collision was
    // found. Under the pre-mt#4494 sequence this produced "no peer".
    const incidentNow = Date.parse("2026-08-24T13:54:00.000Z");
    const at = (iso: string) => new Date(Date.parse(iso));
    const ledger: TaskEventRow[] = [
      {
        eventType: "session.started",
        createdAt: at("2026-08-24T13:52:04.440Z"),
        payload: { taskId: "mt#4439", sessionId: PEER_SESSION_ID },
      },
      {
        eventType: STATUS_CHANGED,
        createdAt: at("2026-08-24T13:48:36.579Z"),
        payload: { taskId: "mt#4439", previousStatus: "PLANNING", newStatus: "READY" },
      },
      {
        eventType: STATUS_CHANGED,
        createdAt: at("2026-08-24T13:38:45.905Z"),
        payload: { taskId: "mt#4439", previousStatus: "TODO", newStatus: "PLANNING" },
      },
    ];

    const result = decidePeerActivity("mt#4439", ledger, incidentNow);

    expect(result.fired).toBe(true);
    expect(result.message).toContain(PEER_SESSION_ID);
    expect(result.message).toContain("TODO → PLANNING");
    expect(result.message).toContain("PLANNING → READY");
  });

  test("does not attribute — it reports the rows and says so", () => {
    // Naming an actor is the axis mt#4440 is repairing; this guard's value is
    // that it does not depend on it. Asserted so a later edit cannot quietly
    // add attribution back.
    const result = decidePeerActivity(
      "mt#4439",
      [row("session.started", 1, { sessionId: "x" })],
      NOW
    );
    expect(result.message).toContain("does not attribute");
  });

  test("an unparseable timestamp is treated as infinitely old, not as now", () => {
    // Fail toward silence on a malformed row rather than firing on garbage.
    const result = decidePeerActivity(
      "mt#4439",
      [{ eventType: STATUS_CHANGED, createdAt: "not-a-date", payload: {} }],
      NOW
    );
    expect(result.fired).toBe(false);
  });
});

describe("STATUS_CHANGE_WINDOW_MS", () => {
  test("agrees with PRESENCE_CLAIM_TTL_MS, whose grounding it reuses", () => {
    // The value is duplicated rather than imported so the hook's domain imports
    // stay dynamic (domain-bootstrap.ts layer 1). This test is what keeps the
    // duplicate honest.
    expect(STATUS_CHANGE_WINDOW_MS).toBe(PRESENCE_CLAIM_TTL_MS);
  });
});
