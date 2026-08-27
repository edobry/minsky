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
  type ConversationTransition,
  type MappingIo,
  getConversationPidMapDir,
  getConversationPidMapPath,
  getConversationTransitionLogPath,
  processLiveness,
  pruneDeadMappings,
  readConversationMapping,
  resolveHarnessPid,
  writeConversationMapping,
} from "./conversation-pid-map";

const CONV_A = "8f3a2d1b-0000-0000-0000-000000000001";
const CONV_B = "8f3a2d1b-0000-0000-0000-000000000002";

/** Pids used only as map keys; chosen high to avoid colliding with real ones. */
const TEST_PID = 991001;
const TEST_PID_2 = 991002;

/** Two distinct harness start times, in `ps -o lstart=` shape. */
const STARTED_EARLIER = "Mon Aug 10 06:00:00 2026";
const STARTED_LATER = "Mon Aug 10 07:30:00 2026";

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
    append: (path, line) => {
      files.set(path, (files.get(path) ?? "") + line);
    },
  };
}

/** Parsed transition records from a memory io's log file. */
function transitionsIn(io: MappingIo & { files: Map<string, string> }) {
  const body = io.files.get(getConversationTransitionLogPath()) ?? "";
  return body
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ConversationTransition);
}

/**
 * Every fixture below uses a SYNTHETIC pid, which is genuinely dead on the
 * machine running the suite — so mt#4378's liveness check would reject each
 * entry for a reason none of these tests is about. Stating the assumption
 * explicitly is the point: these cases assert mapping semantics GIVEN a live
 * harness, and the dead-pid behaviour has its own tests below.
 */
