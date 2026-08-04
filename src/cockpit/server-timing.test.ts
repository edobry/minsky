/**
 * Tests for the `Server-Timing` recorder — mt#3696.
 *
 * The clock is injected in every timing test, so these assert exact durations
 * rather than tolerating a window around a real `performance.now()` reading.
 */

import { describe, test, expect } from "bun:test";
import {
  formatServerTiming,
  sanitizeMetricName,
  ServerTimingRecorder,
  type HeaderSink,
  type JsonResponseSink,
} from "./server-timing";

/** A clock that advances only when told to, so durations are exact. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Minimal header sink that records what was set. */
function recordingSink(headersSent = false): HeaderSink & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    headers,
    headersSent,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  };
}

/** A response-shaped sink that records both headers and sent bodies. */
function recordingJsonSink(): JsonResponseSink & {
  headers: Record<string, string>;
  bodies: unknown[];
} {
  const headers: Record<string, string> = {};
  const bodies: unknown[] = [];
  return {
    headers,
    bodies,
    headersSent: false,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    json(body: unknown) {
      bodies.push(body);
      return body;
    },
  };
}

describe("sanitizeMetricName", () => {
  test("passes a already-legal token through unchanged", () => {
    expect(sanitizeMetricName("task-graph")).toBe("task-graph");
  });

  test("replaces characters that would break the header grammar", () => {
    // A space or comma would split one metric into two at the parser.
    expect(sanitizeMetricName("task graph")).toBe("task_graph");
    expect(sanitizeMetricName("a,b;c")).toBe("a_b_c");
  });

  test("falls back to a legal name rather than emitting an empty one", () => {
    // The fallback is for input that sanitizes to nothing at all. Input made
    // only of unsafe characters does NOT reach it — each becomes an underscore,
    // which is itself a legal token character.
    expect(sanitizeMetricName("")).toBe("unnamed");
    expect(sanitizeMetricName("   ")).toBe("unnamed");
    expect(sanitizeMetricName(",,,")).toBe("___");
  });
});

describe("formatServerTiming", () => {
  test("renders name and duration", () => {
    expect(formatServerTiming([{ name: "db", durationMs: 53 }])).toBe("db;dur=53.00");
  });

  test("renders a quoted description when present", () => {
    expect(
      formatServerTiming([{ name: "cache", durationMs: 23.2, description: "Cache Read" }])
    ).toBe('cache;desc="Cache Read";dur=23.20');
  });

  test("joins multiple metrics with a comma", () => {
    expect(
      formatServerTiming([
        { name: "db", durationMs: 1 },
        { name: "app", durationMs: 2 },
      ])
    ).toBe("db;dur=1.00, app;dur=2.00");
  });

  test("escapes quotes and backslashes in a description", () => {
    const header = formatServerTiming([{ name: "q", durationMs: 0, description: 'a "b" \\ c' }]);
    expect(header).toBe('q;desc="a \\"b\\" \\\\ c";dur=0.00');
  });

  test("omits an empty description rather than emitting empty quotes", () => {
    expect(formatServerTiming([{ name: "db", durationMs: 5, description: "" }])).toBe(
      "db;dur=5.00"
    );
  });

  test("clamps a negative or non-finite duration instead of emitting it", () => {
    // A bad sample must not produce a header value the browser discards.
    expect(formatServerTiming([{ name: "db", durationMs: -4 }])).toBe("db;dur=0.00");
    expect(formatServerTiming([{ name: "db", durationMs: Number.NaN }])).toBe("db;dur=0.00");
    expect(formatServerTiming([{ name: "db", durationMs: Number.POSITIVE_INFINITY }])).toBe(
      "db;dur=0.00"
    );
  });

  test("returns an empty string for no entries", () => {
    expect(formatServerTiming([])).toBe("");
  });

  test("sanitizes names at format time, not only at record time", () => {
    expect(formatServerTiming([{ name: "two words", durationMs: 1 }])).toBe("two_words;dur=1.00");
  });
});

