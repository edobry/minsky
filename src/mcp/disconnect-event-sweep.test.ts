import { describe, it, expect, mock, afterEach } from "bun:test";
import type { BasePersistenceProvider } from "@minsky/domain/persistence/types";
import {
  parseNewDisconnectEvents,
  triggerMcpDisconnectEventSweep,
  ensureDirSync,
  defaultFsDeps,
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
    writeFileSync: (p: string, content: string) => {
      files.set(p, content);
    },
    mkdirSync: (p: string) => {
      dirs.add(p);
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
