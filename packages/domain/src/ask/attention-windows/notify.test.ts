/**
 * Tests for the attention-window NOTIFY emitter — mt#1489.
 *
 * Tests the recording notifier and the postgres notifier path.
 * The production Postgres path is covered by the recording stub
 * (no live DB required in unit tests).
 */

import { describe, test, expect } from "bun:test";
import {
  createRecordingWindowNotifier,
  createNoopWindowNotifier,
  createPostgresWindowNotifier,
  type WindowOpenedPayload,
  type WindowClosedPayload,
} from "./notify";

// ---------------------------------------------------------------------------
// createRecordingWindowNotifier
// ---------------------------------------------------------------------------

describe("createRecordingWindowNotifier", () => {
  test("records notifyOpened events", async () => {
    const notifier = createRecordingWindowNotifier();
    const payload: WindowOpenedPayload = {
      windowKey: "ask-hours",
      openedAt: "2024-04-15T16:00:00.000Z",
      durationMin: 30,
      expectedCloseAt: "2024-04-15T16:30:00.000Z",
    };
    await notifier.notifyOpened(payload);
    expect(notifier.openedEvents).toHaveLength(1);
    expect(notifier.openedEvents[0]).toEqual(payload);
  });

  test("records notifyClosed events", async () => {
    const notifier = createRecordingWindowNotifier();
    const payload: WindowClosedPayload = {
      windowKey: "ask-hours",
      closedAt: "2024-04-15T16:30:00.000Z",
      summary: { servedCount: 3, reBatchedCount: 1, escalatedCount: 0, droppedCount: 0 },
    };
    await notifier.notifyClosed(payload);
    expect(notifier.closedEvents).toHaveLength(1);
    expect(notifier.closedEvents[0]).toEqual(payload);
  });

  test("records multiple events in order", async () => {
    const notifier = createRecordingWindowNotifier();
    await notifier.notifyOpened({
      windowKey: "ask-hours",
      openedAt: "2024-04-15T16:00:00.000Z",
      durationMin: 30,
      expectedCloseAt: "2024-04-15T16:30:00.000Z",
    });
    await notifier.notifyOpened({
      windowKey: "weekly-review",
      openedAt: "2024-04-15T10:00:00.000Z",
      durationMin: 60,
      expectedCloseAt: "2024-04-15T11:00:00.000Z",
    });
    expect(notifier.openedEvents).toHaveLength(2);
    const first = notifier.openedEvents[0];
    const second = notifier.openedEvents[1];
    if (!first || !second) throw new Error("expected two events");
    expect(first.windowKey).toBe("ask-hours");
    expect(second.windowKey).toBe("weekly-review");
  });
});

// ---------------------------------------------------------------------------
// createNoopWindowNotifier
// ---------------------------------------------------------------------------

describe("createNoopWindowNotifier", () => {
  test("does not throw on notifyOpened", async () => {
    const notifier = createNoopWindowNotifier();
    await expect(
      notifier.notifyOpened({
        windowKey: "ask-hours",
        openedAt: new Date().toISOString(),
        durationMin: 30,
        expectedCloseAt: new Date().toISOString(),
      })
    ).resolves.toBeUndefined();
  });

  test("does not throw on notifyClosed", async () => {
    const notifier = createNoopWindowNotifier();
    await expect(
      notifier.notifyClosed({ windowKey: "ask-hours", closedAt: new Date().toISOString() })
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createPostgresWindowNotifier — graceful degradation without container
// ---------------------------------------------------------------------------

describe("createPostgresWindowNotifier — no container", () => {
  test("does not throw when container is undefined", async () => {
    const notifier = createPostgresWindowNotifier(undefined);
    await expect(
      notifier.notifyOpened({
        windowKey: "ask-hours",
        openedAt: new Date().toISOString(),
        durationMin: 30,
        expectedCloseAt: new Date().toISOString(),
      })
    ).resolves.toBeUndefined();
  });

  test("does not throw on notifyClosed without container", async () => {
    const notifier = createPostgresWindowNotifier(undefined);
    await expect(
      notifier.notifyClosed({ windowKey: "ask-hours", closedAt: new Date().toISOString() })
    ).resolves.toBeUndefined();
  });
});