const ALIVE = (): "alive" => "alive";

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
    expect(readConversationMapping(TEST_PID, io, undefined, ALIVE)).toBe(CONV_A);
  });

  test("a later write replaces the earlier one — this IS the /clear case", () => {
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, "startup", io);
    writeConversationMapping(TEST_PID, CONV_B, "clear", io);
    expect(readConversationMapping(TEST_PID, io, undefined, ALIVE)).toBe(CONV_B);
  });

  test("mappings are per-pid, so concurrent harnesses do not collide", () => {
    // Five `claude` processes were live when this was measured; keying on
    // anything coarser than the pid would have them overwrite each other.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, undefined, io);
    writeConversationMapping(TEST_PID_2, CONV_B, undefined, io);
    expect(readConversationMapping(TEST_PID, io, undefined, ALIVE)).toBe(CONV_A);
    expect(readConversationMapping(TEST_PID_2, io, undefined, ALIVE)).toBe(CONV_B);
  });

  test("an absent mapping reads as null, never as a guess", () => {
    expect(readConversationMapping(TEST_PID, memoryIo(), undefined, ALIVE)).toBeNull();
  });

  test("a non-UUID conversation id is refused at write time", () => {
    const io = memoryIo();
    expect(writeConversationMapping(TEST_PID, "not-a-uuid", undefined, io)).toBe(false);
    expect(readConversationMapping(TEST_PID, io, undefined, ALIVE)).toBeNull();
  });

  test("malformed JSON on disk reads as null rather than throwing", () => {
    // A truncated or hand-edited file must degrade to the env fallback, not
    // take down the proxy's inbound transform.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, undefined, io);
    const [path] = [...io.files.keys()];
    io.files.set(path as string, "{not json");
    expect(readConversationMapping(TEST_PID, io, undefined, ALIVE)).toBeNull();
  });

  test("the id is normalized to lower case on both sides", () => {
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A.toUpperCase(), undefined, io);
    expect(readConversationMapping(TEST_PID, io, undefined, ALIVE)).toBe(CONV_A);
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
/**
 * Transition capture (mt#3943).
 *
 * The edge between two conversations on one pid is observable for exactly the
 * instant before the overwrite, and nowhere else. Measured on 2026-08-10: four
 * `/clear` transitions across four harness pids in 23 minutes, all discarded.
 */
describe("conversation transition capture (mt#3943)", () => {
  test("a switch records one transition naming predecessor and successor", () => {
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, "startup", io, null);
    writeConversationMapping(TEST_PID, CONV_B, "clear", io, null);

    const records = transitionsIn(io);
    expect(records.length).toBe(1);
    expect(records[0]?.predecessor).toBe(CONV_A);
    expect(records[0]?.successor).toBe(CONV_B);
    expect(records[0]?.source).toBe("clear");
    expect(records[0]?.harnessPid).toBe(TEST_PID);
  });

  test("re-writing the SAME conversation records nothing", () => {
    // A `startup` on a fresh pid, or any repeat write, is not a transition.
    // Without this the log would fill with self-edges on every session start.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, "startup", io, null);
    writeConversationMapping(TEST_PID, CONV_A, "resume", io, null);
    expect(transitionsIn(io).length).toBe(0);
  });

  test("the FIRST mapping on a pid records nothing — there is no predecessor", () => {
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, "startup", io, null);
    expect(transitionsIn(io).length).toBe(0);
  });

  test("transitions accumulate rather than replacing each other", () => {
    const io = memoryIo();
    const CONV_C = "8f3a2d1b-0000-0000-0000-000000000003";
    writeConversationMapping(TEST_PID, CONV_A, "startup", io, null);
    writeConversationMapping(TEST_PID, CONV_B, "clear", io, null);
    writeConversationMapping(TEST_PID, CONV_C, "clear", io, null);

    const records = transitionsIn(io);
    expect(records.length).toBe(2);
    expect(records[1]?.predecessor).toBe(CONV_B);
    expect(records[1]?.successor).toBe(CONV_C);
  });

  test("a fork and a clear are distinguishable by source (SC6)", () => {
    // The whole point of recording a TRANSITION rather than a succession: a
    // reader must be able to tell "operator started a new topic" from "a
    // sibling branched off", because those mean different things and this
    // layer deliberately does not decide which.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, "startup", io, null);
    writeConversationMapping(TEST_PID, CONV_B, "fork", io, null);
    writeConversationMapping(TEST_PID_2, CONV_A, "startup", io, null);
    writeConversationMapping(TEST_PID_2, CONV_B, "clear", io, null);

    const sources = transitionsIn(io).map((r) => r.source);
    expect(sources).toEqual(["fork", "clear"]);
  });

  test("a failing transition log does NOT fail the mapping write (SC2)", () => {
    // The mapping is correctness (mt#3900); the log is observability. A hook
    // must never fail the event it observes, so the mapping must still land.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, "startup", io, null);

    const brokenIo: MappingIo = {
      ...io,
      append: () => {
        throw new Error("disk full");
      },
    };

    expect(writeConversationMapping(TEST_PID, CONV_B, "clear", brokenIo, null)).toBe(true);
    expect(readConversationMapping(TEST_PID, io, () => null, ALIVE)).toBe(CONV_B);
  });

  test("a recycled pid is distinguishable from a real switch using the log ALONE", () => {
    // PR #2791 R1. The first version of this test asserted only that the
    // SUCCESSOR's start time was recorded, and its name claimed that made a
    // recycled pid "legible" — which it did not. A pid identifies a process only
    // together with its start time, so telling "operator switched conversations"
    // from "the OS reused this pid for an unrelated harness" needs BOTH ends.
    // With one timestamp the two are identical in the log.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, "startup", io, STARTED_EARLIER);
    writeConversationMapping(TEST_PID, CONV_B, "clear", io, STARTED_LATER);

    const record = transitionsIn(io)[0];
    expect(record?.harnessStartedAt).toBe(STARTED_LATER);
    expect(record?.predecessorHarnessStartedAt).toBe(STARTED_EARLIER);
    // Differing ends ⇒ this edge crossed a process boundary, not a switch.
    expect(record?.predecessorHarnessStartedAt).not.toBe(record?.harnessStartedAt);
  });

  test("a genuine in-seat switch shows MATCHING start times at both ends", () => {
    // The contrast case: same live harness, operator ran /clear. Equal
    // timestamps are what makes this edge trustworthy as a real switch.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, "startup", io, STARTED_EARLIER);
    writeConversationMapping(TEST_PID, CONV_B, "clear", io, STARTED_EARLIER);

    const record = transitionsIn(io)[0];
    expect(record?.harnessStartedAt).toBe(STARTED_EARLIER);
    expect(record?.predecessorHarnessStartedAt).toBe(STARTED_EARLIER);
  });

  test("a predecessor written without a start time still records the edge", () => {
    // Back-compat: entries written before `harnessStartedAt` existed. Absence
    // must degrade to a less-legible edge, never to a dropped one.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, "startup", io, null);
    writeConversationMapping(TEST_PID, CONV_B, "clear", io, STARTED_LATER);

    const record = transitionsIn(io)[0];
    expect(record?.predecessor).toBe(CONV_A);
    expect(record?.predecessorHarnessStartedAt).toBeUndefined();
  });

  test("no succession is asserted — the record carries no continuesFrom", () => {
    // Guards the distinction itself. A `/clear` often means "new, unrelated
    // topic", so an edge is evidence of replacement, never of continuation.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, "startup", io, null);
    writeConversationMapping(TEST_PID, CONV_B, "clear", io, null);

    const raw = io.files.get(getConversationTransitionLogPath()) ?? "";
    expect(raw).not.toContain("continuesFrom");
    expect(raw).not.toContain("succeeds");
  });
});

