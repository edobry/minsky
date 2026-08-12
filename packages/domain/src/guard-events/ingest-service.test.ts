import { describe, test, expect } from "bun:test";
import {
  planJsonlStreamRows,
  planDisconnectLogRows,
  runGuardEventsIngestSweep,
  type GuardEventInsertRow,
  type GuardEventsIngestDeps,
} from "./ingest-service";
import type { GuardEventsHwmState } from "./hwm-store";
import type { GuardEventStreamSource } from "./stream-sources";

const FIRE_LOG_SOURCE: GuardEventStreamSource = {
  stream: "fire-log",
  family: "fire-log",
  location: "state-dir",
  relativePath: "fire-log.jsonl",
  format: "jsonl",
};

/** `resolvePath` in the fakes below always resolves to `/root/<relativePath>`. */
const FIRE_LOG_PATH = "/root/fire-log.jsonl";
/** A single minimal fire-log-shaped JSONL line, reused across the SC2 fixtures below. */
const ONE_GUARD_LINE = '{"guardName":"g"}\n';

const DISCONNECT_SOURCE: GuardEventStreamSource = {
  stream: "mcp-disconnect-log",
  family: "special",
  location: "state-dir",
  relativePath: "mcp-disconnect-log.json",
  format: "json-array",
};

describe("planJsonlStreamRows", () => {
  test("parses new lines into dedupe-keyed rows and advances the offset", () => {
    const content =
      '{"guardName":"g1","timestamp":"2026-08-12T00:00:00.000Z"}\n{"guardName":"g2","timestamp":"2026-08-12T00:00:01.000Z"}\n';
    const { rows, newOffset, truncated } = planJsonlStreamRows(
      FIRE_LOG_SOURCE,
      "/state/fire-log.jsonl",
      { size: Buffer.byteLength(content, "utf-8"), content },
      0,
      1000
    );
    expect(rows).toHaveLength(2);
    expect(truncated).toBe(false);
    expect(newOffset).toBe(Buffer.byteLength(content, "utf-8"));
    const [first, second] = rows;
    expect(first?.dedupeKey).not.toBe(second?.dedupeKey);
  });

  test("skips malformed lines without failing the whole stream", () => {
    const content = '{"a":1}\nnot json\n{"a":2}\n';
    const { rows } = planJsonlStreamRows(
      FIRE_LOG_SOURCE,
      "/x",
      { size: Buffer.byteLength(content, "utf-8"), content },
      0,
      1000
    );
    expect(rows).toHaveLength(2);
  });

  test("bounds work per tick via maxRecords and reports truncated:true, advancing the offset only past what was consumed", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `{"n":${i}}`);
    const content = `${lines.join("\n")}\n`;
    const { rows, truncated, newOffset } = planJsonlStreamRows(
      FIRE_LOG_SOURCE,
      "/x",
      { size: Buffer.byteLength(content, "utf-8"), content },
      0,
      2
    );
    expect(rows).toHaveLength(2);
    expect(truncated).toBe(true);
    const consumedPrefix = `${lines[0]}\n${lines[1]}\n`;
    expect(newOffset).toBe(Buffer.byteLength(consumedPrefix, "utf-8"));
  });

  test("a prior offset beyond the current file size resets to a full re-scan from 0", () => {
    const content = '{"a":1}\n';
    const { rows, newOffset } = planJsonlStreamRows(
      FIRE_LOG_SOURCE,
      "/x",
      { size: Buffer.byteLength(content, "utf-8"), content },
      9999, // stale/invalid prior offset
      1000
    );
    expect(rows).toHaveLength(1);
    expect(newOffset).toBe(Buffer.byteLength(content, "utf-8"));
  });
});

