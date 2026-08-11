/**
 * Tests for mt#3997's resident-memory capture notice.
 *
 * The filesystem is injected (`CaptureIo`) rather than real — required by
 * `custom/no-real-fs-in-tests`, and the right shape regardless: what matters
 * here is WHICH artifacts are new and WHAT the notice says, neither of which is
 * about disk. The real IO implementation is exercised end-to-end against a real
 * `minsky mcp start` in the PR's live-verification section instead.
 */

import { describe, expect, test } from "bun:test";

import {
  MAX_DESCRIBED_CAPTURES,
  MEMORY_CAPTURE_NOTICE_OVERRIDE_ENV,
  collectNewCaptureNotice,
  formatCaptureNotice,
  selectNewCaptures,
  type CaptureIo,
  type CaptureRecord,
} from "./inject-memory-capture";

const MB = 1024 * 1024;
const ARTIFACT = "memory-capture-2026-08-11T20-03-39-983Z-mcp-start-stdio-pid48013.json";
const SECOND_ARTIFACT = "memory-capture-2026-08-12T01-00-00-000Z-cockpit-start-pid999.json";
const SLOW_TOOL = "transcripts_search-text";
const MOCK_DIR = "/mock/state/memory-captures";

const ENV = { MINSKY_STATE_DIR: "/mock/state" } as NodeJS.ProcessEnv;

const RECORD_WITH_TOOL: CaptureRecord = {
  capturedAt: "2026-08-11T20:03:39.983Z",
  pid: 48013,
  processRole: "mcp start (stdio)",
  residentBytes: 1500 * MB,
  inFlightToolCalls: [{ toolName: SLOW_TOOL, elapsedMs: 91_000 }],
};

/**
 * In-memory `CaptureIo`. `records` maps filename -> record, or to `null` for an
 * artifact that exists on disk but cannot be parsed.
 */
function createFakeIo(records: Record<string, CaptureRecord | null>) {
  let seen: string[] = [];
  const io: CaptureIo = {
    listFilenames: (dir) => (dir === MOCK_DIR ? Object.keys(records) : null),
    readRecord: (_dir, filename) => records[filename] ?? null,
    readSeen: () => seen,
    writeSeen: (_env, next) => {
      seen = next;
    },
  };
  return {
    io,
    get seen() {
      return seen;
    },
    add(filename: string, record: CaptureRecord) {
      records[filename] = record;
    },
  };
}

/** An IO whose capture directory does not exist at all. */
const ABSENT_DIR_IO: CaptureIo = {
  listFilenames: () => null,
  readRecord: () => null,
  readSeen: () => [],
  writeSeen: () => {},
};

describe("selectNewCaptures", () => {
  test("returns only unseen capture artifacts", () => {
    const heapSnapshot = ARTIFACT.replace(/\.json$/, ".heapsnapshot");
    expect(selectNewCaptures([ARTIFACT, SECOND_ARTIFACT, heapSnapshot], [ARTIFACT])).toEqual([
      SECOND_ARTIFACT,
    ]);
  });

  test("returns nothing when all are seen", () => {
    expect(selectNewCaptures([ARTIFACT], [ARTIFACT])).toEqual([]);
  });

  test("rejects .json files that are not capture artifacts (PR #2881 R1)", () => {
    // The directory is a shared on-disk location. Anything else that lands a
    // .json beside a capture would otherwise be announced to the principal as
    // a runaway process.
    expect(
      selectNewCaptures(
        [
          ARTIFACT,
          "notes.json",
          "memory-capture-notice-state.json",
          "memory-capture-2026-08-11T20-03-39-983Z-mcp-start-stdio-pid48013.json.4242.tmp",
          "memory-capture-missing-a-pid.json",
        ],
        []
      )
    ).toEqual([ARTIFACT]);
  });
});

describe("formatCaptureNotice", () => {
  test("names the in-flight tool — the payload the chain exists to deliver (AT4)", () => {
    const notice = formatCaptureNotice(
      [{ filename: ARTIFACT, record: RECORD_WITH_TOOL }],
      MOCK_DIR
    );
    expect(notice).toContain(SLOW_TOOL);
    expect(notice).toContain("91s in");
    expect(notice).toContain("mcp start (stdio)");
    expect(notice).toContain("1500MB");
    expect(notice).toContain(MOCK_DIR);
  });

  test("says what an empty in-flight list MEANS, not just that it is empty", () => {
    const notice = formatCaptureNotice(
      [{ filename: ARTIFACT, record: { ...RECORD_WITH_TOOL, inFlightToolCalls: [] } }],
      MOCK_DIR
    );
    expect(notice).toContain("retained state");
  });

  test("counts the remainder rather than dropping it silently", () => {
    const entries = Array.from({ length: MAX_DESCRIBED_CAPTURES + 2 }, (_, i) => ({
      filename: `c${i}.json`,
      record: { ...RECORD_WITH_TOOL, pid: i },
    }));
    expect(formatCaptureNotice(entries, MOCK_DIR)).toContain("+2 more capture(s) not listed");
  });
});