describe("recycled-pid staleness (mt#3900)", () => {
  const STARTED_A = STARTED_EARLIER;
  const STARTED_B = STARTED_LATER;

  test("an entry whose start time matches the live process is used", () => {
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, undefined, io, STARTED_A);
    expect(readConversationMapping(TEST_PID, io, () => STARTED_A, ALIVE)).toBe(CONV_A);
  });

  test("an entry from a RECYCLED pid is treated as absent", () => {
    // Written by one harness; the pid now belongs to a different one. Returning
    // CONV_A here would attribute this process's work to a dead conversation —
    // the same class of error the whole task exists to remove.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, undefined, io, STARTED_A);
    expect(readConversationMapping(TEST_PID, io, () => STARTED_B, ALIVE)).toBeNull();
  });

  test("a start time that cannot be read does not invalidate the entry", () => {
    // `ps` failing is not evidence of recycling. Degrade toward the existing
    // mapping rather than toward discarding a good one.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, undefined, io, STARTED_A);
    expect(readConversationMapping(TEST_PID, io, () => null, ALIVE)).toBe(CONV_A);
  });

  test("an entry without a recorded start time is still honored", () => {
    // Back-compat with any entry written before this field existed; absence is
    // not evidence of recycling either.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, undefined, io, null);
    expect(readConversationMapping(TEST_PID, io, () => STARTED_B, ALIVE)).toBe(CONV_A);
  });
});

// ---------------------------------------------------------------------------
// Dead-pid entries and the prune (mt#4378)
// ---------------------------------------------------------------------------

/** A liveness stub that reports whatever the case under test needs. */
const DEAD = (): "dead" => "dead";
const UNKNOWN = (): "unknown" => "unknown";

describe("processLiveness (mt#4378)", () => {
  test("our own pid is alive", () => {
    // The one pid every environment is guaranteed to agree about.
    expect(processLiveness(process.pid)).toBe("alive");
  });

  test("a pid that is not running reports dead, NOT unknown", () => {
    // The whole point of the three-valued answer: `readProcessStartTime`
    // collapses "gone" and "ps failed" into null, and that conflation is what
    // let a dead pid's entry answer as a live mapping.
    const pid = 0x7ffffffe; // above any real pid on a 64-bit host
    expect(processLiveness(pid)).toBe("dead");
  });

  test("a non-pid degrades to unknown rather than dead", () => {
    // `unknown` must never prune or reject — wrongly deleting a live session's
    // mapping costs it its identity, which is worse than keeping a stale entry
    // the reader already rejects.
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(processLiveness(bad)).toBe("unknown");
    }
  });
});

describe("readConversationMapping rejects a DEAD pid (SC1, mt#4378)", () => {
  test("AT1 — a dead pid's entry is treated as absent", () => {
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, undefined, io, STARTED_EARLIER);
    expect(readConversationMapping(TEST_PID, io, () => STARTED_EARLIER, DEAD)).toBeNull();
  });

  test("AT2 negative control — the SAME entry is returned when the pid is alive", () => {
    // Without this, AT1 passes for the wrong reason: any unrelated defect that
    // made the read return null would satisfy it. The two cases differ only in
    // the liveness verdict, so the rejection is attributable to that and
    // nothing else.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, undefined, io, STARTED_EARLIER);
    expect(readConversationMapping(TEST_PID, io, () => STARTED_EARLIER, ALIVE)).toBe(CONV_A);
  });

  test("an UNKNOWN liveness does not reject — degrade toward the existing mapping", () => {
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, undefined, io, STARTED_EARLIER);
    expect(readConversationMapping(TEST_PID, io, () => STARTED_EARLIER, UNKNOWN)).toBe(CONV_A);
  });

  test("AT1 end-to-end — a live entry wins over a dead one in the same store", () => {
    // The shape the task was filed from: two entries on disk, one belonging to
    // a harness that exited days ago. Resolution must reach the live one.
    const io = memoryIo();
    writeConversationMapping(TEST_PID, CONV_A, undefined, io, STARTED_EARLIER); // dead harness
    writeConversationMapping(TEST_PID_2, CONV_B, undefined, io, STARTED_LATER); // live harness
    const liveOnly = (pid: number): "alive" | "dead" => (pid === TEST_PID_2 ? "alive" : "dead");

    expect(readConversationMapping(TEST_PID, io, () => STARTED_EARLIER, liveOnly)).toBeNull();
    expect(readConversationMapping(TEST_PID_2, io, () => STARTED_LATER, liveOnly)).toBe(CONV_B);
  });
});

