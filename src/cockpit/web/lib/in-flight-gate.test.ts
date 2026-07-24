/**
 * Tests for the in-flight-fetch gate (mt#3131 D4 — cockpit polling-storm
 * fix). See `in-flight-gate.ts`'s header for the full incident writeup: an
 * unguarded `setInterval` tick firing a new fetch while the previous tick's
 * fetch is still outstanding is the actual firing site for the observed
 * "100+ duplicate uncanceled task-graph requests" symptom — NOT a missing
 * dependency array or missing `clearInterval` (that hypothesis was checked
 * against `App.tsx`'s actual code and refuted: both were already correct).
 */
import { describe, test, expect } from "bun:test";
import { createInFlightGate } from "./in-flight-gate";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createInFlightGate (mt#3131 D4)", () => {
  test("a second run() under the same key while the first is outstanding is a no-op", async () => {
    const gate = createInFlightGate();
    let starts = 0;
    const d = deferred<void>();

    gate.run("task-graph", () => {
      starts += 1;
      return d.promise;
    });
    // Simulates a second poll tick firing before the first fetch settled —
    // exactly the App.tsx setInterval scenario this gate exists to guard.
    gate.run("task-graph", () => {
      starts += 1;
      return d.promise;
    });

    expect(starts).toBe(1);
    expect(gate.isInFlight("task-graph")).toBe(true);

    d.resolve();
    await d.promise;
    // Let the .finally() microtask run.
    await Promise.resolve();
    expect(gate.isInFlight("task-graph")).toBe(false);
  });

  test("a new run() after the previous one settled starts a fresh operation", async () => {
    const gate = createInFlightGate();
    let starts = 0;

    await new Promise<void>((resolveTest) => {
      gate.run("task-graph", async () => {
        starts += 1;
      });
      // Wait a tick for the first run to settle before firing the second.
      setTimeout(() => {
        gate.run("task-graph", async () => {
          starts += 1;
          resolveTest();
        });
      }, 0);
    });

    expect(starts).toBe(2);
  });

  test("different keys never block each other", () => {
    const gate = createInFlightGate();
    let taskGraphStarts = 0;
    let agentsStarts = 0;
    const neverSettles = new Promise<void>(() => {});

    gate.run("task-graph", () => {
      taskGraphStarts += 1;
      return neverSettles;
    });
    gate.run("agents", () => {
      agentsStarts += 1;
      return neverSettles;
    });

    expect(taskGraphStarts).toBe(1);
    expect(agentsStarts).toBe(1);
    expect(gate.isInFlight("task-graph")).toBe(true);
    expect(gate.isInFlight("agents")).toBe(true);
  });

  test("a rejected operation still clears the in-flight flag (never leaves a key permanently stuck)", async () => {
    const gate = createInFlightGate();
    const d = deferred<void>();

    gate.run("task-graph", () => d.promise);
    expect(gate.isInFlight("task-graph")).toBe(true);

    d.resolve(); // resolve, but simulate a downstream .catch by rejecting instead below
    await d.promise;
    await Promise.resolve();
    expect(gate.isInFlight("task-graph")).toBe(false);

    // A genuinely rejecting operation must also clear the flag, not leave
    // the widget permanently un-pollable.
    let caught = false;
    gate.run("task-graph", () => Promise.reject(new Error("network error")));
    // gate.run swallows the rejection internally (mirrors App.tsx's existing
    // .catch(() => {}) posture) — this just asserts it doesn't throw here.
    try {
      await Promise.resolve();
    } catch {
      caught = true;
    }
    expect(caught).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(gate.isInFlight("task-graph")).toBe(false);
  });
});