describe("planDisconnectLogRows", () => {
  const el = (cause: string) => ({ timestamp: "t", serverName: "S", kind: "disconnect", cause });

  test("advances the element-count watermark and dedupe-keys canonically", () => {
    const raw = JSON.stringify([el("a"), el("b"), el("c")]);
    const { rows, newCount, truncated } = planDisconnectLogRows(DISCONNECT_SOURCE, raw, 0, 1000);
    expect(rows).toHaveLength(3);
    expect(newCount).toBe(3);
    expect(truncated).toBe(false);
  });

  test("only processes elements beyond the prior count", () => {
    const raw = JSON.stringify([el("a"), el("b"), el("c")]);
    const { rows, newCount } = planDisconnectLogRows(DISCONNECT_SOURCE, raw, 1, 1000);
    expect(rows).toHaveLength(2);
    expect(newCount).toBe(3);
  });

  test("a prior count beyond the array length resets to 0 (safe full re-scan)", () => {
    const raw = JSON.stringify([el("a")]);
    const { rows, newCount } = planDisconnectLogRows(DISCONNECT_SOURCE, raw, 99, 1000);
    expect(rows).toHaveLength(1);
    expect(newCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// End-to-end sweep with fully in-memory fakes.
// ---------------------------------------------------------------------------

interface FakeWorld {
  deps: GuardEventsIngestDeps;
  insertedDedupeKeys: Set<string>;
  files: Map<string, string>;
  writeHwm: (next: GuardEventsHwmState) => void;
}

function buildFakeWorld(
  streams: GuardEventStreamSource[],
  initialFiles: Record<string, string>,
  initialHwm: GuardEventsHwmState = {}
): FakeWorld {
  const insertedDedupeKeys = new Set<string>();
  const files = new Map<string, string>(Object.entries(initialFiles));
  let hwm: GuardEventsHwmState = { ...initialHwm };

  const writeHwm = (next: GuardEventsHwmState): void => {
    hwm = next;
  };

  const deps: GuardEventsIngestDeps = {
    streams,
    resolvePath: (source) => `/root/${source.relativePath}`,
    readTail: (path, fromByte) => {
      const full = files.get(path);
      if (full === undefined) return null;
      const size = Buffer.byteLength(full, "utf-8");
      const start = fromByte > size ? 0 : fromByte;
      // Byte-accurate slice via Buffer, mirroring the real fs.readSync path.
      const buf = Buffer.from(full, "utf-8");
      const content = buf.subarray(start).toString("utf-8");
      return { size, content };
    },
    readWhole: (path) => files.get(path) ?? null,
    readHwm: () => hwm,
    writeHwm,
    insertBatch: async (rows: GuardEventInsertRow[]) => {
      // Simulates ON CONFLICT (dedupe_key) DO NOTHING + `.returning()`: a
      // repeat key is a no-op and is NOT counted in the returned insert count.
      let newlyInserted = 0;
      for (const row of rows) {
        if (!insertedDedupeKeys.has(row.dedupeKey)) newlyInserted++;
        insertedDedupeKeys.add(row.dedupeKey);
      }
      return newlyInserted;
    },
    resolveProjectIds: async () => new Map(),
  };

  return { deps, insertedDedupeKeys, files, writeHwm };
}

describe("runGuardEventsIngestSweep", () => {
  test("file-not-found is reported as skippedNoFile, not an error", async () => {
    const world = buildFakeWorld([FIRE_LOG_SOURCE], {});
    const summary = await runGuardEventsIngestSweep(world.deps);
    expect(summary.perStream[0]).toMatchObject({
      stream: "fire-log",
      skippedNoFile: true,
      read: 0,
    });
    expect(summary.totalErrors).toBe(0);
  });

  test("SC2 — a per-stream failure is captured with the real error and does not block other streams", async () => {
    const streams = [
      FIRE_LOG_SOURCE,
      { ...FIRE_LOG_SOURCE, stream: "guard-health-log", relativePath: "guard-health-log.jsonl" },
    ];
    const world = buildFakeWorld(streams, {
      [FIRE_LOG_PATH]: ONE_GUARD_LINE,
      "/root/guard-health-log.jsonl": '{"guardName":"h"}\n',
    });
    // Make the first stream's readTail throw to simulate a dependency failure.
    const originalReadTail = world.deps.readTail;
    world.deps.readTail = (path, fromByte) => {
      if (path.endsWith("fire-log.jsonl")) throw new Error("simulated disk read failure");
      return originalReadTail(path, fromByte);
    };

    const summary = await runGuardEventsIngestSweep(world.deps);
    const fireLogResult = summary.perStream.find((s) => s.stream === "fire-log");
    const healthResult = summary.perStream.find((s) => s.stream === "guard-health-log");

    expect(fireLogResult?.error).toBe("simulated disk read failure");
    expect(summary.totalErrors).toBe(1);
    // The OTHER stream still processed successfully — one failure doesn't swallow the whole sweep.
    expect(healthResult?.read).toBe(1);
    expect(healthResult?.error).toBeUndefined();
  });

  test("AT3 — running the sweep twice over the same span inserts no new rows the second time", async () => {
    const content =
      '{"guardName":"g1","timestamp":"2026-08-12T00:00:00.000Z"}\n{"guardName":"g2","timestamp":"2026-08-12T00:00:01.000Z"}\n';
    const world = buildFakeWorld([FIRE_LOG_SOURCE], { [FIRE_LOG_PATH]: content });

    const first = await runGuardEventsIngestSweep(world.deps);
    expect(first.totalRead).toBe(2);
    expect(first.totalInserted).toBe(2);
    expect(world.insertedDedupeKeys.size).toBe(2);

    // Second run: HWM has already advanced past all content (the real
    // incremental case — nothing new to read at all). read=0 AND inserted=0
    // — the SC2 observability distinction: this must still be visible as a
    // completed run (see the "always reports a summary" test below), not
    // silently indistinguishable from "never ran".
    const second = await runGuardEventsIngestSweep(world.deps);
    expect(second.totalRead).toBe(0);
    expect(second.totalInserted).toBe(0);
    expect(world.insertedDedupeKeys.size).toBe(2); // unchanged

    // Third run: simulate a full re-scan (HWM reset, e.g. after rotation) —
    // constraint #5 requires this to remain SAFE via dedupe. The same two
    // dedupe keys are recomputed and re-"inserted" (read=2, since the bytes
    // were parsed again), but totalInserted=0 — every row collided with an
    // existing dedupe_key, so genuinely-new rows is zero.
    world.deps.writeHwm({});
    const third = await runGuardEventsIngestSweep(world.deps);
    expect(third.totalRead).toBe(2); // read 2 lines again (full re-scan)
    expect(third.totalInserted).toBe(0); // but genuinely-new rows: zero
    expect(world.insertedDedupeKeys.size).toBe(2);
  });

  test("SC2 — summary reports streamsChecked/totalInserted even when every count is zero (never collapses to an unrunnable-looking result)", async () => {
    const world = buildFakeWorld(
      [FIRE_LOG_SOURCE],
      { [FIRE_LOG_PATH]: ONE_GUARD_LINE },
      { "fire-log": { byteOffset: Buffer.byteLength(ONE_GUARD_LINE, "utf-8") } }
    );
    const summary = await runGuardEventsIngestSweep(world.deps);
    expect(summary.streamsChecked).toBe(1); // the sweep DID run — one stream checked
    expect(summary.totalRead).toBe(0);
    expect(summary.totalInserted).toBe(0);
    expect(summary.totalErrors).toBe(0);
    expect(summary.perStream[0]).toMatchObject({ stream: "fire-log", read: 0, inserted: 0 });
  });

  test("batches project-id resolution once per unique session id, not per row", async () => {
    const content =
      '{"guardName":"g","sessionId":"s1"}\n{"guardName":"g","sessionId":"s1"}\n{"guardName":"g","sessionId":"s2"}\n';
    const world = buildFakeWorld([FIRE_LOG_SOURCE], { [FIRE_LOG_PATH]: content });
    let resolveCallCount = 0;
    let lastSessionIds: string[] = [];
    world.deps.resolveProjectIds = async (sessionIds) => {
      resolveCallCount++;
      lastSessionIds = sessionIds;
      return new Map(sessionIds.map((id) => [id, null]));
    };

    await runGuardEventsIngestSweep(world.deps);
    expect(resolveCallCount).toBe(1); // one batched call for the whole stream, not 3
    expect(new Set(lastSessionIds)).toEqual(new Set(["s1", "s2"]));
  });
});
