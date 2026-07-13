/**
 * Tests for the context-inspector widget (mt#2023).
 *
 * Exercises the session-picker payload shape via `createContextInspectorWidget`
 * with a mocked Drizzle-style query chain. Coverage of the snapshot endpoint
 * lives alongside the cockpit server's other endpoint tests (cockpit.test.ts).
 */

import { describe, expect, test } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createContextInspectorWidget, type ContextInspectorPayload } from "./context-inspector";

const WIDGET_ID = "context-inspector";

function firstSession(payload: ContextInspectorPayload) {
  const s = payload.sessions[0];
  if (!s) throw new Error("expected at least one session in payload");
  return s;
}

interface SelectRow {
  agentSessionId: string;
  harness: string;
  startedAt: Date | null;
  endedAt: Date | null;
  cwd: string | null;
}

/** Build a minimal Drizzle-shaped mock that resolves the widget's query chain. */
function mockDbReturning(rows: SelectRow[]): PostgresJsDatabase {
  // The widget calls db.select(...).from(...).orderBy(...).limit(...) — each
  // step needs to return an object that responds to the next call and
  // ultimately resolves to the rows array (PromiseLike).
  const chain = {
    from: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
    then: (
      onFulfilled: (rows: SelectRow[]) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) => Promise.resolve(rows).then(onFulfilled, onRejected),
  };
  return {
    select: () => chain,
  } as unknown as PostgresJsDatabase;
}

describe("context-inspector widget (mt#2023)", () => {
  test("returns state:'ok' with sessions payload when DB returns rows", async () => {
    const sampleStartedAt = new Date("2026-05-20T14:30:00.000Z");
    const sampleEndedAt = new Date("2026-05-20T15:00:00.000Z");
    const rows: SelectRow[] = [
      {
        agentSessionId: "8e586448-17b7-43c3-becc-4d75460c9454",
        harness: "claude_code",
        startedAt: sampleStartedAt,
        endedAt: sampleEndedAt,
        cwd: "/Users/edobry/Projects/minsky",
      },
    ];

    const widget = createContextInspectorWidget(async () => mockDbReturning(rows));
    const result = await widget.fetch({ id: WIDGET_ID });

    expect(result.state).toBe("ok");
    if (result.state !== "ok") return; // for type narrowing

    const payload = result.payload as ContextInspectorPayload;
    expect(payload.sessions).toHaveLength(1);
    const s = firstSession(payload);
    expect(s.agentSessionId).toBe("8e586448-17b7-43c3-becc-4d75460c9454");
    expect(s.harness).toBe("claude_code");
    expect(s.startedAt).toBe(sampleStartedAt.toISOString());
    expect(s.endedAt).toBe(sampleEndedAt.toISOString());
    expect(s.cwd).toBe("/Users/edobry/Projects/minsky");
    // Label format: "<YYYY-MM-DD HH:MM> · <cwd-tail-2> · <session-prefix-8>"
    expect(s.label).toContain("2026-05-20 14:30");
    expect(s.label).toContain("Projects/minsky");
    expect(s.label).toContain("8e586448");
  });

  test("returns state:'ok' with empty sessions list when DB has no rows", async () => {
    const widget = createContextInspectorWidget(async () => mockDbReturning([]));
    const result = await widget.fetch({ id: WIDGET_ID });

    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    const payload = result.payload as ContextInspectorPayload;
    expect(payload.sessions).toEqual([]);
  });

  test("handles null cwd and null timestamps defensively", async () => {
    const rows: SelectRow[] = [
      {
        agentSessionId: "abc12345-aaaa-bbbb-cccc-ddddeeeeffff",
        harness: "claude_code",
        startedAt: null,
        endedAt: null,
        cwd: null,
      },
    ];
    const widget = createContextInspectorWidget(async () => mockDbReturning(rows));
    const result = await widget.fetch({ id: WIDGET_ID });

    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    const payload = result.payload as ContextInspectorPayload;
    expect(payload.sessions).toHaveLength(1);
    const s = firstSession(payload);
    expect(s.startedAt).toBeNull();
    expect(s.endedAt).toBeNull();
    expect(s.cwd).toBeNull();
    expect(s.label).toContain("no-ts");
    expect(s.label).toContain("unknown");
    expect(s.label).toContain("abc12345");
  });

  test("returns state:'degraded' when DB factory throws", async () => {
    const widget = createContextInspectorWidget(async () => {
      throw new Error("simulated DB connection failure");
    });
    const result = await widget.fetch({ id: WIDGET_ID });

    expect(result.state).toBe("degraded");
    if (result.state !== "degraded") return;
    expect(result.reason).toContain("simulated DB connection failure");
  });

  test("widget metadata: id, title, polling updateMode", () => {
    const widget = createContextInspectorWidget(async () => mockDbReturning([]));
    expect(widget.id).toBe(WIDGET_ID);
    expect(widget.title).toBe("Context");
    expect(widget.updateMode).toEqual({ type: "polling", intervalMs: 15000 });
  });
});
