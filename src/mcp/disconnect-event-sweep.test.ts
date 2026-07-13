import { describe, it, expect, mock } from "bun:test";
import type { BasePersistenceProvider } from "@minsky/domain/persistence/types";
import {
  parseNewDisconnectEvents,
  triggerMcpDisconnectEventSweep,
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

describe("triggerMcpDisconnectEventSweep (mt#2537)", () => {
  // Redirect disconnect-tracker's state-dir resolution to a fixed fake path
  // (no real fs/tmpdir — the fake path is never touched by real I/O, only by
  // the in-memory fake fs below) so the sweep's internal `getDisconnectLogPath()`
  // call resolves to a path this test controls.
  process.env.MINSKY_STATE_DIR = "/fake-minsky-state-dir";
  const LOG_PATH = "/fake-minsky-state-dir/mcp-disconnect-log.json";
  const HWM_PATH = "/fake-minsky-state-dir/mcp-disconnect-sweep-hwm.json";

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
        serverName: "Minsky MCP Server",
        kind: "disconnect",
        cause: "stdin_close",
        uptimeMs: 12345,
        processRole: "main_session",
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:01:00Z",
        serverName: "Minsky MCP Server",
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
