/**
 * Tests for the harness-pid → conversation-id mapping (mt#3900).
 *
 * The defect being prevented is silent by construction: if the writer and the
 * reader disagree about which pid identifies the harness, the reader looks up a
 * pid nobody wrote, finds nothing, and falls back to the stale env value — no
 * error, no log, just the original bug. So the pid-resolution rule is pinned
 * here rather than left to two callers agreeing by convention.
 */
import { describe, expect, test } from "bun:test";
import {
  type MappingIo,
  readConversationMapping,
  resolveHarnessPid,
  writeConversationMapping,
} from "./conversation-pid-map";

const CONV_A = "8f3a2d1b-0000-0000-0000-000000000001";
const CONV_B = "8f3a2d1b-0000-0000-0000-000000000002";

/** Pids used only as map keys; chosen high to avoid colliding with real ones. */
const TEST_PID = 991001;
const TEST_PID_2 = 991002;

/**
 * In-memory {@link MappingIo}. Keeps the real path derivation and JSON codec in
 * the code under test while keeping the tests off disk.
 */
function memoryIo(): MappingIo & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    ensureDir: () => {},
    read: (path) => files.get(path) ?? null,
    write: (path, contents) => {
      files.set(path, contents);
    },
  };
}

describe("resolveHarnessPid — the rule writer and reader must share (mt#3900)", () => {
  /** Build a fake process tree: pid → {ppid, comm}. */
  function tree(entries: Record<number, { ppid: number; comm: string }>) {
    return (pid: number) => entries[pid] ?? null;
  }

  test("returns the start pid when the harness IS the direct parent", () => {
    // The measured shape on macOS 2026-08-10: a harness-spawned child reported
    // the `claude` process as its parent, with nothing in between.
    const readInfo = tree({ 100: { ppid: 1, comm: "claude" } });
    expect(resolveHarnessPid(100, readInfo)).toBe(100);
  });

  test("walks through an intervening shell to the harness", () => {
    // A hook declared as a shell command is spawned via `/bin/sh -c`, so the
    // hook's own parent is the shell and `claude` is its grandparent. The
    // writer must land on the SAME pid the proxy resolves.
    const readInfo = tree({
      100: { ppid: 200, comm: "sh" },
      200: { ppid: 300, comm: "claude" },
    });
    expect(resolveHarnessPid(100, readInfo)).toBe(200);
  });

  test("writer and reader converge on the same pid from different depths", () => {
    // This is the property that matters. The hook may start one frame deeper
    // than the proxy; both must still name the same harness.
    const readInfo = tree({
      10: { ppid: 11, comm: "bun" }, // proxy
      11: { ppid: 99, comm: "claude" },
      20: { ppid: 21, comm: "sh" }, // hook, one frame deeper
      21: { ppid: 11, comm: "bun" },
    });
    expect(resolveHarnessPid(10, readInfo)).toBe(resolveHarnessPid(20, readInfo));
  });

  test("reaches a harness several frames up, not just one or two", () => {
    // Found live during mt#3900's own verification: a hop budget of 4 handled
    // the hook spawned directly by the harness but NOT the same hook spawned
    // by a wrapper two frames deeper — and the shortfall is SILENT, returning
    // null and sending the caller back to the stale env value.
    const readInfo = tree({
      1: { ppid: 2, comm: "bun" }, // the hook
      2: { ppid: 3, comm: "bun" }, // a wrapper script
      3: { ppid: 4, comm: "sh" }, // `sh -c`
      4: { ppid: 5, comm: "zsh" },
      5: { ppid: 6, comm: "bun" },
      6: { ppid: 99, comm: "claude" },
    });
    expect(resolveHarnessPid(1, readInfo)).toBe(6);
  });

  test("returns null when no harness ancestor exists within the hop budget", () => {
    // A manually launched proxy, a test runner, a non-Claude-Code parent. The
    // caller must fall back rather than guess.
    const readInfo = tree({
      100: { ppid: 101, comm: "bash" },
      101: { ppid: 102, comm: "tmux" },
      102: { ppid: 103, comm: "login" },
      103: { ppid: 104, comm: "init" },
      104: { ppid: 1, comm: "launchd" },
    });
    expect(resolveHarnessPid(100, readInfo)).toBeNull();
  });

  test("stops at pid 1 rather than walking forever", () => {
    const readInfo = tree({ 100: { ppid: 1, comm: "bash" } });
    expect(resolveHarnessPid(100, readInfo)).toBeNull();
  });

  test("returns null when the process is gone mid-walk", () => {
    const readInfo = tree({ 100: { ppid: 200, comm: "sh" } }); // 200 missing
    expect(resolveHarnessPid(100, readInfo)).toBeNull();
  });

  test("matches the basename when `comm` is a full path", () => {
    // macOS reports a bare name, Linux may report a path. Both must match.
    const readInfo = tree({ 100: { ppid: 1, comm: "claude" } });
    expect(resolveHarnessPid(100, readInfo)).toBe(100);
  });
});