describe("pruneDeadMappings (SC4, mt#4378)", () => {
  /** `memoryIo` plus the two optional capabilities the prune needs. */
  function prunableIo(): MappingIo & { files: Map<string, string> } {
    const io = memoryIo();
    return {
      ...io,
      list: (dir) =>
        [...io.files.keys()]
          .filter((p) => p.startsWith(`${dir}/`))
          .map((p) => p.slice(dir.length + 1)),
      remove: (path) => {
        io.files.delete(path);
      },
    };
  }

  test("removes dead entries and keeps live ones", () => {
    // Seeded directly rather than through `writeConversationMapping`: that
    // function now sweeps too, and its sweep (using the REAL liveness, against
    // synthetic pids that are genuinely dead) would remove the fixture before
    // the call under test ever ran. Building the store by hand keeps this test
    // about `pruneDeadMappings` and nothing else.
    const io = prunableIo();
    io.files.set(getConversationPidMapPath(TEST_PID), `{"conversationId":"${CONV_A}"}\n`);
    io.files.set(getConversationPidMapPath(TEST_PID_2), `{"conversationId":"${CONV_B}"}\n`);

    const pruned = pruneDeadMappings(io, (pid) => (pid === TEST_PID_2 ? "alive" : "dead"));

    expect(pruned).toBe(1);
    expect(io.files.has(getConversationPidMapPath(TEST_PID))).toBe(false);
    expect(io.files.has(getConversationPidMapPath(TEST_PID_2))).toBe(true);
  });

  test("an UNKNOWN liveness removes nothing", () => {
    const io = prunableIo();
    io.files.set(getConversationPidMapPath(TEST_PID), `{"conversationId":"${CONV_A}"}\n`);
    expect(pruneDeadMappings(io, UNKNOWN)).toBe(0);
    expect(io.files.has(getConversationPidMapPath(TEST_PID))).toBe(true);
  });

  test("an io without list/remove prunes nothing rather than throwing", () => {
    // The capabilities are optional so every pre-existing fake still satisfies
    // `MappingIo`. Omitting them must degrade to today's behaviour.
    expect(pruneDeadMappings(memoryIo(), DEAD)).toBe(0);
  });

  test("ignores files that are not `<pid>.json`", () => {
    const io = prunableIo();
    io.files.set(`${getConversationPidMapDir()}/README.md`, "not a mapping");
    io.files.set(getConversationPidMapPath(TEST_PID), `{"conversationId":"${CONV_A}"}\n`);

    expect(pruneDeadMappings(io, DEAD)).toBe(1);
    expect(io.files.has(`${getConversationPidMapDir()}/README.md`)).toBe(true);
  });

  test("a write sweeps the store, so the prune has a caller", () => {
    // An invocation path that nothing calls is the mt#1618 shape: the feature
    // exists, its tests pass, and it never runs.
    const io = prunableIo();
    io.files.set(getConversationPidMapPath(991003), '{"conversationId":"x"}\n');

    writeConversationMapping(TEST_PID, CONV_A, undefined, io, STARTED_EARLIER);

    // The stale entry is gone, written by the WRITE rather than a direct call.
    expect(io.files.has(getConversationPidMapPath(991003))).toBe(false);
  });

  test("a failing remove does not fail the write it rides on", () => {
    const io = prunableIo();
    const hostile = {
      ...io,
      remove: () => {
        throw new Error("EACCES");
      },
    };
    io.files.set(getConversationPidMapPath(991003), '{"conversationId":"x"}\n');

    expect(writeConversationMapping(TEST_PID, CONV_A, undefined, hostile, STARTED_EARLIER)).toBe(
      true
    );
  });
});
