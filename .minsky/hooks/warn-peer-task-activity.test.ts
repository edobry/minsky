import { describe, expect, test } from "bun:test";
import {
  callerSessionIdFromCwd,
  decidePeerActivity,
  STATUS_CHANGE_WINDOW_MS,
  TARGET_TOOLS,
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

    // 13:48:36 is 5m24s before 13:54 — inside the window.
    expect(result.message).toContain("PLANNING → READY");

    // 13:38:45 is 15m15s before 13:54 — just OUTSIDE it. This assertion is the
    // rounding bug's fingerprint on real data: the pre-fix comparison rounded
    // 15m15s to 15m and included this row. PR #3281 R1.
    expect(result.message).not.toContain("TODO → PLANNING");
  });

  test("says plainly that status-change rows are NOT attributed", () => {
    // Attribution is partial by design: the caller's own session IS filtered
    // out, but a status-change row carries no actor at all. Asserted so a later
    // edit cannot quietly claim more attribution than the data supports.
    const result = decidePeerActivity(
      "mt#4439",
      [row("session.started", 1, { sessionId: "x" })],
      NOW
    );
    expect(result.message).toContain("NOT attributed");
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

describe("PR #3281 R1 — reviewer findings", () => {
  test("the window boundary is exact: a row 29s past it does NOT fire", () => {
    // Regression for the rounded-minutes bug. The old code compared
    // Math.round(ageMs / 60000) * 60000, so 15m29s rounded DOWN to 15m and
    // compared as inside the window — a silent ~29s widening.
    const justPast = {
      eventType: STATUS_CHANGED,
      createdAt: new Date(NOW - (15 * 60 + 29) * 1000),
    };
    expect(decidePeerActivity("mt#4439", [justPast], NOW).fired).toBe(false);

    // ...and one second inside it still does.
    const justInside = {
      eventType: STATUS_CHANGED,
      createdAt: new Date(NOW - (15 * 60 - 1) * 1000),
    };
    expect(decidePeerActivity("mt#4439", [justInside], NOW).fired).toBe(true);
  });

  test("the caller's OWN session.started is suppressed", () => {
    // Without this the guard warns every implementing agent about itself on
    // every status transition, and is tuned out within a day.
    const events = [row("session.started", 5, { sessionId: PEER_SESSION_ID })];
    expect(decidePeerActivity("mt#4439", events, NOW, PEER_SESSION_ID).fired).toBe(false);
  });

  test("a DIFFERENT session is still reported when the caller has one of its own", () => {
    const events = [
      row("session.started", 5, { sessionId: PEER_SESSION_ID }),
      row("session.started", 5, { sessionId: "mine-0000-0000-0000-000000000000" }),
    ];
    const result = decidePeerActivity("mt#4439", events, NOW, "mine-0000-0000-0000-000000000000");
    expect(result.fired).toBe(true);
    expect(result.message).toContain(PEER_SESSION_ID);
    expect(result.message).not.toContain("mine-0000");
  });

  test("a caller outside any session suppresses nothing — the mt#4439 case", () => {
    // The originating incident's agent worked in the MAIN workspace, so it has
    // no session id to match. Failing toward warning is the safe direction.
    const events = [row("session.started", 5, { sessionId: PEER_SESSION_ID })];
    expect(decidePeerActivity("mt#4439", events, NOW, null).fired).toBe(true);
  });
});

describe("callerSessionIdFromCwd", () => {
  const SID = "05d8a3dd-f4f6-4b51-9d79-258fd621a5e5";

  test("extracts the id from a session root", () => {
    expect(callerSessionIdFromCwd(`/Users/e/.local/state/minsky/sessions/${SID}`)).toBe(SID);
  });

  test("extracts it from a SUBDIRECTORY — the shell cwd is routinely one", () => {
    // types.ts §Repo-root resolution: input.cwd "is routinely a SUBDIRECTORY of
    // the repo". The id is an ancestor segment, so it survives any cd.
    expect(
      callerSessionIdFromCwd(`/Users/e/.local/state/minsky/sessions/${SID}/src/cockpit/web`)
    ).toBe(SID);
  });

  test("returns null in the main workspace", () => {
    expect(callerSessionIdFromCwd("/Users/edobry/Projects/minsky")).toBeNull();
  });

  test("returns null for an undefined cwd", () => {
    expect(callerSessionIdFromCwd(undefined)).toBeNull();
  });

  test("does not match a path segment that merely contains 'sessions'", () => {
    expect(callerSessionIdFromCwd("/Users/e/my-sessions-backup/notes")).toBeNull();
  });
});

describe("TARGET_TOOLS", () => {
  test("covers BOTH write surfaces the spec names", () => {
    // tasks_spec_patch is the surface that actually mattered in the originating
    // incident — the harm was spec sections written into a peer's task.
    expect(TARGET_TOOLS.has("mcp__minsky__tasks_status_set")).toBe(true);
    expect(TARGET_TOOLS.has("mcp__minsky__tasks_spec_patch")).toBe(true);
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