describe("mapping round-trip (mt#3900)", () => {
  test("a written conversation id reads back", () => {
    const io = memoryIo();
    expect(writeConversationMapping(TEST_PID, CONV_A, undefined, io)).toBe(true);
    expect(readConversationMapping(TEST_PID, io)).toBe(CONV_A);
  });

  test("a later write replaces the earlier one — this IS the /clear case", () => {
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, "startup", io);
    writeConversationMapping(TEST_PID, CONV_B, "clear", io);
    expect(readConversationMapping(TEST_PID, io)).toBe(CONV_B);
  });

  test("mappings are per-pid, so concurrent harnesses do not collide", () => {
    // Five `claude` processes were live when this was measured; keying on
    // anything coarser than the pid would have them overwrite each other.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, undefined, io);
    writeConversationMapping(TEST_PID_2, CONV_B, undefined, io);
    expect(readConversationMapping(TEST_PID, io)).toBe(CONV_A);
    expect(readConversationMapping(TEST_PID_2, io)).toBe(CONV_B);
  });

  test("an absent mapping reads as null, never as a guess", () => {
    expect(readConversationMapping(TEST_PID, memoryIo())).toBeNull();
  });

  test("a non-UUID conversation id is refused at write time", () => {
    const io = memoryIo();
    expect(writeConversationMapping(TEST_PID, "not-a-uuid", undefined, io)).toBe(false);
    expect(readConversationMapping(TEST_PID, io)).toBeNull();
  });

  test("malformed JSON on disk reads as null rather than throwing", () => {
    // A truncated or hand-edited file must degrade to the env fallback, not
    // take down the proxy's inbound transform.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, undefined, io);
    const [path] = [...io.files.keys()];
    io.files.set(path as string, "{not json");
    expect(readConversationMapping(TEST_PID, io)).toBeNull();
  });

  test("the id is normalized to lower case on both sides", () => {
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A.toUpperCase(), undefined, io);
    expect(readConversationMapping(TEST_PID, io)).toBe(CONV_A);
  });
});

/**
 * Staleness (SC5 / AT4, added in PR #2764 R1).
 *
 * A pid is ambiguous across time — the OS recycles it. Pid plus start time
 * identifies a process INSTANCE, which is what the mapping actually needs: an
 * entry left by a dead `claude` must not answer for a later, unrelated `claude`
 * that inherited its number.
 */
describe("recycled-pid staleness (mt#3900)", () => {
  const STARTED_A = "Mon Aug 10 06:00:00 2026";
  const STARTED_B = "Mon Aug 10 07:30:00 2026";

  test("an entry whose start time matches the live process is used", () => {
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, undefined, io, STARTED_A);
    expect(readConversationMapping(TEST_PID, io, () => STARTED_A)).toBe(CONV_A);
  });

  test("an entry from a RECYCLED pid is treated as absent", () => {
    // Written by one harness; the pid now belongs to a different one. Returning
    // CONV_A here would attribute this process's work to a dead conversation —
    // the same class of error the whole task exists to remove.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, undefined, io, STARTED_A);
    expect(readConversationMapping(TEST_PID, io, () => STARTED_B)).toBeNull();
  });

  test("a start time that cannot be read does not invalidate the entry", () => {
    // `ps` failing is not evidence of recycling. Degrade toward the existing
    // mapping rather than toward discarding a good one.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, undefined, io, STARTED_A);
    expect(readConversationMapping(TEST_PID, io, () => null)).toBe(CONV_A);
  });

  test("an entry without a recorded start time is still honored", () => {
    // Back-compat with any entry written before this field existed; absence is
    // not evidence of recycling either.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, undefined, io, null);
    expect(readConversationMapping(TEST_PID, io, () => STARTED_B)).toBe(CONV_A);
  });
});
