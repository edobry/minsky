import { describe, it, expect, mock, afterEach } from "bun:test";
import type { BasePersistenceProvider } from "@minsky/domain/persistence/types";
import {
  parseNewDisconnectEvents,
  triggerMcpDisconnectEventSweep,
  ensureDirSync,
  acquireSweepLock,
  SWEEP_LOCK_MAX_AGE_MS,
  defaultFsDeps,
  defaultLogDeps,
  defaultProcDeps,
  type DisconnectSweepFsDeps,
} from "./disconnect-event-sweep";

/**
 * In-memory fake filesystem (per `custom/no-real-fs-in-tests`) — no real
 * `fs`/`os.tmpdir()` access. Keyed by path, values are file contents.
 */
function createFakeFs(initialFiles: Record<string, string> = {}): DisconnectSweepFsDeps {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const dirs = new Set<string>();
  return {
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    readFileSync: (p: string) => {
      const content = files.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    // mt#4495: report the real basenames so segment enumeration behaves the way
    // it would on disk. A fixture with no segments enumerates none, which keeps
    // every pre-segmentation case in this file reading the active file alone.
    readdirSync: (dir: string) =>
      [...files.keys()]
        .filter((p) => p.slice(0, p.lastIndexOf("/")) === dir)
        .map((p) => p.slice(p.lastIndexOf("/") + 1)),
    writeFileSync: (p: string, content: string) => {
      files.set(p, content);
    },
    mkdirSync: (p: string) => {
      dirs.add(p);
    },
    // mt#4617 sweep lock. `link` must throw EEXIST when the destination is
    // already taken — that throw IS the mutual exclusion the lock relies on, so
    // a fake that silently succeeds would make every concurrency test pass
    // vacuously. It also copies the CONTENT, which is what makes the lock name
    // and its payload appear together (PR #3396 R1).
    linkSync: (existing: string, target: string) => {
      if (files.has(target) || dirs.has(target)) {
        throw Object.assign(new Error(`EEXIST: file already exists, link '${target}'`), {
          code: "EEXIST",
        });
      }
      const content = files.get(existing);
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file, link '${existing}'`), {
          code: "ENOENT",
        });
      }
      files.set(target, content);
    },
    unlinkSync: (p: string) => {
      if (!files.delete(p)) {
        throw Object.assign(new Error(`ENOENT: no such file, unlink '${p}'`), { code: "ENOENT" });
      }
    },
  };
}

describe("parseNewDisconnectEvents (mt#2537)", () => {
  it("returns all disconnect lines when hwm is null", () => {
    const raw = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00Z",
        serverName: "s",
        kind: "disconnect",
        cause: "stdin_close",
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:01:00Z",
        serverName: "s",
        kind: "disconnect",
        cause: "stdin_close",
      }),
    ].join("\n");
    const events = parseNewDisconnectEvents(raw, null);
    expect(events).toHaveLength(2);
  });

  it("filters out lines at or before the HWM", () => {
    const raw = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00Z",
        serverName: "s",
        kind: "disconnect",
        cause: "stdin_close",
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:01:00Z",
        serverName: "s",
        kind: "disconnect",
        cause: "stdin_close",
      }),
    ].join("\n");
    const events = parseNewDisconnectEvents(raw, "2026-01-01T00:00:00Z");
    expect(events).toHaveLength(1);
    expect(events[0]?.timestamp).toBe("2026-01-01T00:01:00Z");
  });

  it("skips non-disconnect kinds (process_start, reconnect, transport_error)", () => {
    const raw = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00Z",
        serverName: "s",
        kind: "process_start",
        cause: "process_start",
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:01:00Z",
        serverName: "s",
        kind: "reconnect",
        cause: "unknown",
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:02:00Z",
        serverName: "s",
        kind: "disconnect",
        cause: "stdin_close",
      }),
    ].join("\n");
    const events = parseNewDisconnectEvents(raw, null);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("disconnect");
  });

  it("skips malformed lines and legacy bracket residue without throwing", () => {
    const raw = [
      "[",
      "not json at all",
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00Z",
        serverName: "s",
        kind: "disconnect",
        cause: "stdin_close",
      }),
      "]",
      "",
    ].join("\n");
    const events = parseNewDisconnectEvents(raw, null);
    expect(events).toHaveLength(1);
  });

  it("skips entries missing required fields", () => {
    const raw = [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", kind: "disconnect" }), // missing serverName/cause
      JSON.stringify({ serverName: "s", kind: "disconnect", cause: "stdin_close" }), // missing timestamp
    ].join("\n");
    const events = parseNewDisconnectEvents(raw, null);
    expect(events).toHaveLength(0);
  });
});

describe("ensureDirSync (mt#2633 — TOCTOU fix)", () => {
  it("does not throw when called twice in a row for the same directory", () => {
    // Fake fs whose mkdirSync mimics real fs.mkdirSync semantics: throws
    // EEXIST when the directory already exists and `recursive` is not
    // passed as true, but is a no-op when `recursive: true` is passed.
    // This reproduces the shape a non-hardcoded-recursive implementation of
    // DisconnectSweepFsDeps would have, so the test actually exercises the
    // fix (always passing `{ recursive: true }`) rather than passing
    // vacuously because of an unrelated idempotent fake.
    const dirs = new Set<string>();
    const strictMkdirDeps: DisconnectSweepFsDeps = {
      existsSync: (p) => dirs.has(p),
      readFileSync: () => {
        throw new Error("not used by this test");
      },
      readdirSync: () => [],
      writeFileSync: () => {
        // not used by this test
      },
      mkdirSync: (p, options) => {
        if (dirs.has(p) && !options?.recursive) {
          throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${p}'`), {
            code: "EEXIST",
          });
        }
        dirs.add(p);
      },
      linkSync: () => {
        throw new Error("not used by this test");
      },
      unlinkSync: () => {
        // not used by this test
      },
    };

    // First call: directory does not exist yet.
    expect(() => ensureDirSync("/fake/state-dir", strictMkdirDeps)).not.toThrow();
    expect(strictMkdirDeps.existsSync("/fake/state-dir")).toBe(true);

    // Second call: directory already exists (simulating a concurrent
    // process having created it, or simply a second sweep run). The old
    // `if (!existsSync) mkdirSync` shape would still be safe here since the
    // check would short-circuit — the real risk was a *concurrent* creation
    // between check and use, which this second call stands in for by
    // calling mkdirSync directly against an already-existing directory.
    expect(() => ensureDirSync("/fake/state-dir", strictMkdirDeps)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// defaultFsDeps.mkdirSync (mt#2633 R1 — PR #2272 review finding): the
// production default wraps the REAL `node:fs.mkdirSync`, so pinning its
// recursive-by-default behavior requires exercising real fs against an
// isolated scratch dir — an in-memory fake would not exercise the actual
// `fs.mkdirSync` call this regression was in. custom/no-real-fs-in-tests is
// suppressed for this section only, following the precedent in
// packages/domain/src/session/session-post-merge-sync.test.ts and
// packages/domain/src/deployment/service-resolver.test.ts.
// ---------------------------------------------------------------------------
/* eslint-disable custom/no-real-fs-in-tests */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("defaultFsDeps.mkdirSync (mt#2633 R1 — PR #2272 review)", () => {
  let scratchDir: string | undefined;

  afterEach(() => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
  });

  it("does not disable recursive mode when called with a partial options object ({})", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "mt2633-mkdir-test-"));
    const target = join(scratchDir, "nested", "dir");

    // First call creates the (nested, not-yet-existing) directory tree.
    // Passing `{}` rather than omitting the second argument entirely is the
    // point of this test.
    defaultFsDeps.mkdirSync(target, {});
    expect(existsSync(target)).toBe(true);

    // Second call: the directory already exists, and we again pass a
    // partial options object ({}). This is the exact regression the PR
    // #2272 review caught: `fs.mkdirSync(p, options ?? { recursive: true })`
    // only substitutes the default when `options` is `undefined` — passing
    // `{}` (a defined-but-empty object) short-circuits the `??` and forwards
    // `{}` (non-recursive) straight to `fs.mkdirSync`, which throws EEXIST
    // against an already-existing directory. The fixed implementation
    // (`{ ...options, recursive: options?.recursive ?? true }`) must not
    // throw here.
    expect(() => defaultFsDeps.mkdirSync(target, {})).not.toThrow();
  });
});
/* eslint-enable custom/no-real-fs-in-tests */