describe("collectNewCaptureNotice", () => {
  test("is silent when the capture directory does not exist (AT3)", () => {
    expect(collectNewCaptureNotice(ENV, ABSENT_DIR_IO)).toBeNull();
  });

  test("is silent when the directory exists but is empty (AT3)", () => {
    const fake = createFakeIo({});
    expect(collectNewCaptureNotice(ENV, fake.io)).toBeNull();
  });

  test("surfaces a new artifact (AT1)", () => {
    const fake = createFakeIo({ [ARTIFACT]: RECORD_WITH_TOOL });
    const notice = collectNewCaptureNotice(ENV, fake.io);
    expect(notice).not.toBeNull();
    expect(notice).toContain(SLOW_TOOL);
    expect(notice).toContain("mt#3885");
  });

  test("surfaces the same artifact exactly once (AT2)", () => {
    const fake = createFakeIo({ [ARTIFACT]: RECORD_WITH_TOOL });
    expect(collectNewCaptureNotice(ENV, fake.io)).not.toBeNull();
    expect(collectNewCaptureNotice(ENV, fake.io)).toBeNull();
    expect(collectNewCaptureNotice(ENV, fake.io)).toBeNull();
  });

  test("records the surfaced artifact in the watermark", () => {
    const fake = createFakeIo({ [ARTIFACT]: RECORD_WITH_TOOL });
    collectNewCaptureNotice(ENV, fake.io);
    expect(fake.seen).toContain(ARTIFACT);
  });

  test("a later artifact still surfaces after the first was seen", () => {
    const fake = createFakeIo({ [ARTIFACT]: RECORD_WITH_TOOL });
    expect(collectNewCaptureNotice(ENV, fake.io)).not.toBeNull();

    fake.add(SECOND_ARTIFACT, {
      ...RECORD_WITH_TOOL,
      pid: 999,
      processRole: "cockpit start",
    });
    const second = collectNewCaptureNotice(ENV, fake.io);
    expect(second).not.toBeNull();
    expect(second).toContain("cockpit start");
  });

  test("a corrupt artifact does not suppress the others and does not re-fire forever", () => {
    const fake = createFakeIo({
      "memory-capture-2026-08-11T00-00-00-000Z-bad-pid1.json": null,
      [ARTIFACT]: RECORD_WITH_TOOL,
    });

    const notice = collectNewCaptureNotice(ENV, fake.io);
    expect(notice).not.toBeNull();
    // The good one still reports its tool...
    expect(notice).toContain(SLOW_TOOL);
    // ...and the bad one is named rather than silently skipped.
    expect(notice).toContain("unreadable artifact");
    // And neither re-fires.
    expect(collectNewCaptureNotice(ENV, fake.io)).toBeNull();
  });

  test("a watermark-write failure does not throw out of the hook (PR #2881 R1)", () => {
    // The dispatcher must survive an unwritable state dir. Crashing it because
    // a diagnostic could not persist its bookkeeping would be mt#3973's AT4
    // failure one layer up — a diagnostic taking down what it observes.
    const io: CaptureIo = {
      listFilenames: () => [ARTIFACT],
      readRecord: () => RECORD_WITH_TOOL,
      readSeen: () => [],
      writeSeen: () => {
        throw new Error("EROFS: read-only file system");
      },
    };

    // The assertion IS that this does not throw, with a genuinely throwing io —
    // the fake does NOT swallow, so this exercises the CALLER's guard rather
    // than the fake's politeness. The notice is still produced: an unpersisted
    // watermark repeats next turn, which is noisy but never wrong.
    let notice: string | null = null;
    expect(() => {
      notice = collectNewCaptureNotice(ENV, io);
    }).not.toThrow();
    expect(notice).not.toBeNull();
    expect(notice).toContain(SLOW_TOOL);
  });

  test("the override suppresses the notice", () => {
    const fake = createFakeIo({ [ARTIFACT]: RECORD_WITH_TOOL });
    expect(
      collectNewCaptureNotice(
        { ...ENV, [MEMORY_CAPTURE_NOTICE_OVERRIDE_ENV]: "1" } as NodeJS.ProcessEnv,
        fake.io
      )
    ).toBeNull();
  });
});