describe("ServerTimingRecorder", () => {
  test("times an async phase against the injected clock", async () => {
    const clock = fakeClock();
    const recorder = new ServerTimingRecorder(clock.now);

    const value = await recorder.time("db", async () => {
      clock.advance(120);
      return "result";
    });

    expect(value).toBe("result");
    expect(recorder.toJSON()).toEqual([{ name: "db", durationMs: 120, description: undefined }]);
  });

  test("records a phase that throws, and rethrows the error", async () => {
    // A query that fails slowly is exactly what a latency measurement needs to
    // see; dropping it would leave the phases silently failing to add up.
    const clock = fakeClock();
    const recorder = new ServerTimingRecorder(clock.now);

    const boom = new Error("query failed");
    await expect(
      recorder.time("db", async () => {
        clock.advance(75);
        throw boom;
      })
    ).rejects.toThrow("query failed");

    expect(recorder.toJSON()).toEqual([{ name: "db", durationMs: 75, description: undefined }]);
  });

  test("preserves completion order across phases", async () => {
    const clock = fakeClock();
    const recorder = new ServerTimingRecorder(clock.now);

    await recorder.time("first", async () => clock.advance(10));
    await recorder.time("second", async () => clock.advance(20));

    expect(recorder.toJSON().map((e) => e.name)).toEqual(["first", "second"]);
  });

  test("appends a total covering the whole request, not the sum of phases", async () => {
    const clock = fakeClock();
    const recorder = new ServerTimingRecorder(clock.now);

    await recorder.time("db", async () => clock.advance(30));
    // Time spent outside any recorded phase must remain visible in `total`.
    clock.advance(70);

    expect(recorder.toHeader()).toBe('db;dur=30.00, total;desc="handler total";dur=100.00');
  });

  test("elapsedMs measures from construction", () => {
    const clock = fakeClock();
    const recorder = new ServerTimingRecorder(clock.now);
    clock.advance(42);
    expect(recorder.elapsedMs()).toBe(42);
  });

  test("applyTo sets the header and reports that it did", () => {
    const clock = fakeClock();
    const recorder = new ServerTimingRecorder(clock.now);
    recorder.record("db", 5);
    const sink = recordingSink();

    expect(recorder.applyTo(sink)).toBe(true);
    expect(sink.headers["Server-Timing"]).toBe('db;dur=5.00, total;desc="handler total";dur=0.00');
  });

  test("applyTo refuses once the response has been flushed", () => {
    const recorder = new ServerTimingRecorder(fakeClock().now);
    recorder.record("db", 5);
    const sink = recordingSink(true);

    expect(recorder.applyTo(sink)).toBe(false);
    expect(sink.headers["Server-Timing"]).toBeUndefined();
  });

  test("sanitizes a name at record time", () => {
    const recorder = new ServerTimingRecorder(fakeClock().now);
    recorder.record("task graph", 1);
    expect(recorder.toJSON()[0]?.name).toBe("task_graph");
  });

  test("attachTo emits the header on a FAILURE response, not only on success", async () => {
    // The regression this closes (PR #2637 R1): the header was applied by hand
    // immediately before the success `res.json(...)`, so 503/404/500 replies
    // carried no attribution — the exact responses a latency investigation
    // reaches for. A slow failure is a finding, not a gap.
    const clock = fakeClock();
    const recorder = new ServerTimingRecorder(clock.now);
    const sink = recordingJsonSink();
    recorder.attachTo(sink);

    await recorder.time("deps", async () => clock.advance(250));
    sink.json({ error: "Task service unavailable" });

    expect(sink.headers["Server-Timing"]).toBe(
      'deps;dur=250.00, total;desc="handler total";dur=250.00'
    );
    expect(sink.bodies).toEqual([{ error: "Task service unavailable" }]);
  });

  test("attachTo captures phases recorded after it was attached", async () => {
    // Attachment happens at the top of a handler, before any phase has run, so
    // the header must be built at send time rather than at attach time.
    const clock = fakeClock();
    const recorder = new ServerTimingRecorder(clock.now);
    const sink = recordingJsonSink();
    recorder.attachTo(sink);

    await recorder.time("task", async () => clock.advance(40));
    await recorder.time("graph", async () => clock.advance(10));
    sink.json({ ok: true });

    expect(sink.headers["Server-Timing"]).toContain("task;dur=40.00");
    expect(sink.headers["Server-Timing"]).toContain("graph;dur=10.00");
  });

  test("attachTo preserves the value json returns", () => {
    const recorder = new ServerTimingRecorder(fakeClock().now);
    const sink = recordingJsonSink();
    sink.json = () => "sentinel";
    recorder.attachTo(sink);
    expect(sink.json({ ok: true })).toBe("sentinel");
  });

  test("attachTo is idempotent — a second attach does not double-wrap", () => {
    const recorder = new ServerTimingRecorder(fakeClock().now);
    const sink = recordingJsonSink();
    let applyCount = 0;
    const originalSetHeader = sink.setHeader.bind(sink);
    sink.setHeader = (name: string, value: string) => {
      applyCount++;
      return originalSetHeader(name, value);
    };

    recorder.attachTo(sink);
    recorder.attachTo(sink);
    recorder.record("db", 1);
    sink.json({ ok: true });

    expect(applyCount).toBe(1);
  });

  test("defaults to a real clock when none is injected", async () => {
    // The one place a wall-clock read is the behavior under test: only that it
    // is monotonic and non-negative, never a specific value.
    const recorder = new ServerTimingRecorder();
    await recorder.time("work", async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    const entry = recorder.toJSON()[0];
    expect(entry?.name).toBe("work");
    expect(entry?.durationMs).toBeGreaterThan(0);
  });
});