describe("triggerMcpDisconnectEventSweep (mt#2537)", () => {
  // Redirect disconnect-tracker's state-dir resolution to a fixed fake path
  // (no real fs/tmpdir — the fake path is never touched by real I/O, only by
  // the in-memory fake fs below) so the sweep's internal `getDisconnectLogPath()`
  // call resolves to a path this test controls.
  process.env.MINSKY_STATE_DIR = "/fake-minsky-state-dir";
  const LOG_PATH = "/fake-minsky-state-dir/mcp-disconnect-log.json";
  const HWM_PATH = "/fake-minsky-state-dir/mcp-disconnect-sweep-hwm.json";
  const SERVER_NAME = "Minsky MCP Server";

  it("returns early (no-op) when persistence lacks sql capability", async () => {
    const getDatabaseConnection = mock(() => Promise.resolve({}));
    const provider = {
      capabilities: { sql: false },
      getDatabaseConnection,
    } as unknown as BasePersistenceProvider;

    await triggerMcpDisconnectEventSweep(provider, createFakeFs());
    expect(getDatabaseConnection).not.toHaveBeenCalled();
  });

  it("returns early (no-op) when getDatabaseConnection resolves to null", async () => {
    const getDatabaseConnection = mock(() => Promise.resolve(null));
    const provider = {
      capabilities: { sql: true },
      getDatabaseConnection,
    } as unknown as BasePersistenceProvider;

    await triggerMcpDisconnectEventSweep(provider, createFakeFs());
    expect(getDatabaseConnection).toHaveBeenCalledTimes(1);
  });

  it("returns early (no-op) when the disconnect log file does not exist", async () => {
    const fakeDb = { insert: mock() };
    const provider = {
      capabilities: { sql: true },
      getDatabaseConnection: () => Promise.resolve(fakeDb),
    } as unknown as BasePersistenceProvider;

    await triggerMcpDisconnectEventSweep(provider, createFakeFs());
    expect(fakeDb.insert).not.toHaveBeenCalled();
  });

  it("emits mcp.disconnect for new entries and persists the HWM", async () => {
    const logContent = `${[
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00Z",
        serverName: SERVER_NAME,
        kind: "disconnect",
        cause: "stdin_close",
        uptimeMs: 12345,
        processRole: "main_session",
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:01:00Z",
        serverName: SERVER_NAME,
        kind: "disconnect",
        cause: "stdin_close",
      }),
    ].join("\n")}\n`;
    const fakeFs = createFakeFs({ [LOG_PATH]: logContent });

    const insertValues = mock(() => Promise.resolve());
    const fakeDb = { insert: () => ({ values: insertValues }) };
    const provider = {
      capabilities: { sql: true },
      getDatabaseConnection: () => Promise.resolve(fakeDb),
    } as unknown as BasePersistenceProvider;

    await triggerMcpDisconnectEventSweep(provider, fakeFs);

    expect(insertValues).toHaveBeenCalledTimes(2);

    const hwm = JSON.parse(fakeFs.readFileSync(HWM_PATH));
    expect(hwm.lastSweptTimestamp).toBe("2026-01-01T00:01:00Z");

    // A second sweep with no new lines should not re-emit.
    await triggerMcpDisconnectEventSweep(provider, fakeFs);
    expect(insertValues).toHaveBeenCalledTimes(2);
  });

  it("leaves the HWM at the last PERSISTED event when an emit fails mid-backlog", async () => {
    // Four disconnects; the third insert fails, as it does when SIGTERM closes
    // persistence under this fire-and-forget sweep mid-backlog (mt#4131).
    const timestamps = [
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:00Z",
      "2026-01-01T00:02:00Z",
      "2026-01-01T00:03:00Z",
    ];
    const logContent = `${timestamps
      .map((timestamp) =>
        JSON.stringify({
          timestamp,
          serverName: SERVER_NAME,
          kind: "disconnect",
          cause: "staleness_exit",
        })
      )
      .join("\n")}\n`;
    const fakeFs = createFakeFs({ [LOG_PATH]: logContent });

    let attempts = 0;
    const insertValues = mock(() => {
      attempts++;
      if (attempts >= 3) {
        const err = new Error('Failed query: insert into "system_events" ...');
        err.cause = Object.assign(new Error("write CONNECTION_ENDED host:6543"), {
          code: "CONNECTION_ENDED",
        });
        return Promise.reject(err);
      }
      return Promise.resolve();
    });
    const fakeDb = { insert: () => ({ values: insertValues }) };
    const provider = {
      capabilities: { sql: true },
      getDatabaseConnection: () => Promise.resolve(fakeDb),
    } as unknown as BasePersistenceProvider;

    const warnCalls: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logDeps = {
      warn: (message: string, meta?: Record<string, unknown>) =>
        void warnCalls.push({ message, meta }),
    };

    await triggerMcpDisconnectEventSweep(provider, fakeFs, logDeps);

    // Halted at the first failure rather than attempting (and losing) the rest:
    // 2 successes + 1 failure = 3 attempts, NOT 4.
    expect(insertValues).toHaveBeenCalledTimes(3);

    // Exactly ONE warning for the halt, not one per dropped event — and it
    // carries BOTH halves: the driver cause captured from the emitter, and the
    // count left unswept. The emitter's own warn is routed into the sweep
    // rather than logged separately, so a single failure is a single line.
    expect(warnCalls).toHaveLength(1);
    const halt = warnCalls.at(0);
    expect(halt?.meta?.causeCode).toBe("CONNECTION_ENDED");
    expect(halt?.meta?.persisted).toBe(2);
    expect(halt?.meta?.unswept).toBe(2);

    // The HWM must not pass an event that was never written — otherwise the
    // unwritten events are marked swept and are gone for good.
    const hwm = JSON.parse(fakeFs.readFileSync(HWM_PATH));
    expect(hwm.lastSweptTimestamp).toBe("2026-01-01T00:01:00Z");

    // Next boot re-sweeps from there: the two unpersisted events are retried.
    attempts = 0;
    await triggerMcpDisconnectEventSweep(provider, fakeFs);
    expect(insertValues).toHaveBeenCalledTimes(5);
    expect(JSON.parse(fakeFs.readFileSync(HWM_PATH)).lastSweptTimestamp).toBe(
      "2026-01-01T00:03:00Z"
    );
  });

  it("never throws even if getDatabaseConnection rejects (best-effort contract)", async () => {
    const fakeFs = createFakeFs({
      [LOG_PATH]: `${JSON.stringify({
        timestamp: "2026-01-01T00:00:00Z",
        serverName: "s",
        kind: "disconnect",
        cause: "stdin_close",
      })}\n`,
    });

    const provider = {
      capabilities: { sql: true },
      getDatabaseConnection: () => {
        throw new Error("boom");
      },
    } as unknown as BasePersistenceProvider;

    await expect(triggerMcpDisconnectEventSweep(provider, fakeFs)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mt#4617 — the sweep lock. `readHwm` -> emit-loop -> `writeHwm` is a
// read-modify-write with nothing serializing it, and the sweep is dispatched
// fire-and-forget at every MCP boot on a host recording up to 326 process
// starts/day. Two overlapping boots both read the pre-sweep HWM and both emit
// the same backlog.
// ---------------------------------------------------------------------------
describe("triggerMcpDisconnectEventSweep — concurrent boots (mt#4617)", () => {
  process.env.MINSKY_STATE_DIR = "/fake-minsky-state-dir";
  const LOG_PATH = "/fake-minsky-state-dir/mcp-disconnect-log.json";
  const LOCK_PATH = "/fake-minsky-state-dir/mcp-disconnect-sweep.lock";
  const HWM_PATH = "/fake-minsky-state-dir/mcp-disconnect-sweep-hwm.json";
  const SERVER_NAME = "Minsky MCP Server";

  function threeDisconnects(): string {
    return `${["00:00:00", "00:01:00", "00:02:00"]
      .map((t) =>
        JSON.stringify({
          timestamp: `2026-01-01T${t}Z`,
          serverName: SERVER_NAME,
          kind: "disconnect",
          cause: "stdin_close",
          uptimeMs: 41,
          processRole: "helper",
        })
      )
      .join("\n")}\n`;
  }

  function providerWith(insertValues: () => unknown): BasePersistenceProvider {
    const fakeDb = { insert: () => ({ values: insertValues }) };
    return {
      capabilities: { sql: true },
      getDatabaseConnection: () => Promise.resolve(fakeDb),
    } as unknown as BasePersistenceProvider;
  }

  it("bridges each disconnect exactly once when two sweeps overlap", async () => {
    // ONE shared fake fs — the same state dir both boots read and write, which
    // is what makes this a race rather than two isolated sweeps. mem#1292
    // records the sibling mistake on PR #3368: five SEQUENTIAL rollers never
    // contend, so a control against un-fixed code passed clean and the test was
    // inert.
    const fakeFs = createFakeFs({ [LOG_PATH]: threeDisconnects() });

    // Park sweep A inside its first insert until sweep B has run start to
    // finish. That models the window deterministically instead of hoping the
    // scheduler interleaves.
    let releaseA!: () => void;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let sawFirstInsert!: () => void;
    const firstInsertSeen = new Promise<void>((resolve) => {
      sawFirstInsert = resolve;
    });

    let emitted = 0;
    let holdNext = true;
    const insertValues = async () => {
      emitted++;
      if (holdNext) {
        holdNext = false;
        sawFirstInsert();
        await aGate;
      }
    };
    const provider = providerWith(insertValues);

    const a = triggerMcpDisconnectEventSweep(provider, fakeFs);
    await firstInsertSeen; // A holds the lock and has not yet written the HWM
    await triggerMcpDisconnectEventSweep(provider, fakeFs); // B must find the lock held
    releaseA();
    await a;

    expect(emitted).toBe(3);
    // PR #3396 R1 (NON-BLOCKING): assert the surrounding state too, not just
    // the emit count — the HWM must have advanced to the newest event, and the
    // lock must not survive either sweep.
    expect(JSON.parse(fakeFs.readFileSync(HWM_PATH)).lastSweptTimestamp).toBe(
      "2026-01-01T00:02:00Z"
    );
    expect(fakeFs.existsSync(LOCK_PATH)).toBe(false);
  });

  it("releases the lock when the sweep finishes, so the next boot can sweep", async () => {
    const fakeFs = createFakeFs({ [LOG_PATH]: threeDisconnects() });
    const provider = providerWith(() => Promise.resolve());

    await triggerMcpDisconnectEventSweep(provider, fakeFs);

    expect(fakeFs.existsSync(LOCK_PATH)).toBe(false);
  });

  it("reclaims a lock whose holder process is gone", async () => {
    // The holder dying mid-sweep is the COMMON case here, not the edge case:
    // this process exits constantly (staleness_exit, SIGTERM, stdin close). A
    // lock that only cleared on graceful release would wedge the bridge.
    const fakeFs = createFakeFs({
      [LOG_PATH]: threeDisconnects(),
      [LOCK_PATH]: JSON.stringify({ pid: 999999 }),
    });
    let emitted = 0;
    const provider = providerWith(() => {
      emitted++;
      return Promise.resolve();
    });

    await triggerMcpDisconnectEventSweep(provider, fakeFs, defaultLogDeps, {
      pid: 1234,
      now: () => 0,
      isAlive: () => false,
    });

    expect(emitted).toBe(3);
  });

  it("does NOT reclaim a lock whose holder is still alive", async () => {
    const fakeFs = createFakeFs({
      [LOG_PATH]: threeDisconnects(),
      [LOCK_PATH]: JSON.stringify({ pid: 999999 }),
    });
    let emitted = 0;
    const provider = providerWith(() => {
      emitted++;
      return Promise.resolve();
    });

    await triggerMcpDisconnectEventSweep(provider, fakeFs, defaultLogDeps, {
      pid: 1234,
      now: () => 0,
      isAlive: () => true,
    });

    expect(emitted).toBe(0);
    // The live holder's lock must survive our attempt untouched.
    expect(fakeFs.existsSync(LOCK_PATH)).toBe(true);
  });

  it("treats an EPERM liveness probe as ALIVE, not as a corpse", () => {
    // `process.kill(pid, 0)` throws EPERM for a process that exists but is
    // owned by another user. Reading that as dead would reclaim a lock held by
    // a live peer — the failure mode this assertion pins.
    const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const proc = process as unknown as { kill: unknown };
    const originalKill = proc.kill;
    try {
      proc.kill = () => {
        throw eperm;
      };
      expect(defaultProcDeps.isAlive(999999)).toBe(true);
    } finally {
      proc.kill = originalKill;
    }
  });

  it("treats a non-pid as NOT alive, so a garbage lock is reclaimable", () => {
    expect(defaultProcDeps.isAlive(0)).toBe(false);
    expect(defaultProcDeps.isAlive(-1)).toBe(false);
    expect(defaultProcDeps.isAlive(1.5)).toBe(false);
  });

  // PR #3396 R1 (BLOCKING): the lock name must never be observable without its
  // payload. The original shape created an empty file with `wx` and wrote the
  // pid a moment later; a peer landing in that window read "names no holder"
  // and reclaimed a lock that was very much held.
  //
  // Worth stating why the concurrency test above did NOT catch this: the fake
  // fs is single-threaded and there is no await between create and write, so
  // the empty state was never observable IN THE FAKE. The race is real between
  // two OS processes and invisible to a test that models them as coroutines —
  // which is why this asserts the invariant directly instead of trying to
  // schedule the window.
  it("publishes the lock atomically with its payload, never as a bare name", () => {
    const fakeFs = createFakeFs();
    const release = acquireSweepLock(fakeFs, { pid: 4321, now: () => 1000, isAlive: () => false });
    expect(release).not.toBeNull();

    const body = JSON.parse(fakeFs.readFileSync(LOCK_PATH)) as {
      pid?: number;
      writtenAtMs?: number;
    };
    expect(body.pid).toBe(4321);
    expect(body.writtenAtMs).toBe(1000);
  });

  it("leaves no temp file behind after taking the lock", () => {
    const fakeFs = createFakeFs();
    acquireSweepLock(fakeFs, { pid: 4321, now: () => 1000, isAlive: () => false });
    expect(fakeFs.existsSync(`${LOCK_PATH}.4321.tmp`)).toBe(false);
  });

  // PR #3396 R1 (NON-BLOCKING): pid reuse. Without an age backstop a lock whose
  // holder died and whose pid was later recycled by an unrelated live process is
  // never reclaimed, and the bridge stops silently and permanently.
  it("reclaims a lock older than the max age even when its pid looks alive", () => {
    const fakeFs = createFakeFs({
      [LOCK_PATH]: JSON.stringify({ pid: 999999, writtenAtMs: 0 }),
    });
    const release = acquireSweepLock(fakeFs, {
      pid: 4321,
      now: () => SWEEP_LOCK_MAX_AGE_MS + 1,
      isAlive: () => true, // the pid resolves — to a DIFFERENT, unrelated process
    });
    expect(release).not.toBeNull();
  });

  it("does NOT reclaim a lock inside the max age whose pid is alive", () => {
    const fakeFs = createFakeFs({
      [LOCK_PATH]: JSON.stringify({ pid: 999999, writtenAtMs: 0 }),
    });
    const release = acquireSweepLock(fakeFs, {
      pid: 4321,
      now: () => SWEEP_LOCK_MAX_AGE_MS - 1,
      isAlive: () => true,
    });
    expect(release).toBeNull();
  });

  // PR #3396 R1 flagged the early returns inside the locked region as leaking
  // the lock. They do not — they sit inside a `try`, and `finally` runs on
  // return — but the previous test only covered the path where the sweep had
  // work to do. These pin both no-work exits, which is cheaper than arguing the
  // control flow and leaves the property enforced rather than asserted.
  it("releases the lock when the corpus is empty (early return)", async () => {
    const fakeFs = createFakeFs(); // no log file at all -> corpus is empty
    const provider = providerWith(() => Promise.resolve());

    await triggerMcpDisconnectEventSweep(provider, fakeFs);

    expect(fakeFs.existsSync(LOCK_PATH)).toBe(false);
  });

  it("releases the lock when the HWM already covers the log (early return)", async () => {
    const fakeFs = createFakeFs({
      [LOG_PATH]: threeDisconnects(),
      [HWM_PATH]: JSON.stringify({ lastSweptTimestamp: "2026-01-02T00:00:00Z" }),
    });
    let emitted = 0;
    const provider = providerWith(() => {
      emitted++;
      return Promise.resolve();
    });

    await triggerMcpDisconnectEventSweep(provider, fakeFs);

    expect(emitted).toBe(0); // nothing new to sweep — the early return we mean
    expect(fakeFs.existsSync(LOCK_PATH)).toBe(false);
  });
});
