import { describe, test, expect } from "bun:test";
import {
  classifyPortConflict,
  formatPortConflictFailure,
  ensureLocalDaemonToken,
  writeDiscoveryRecord,
  readDiscoveryRecord,
  removeDiscoveryRecord,
  localDaemonDiscoveryPath,
  findListenerPid,
  resolveLocalDaemonDefaults,
  TOKEN_FILE_MODE,
  DEFAULT_LOCAL_DAEMON_PORT,
  LOCAL_DAEMON_IDLE_TIMEOUT_MS,
  type LocalDaemonFsDeps,
} from "./local-daemon";

const ENV = { MINSKY_STATE_DIR: "/mock/state", MINSKY_LOCAL_MCP_TOKEN_PATH: "/mock/token" };

/**
 * In-memory filesystem. Every function under test takes its IO as a
 * parameter, so these tests exercise the real decision logic without a real
 * filesystem (`custom/no-real-fs-in-tests`).
 */
function makeMemoryFs(initial: Record<string, { content: string; mode: number }> = {}): {
  deps: LocalDaemonFsDeps;
  files: Record<string, { content: string; mode: number }>;
  dirs: string[];
} {
  const files = { ...initial };
  const dirs: string[] = [];
  const deps: LocalDaemonFsDeps = {
    existsSync: (p) => p in files,
    readFileSync: (p) => {
      const entry = files[p];
      if (!entry) throw new Error(`ENOENT: ${p}`);
      return entry.content;
    },
    writeFileSync: (p, data, mode) => {
      files[p] = { content: data, mode: mode ?? 0o644 };
    },
    renameSync: (from, to) => {
      const entry = files[from];
      if (!entry) throw new Error(`ENOENT: ${from}`);
      files[to] = entry;
      delete files[from];
    },
    mkdirSync: (p) => {
      dirs.push(p);
    },
    chmodSync: (p, mode) => {
      const entry = files[p];
      if (entry) entry.mode = mode;
    },
    statMode: (p) => {
      const entry = files[p];
      if (!entry) throw new Error(`ENOENT: ${p}`);
      return entry.mode;
    },
    unlinkSync: (p) => {
      delete files[p];
    },
  };
  return { deps, files, dirs };
}

describe("resolveLocalDaemonDefaults", () => {
  const base = {
    portFromCli: false,
    hostFromCli: false,
    currentPort: "3000",
    currentHost: "localhost",
    currentIdleTimeoutMs: undefined,
  };

  test("supplies the ADR-038 port and host when the caller passed neither", () => {
    const defaults = resolveLocalDaemonDefaults(base);
    expect(defaults.port).toBe(String(DEFAULT_LOCAL_DAEMON_PORT));
    expect(defaults.host).toBe("127.0.0.1");
  });

  test("an explicitly passed port survives the mode default", () => {
    // The whole point of threading commander's option SOURCE through: an
    // operator who types --port 3000 must get 3000, not 48765.
    const defaults = resolveLocalDaemonDefaults({ ...base, portFromCli: true });
    expect(defaults.port).toBe("3000");
  });

  test("an explicitly passed host survives the mode default", () => {
    const defaults = resolveLocalDaemonDefaults({ ...base, hostFromCli: true });
    expect(defaults.host).toBe("localhost");
  });

  test("shortens the idle timeout only when the operator set no value", () => {
    expect(resolveLocalDaemonDefaults(base).sessionIdleTimeoutMs).toBe(
      String(LOCAL_DAEMON_IDLE_TIMEOUT_MS)
    );
    expect(
      resolveLocalDaemonDefaults({ ...base, currentIdleTimeoutMs: "999" }).sessionIdleTimeoutMs
    ).toBe("999");
  });

  test("the local idle timeout is minutes, not the hosted 2h default", () => {
    // ADR-038 §Question 6 asks for minutes locally; 2h would leave abandoned
    // Server+Transport pairs pinned for the rest of the working day.
    expect(LOCAL_DAEMON_IDLE_TIMEOUT_MS).toBeLessThan(60 * 60 * 1000);
    expect(LOCAL_DAEMON_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(60 * 1000);
  });
});

describe("classifyPortConflict", () => {
  test("adopts only when the health body asserts the minsky-mcp identity", () => {
    const decision = classifyPortConflict({
      kind: "body",
      body: { status: "ok", service: "minsky-mcp" },
    });
    expect(decision.action).toBe("adopt");
  });

  test("fails when a DIFFERENT Minsky service answers — the mt#3142 signature", () => {
    // The dangerous case: a 200 from a healthy service that is the wrong one.
    // Every Minsky service is built from the same monorepo, so this is a real
    // misconfiguration shape, not a hypothetical.
    const decision = classifyPortConflict({
      kind: "body",
      body: { status: "ok", service: "minsky-cockpit" },
    });
    expect(decision.action).toBe("fail");
    expect(decision.detail).toContain("minsky-cockpit");
  });

  test("fails on a JSON 200 with no identity field", () => {
    const decision = classifyPortConflict({ kind: "body", body: { status: "ok" } });
    expect(decision.action).toBe("fail");
  });

  test("fails when the port is bound but /health does not answer", () => {
    // An agent-spawned competing daemon (observed in mt#3811) or any unrelated
    // listener lands here. "Something holds the port" must never adopt.
    const decision = classifyPortConflict({ kind: "unreachable", detail: "socket hang up" });
    expect(decision.action).toBe("fail");
    expect(decision.detail).toContain("socket hang up");
  });

  test("fails on an HTTP error status", () => {
    const decision = classifyPortConflict({ kind: "http-error", status: 404 });
    expect(decision.action).toBe("fail");
    expect(decision.detail).toContain("404");
  });
});

describe("formatPortConflictFailure", () => {
  test("names the port and the occupying pid", () => {
    const message = formatPortConflictFailure({
      host: "127.0.0.1",
      port: DEFAULT_LOCAL_DAEMON_PORT,
      pid: 4242,
      detail: "identity FAILED",
    });
    expect(message).toContain("127.0.0.1:48765");
    expect(message).toContain("pid 4242");
  });

  test("says so plainly when the pid could not be identified", () => {
    const message = formatPortConflictFailure({
      host: "127.0.0.1",
      port: 48765,
      pid: null,
      detail: "identity FAILED",
    });
    expect(message).toContain("could not be identified");
  });
});

describe("findListenerPid", () => {
  test("parses the first pid out of lsof output", () => {
    expect(findListenerPid(48765, () => "8123\n")).toBe(8123);
  });

  test("returns null when lsof finds nothing", () => {
    expect(findListenerPid(48765, () => "")).toBeNull();
  });

  test("returns null when lsof is unavailable — diagnostic only, never fatal", () => {
    expect(
      findListenerPid(48765, () => {
        throw new Error("command not found: lsof");
      })
    ).toBeNull();
  });
});

describe("ensureLocalDaemonToken", () => {
  test("mints a 0600 token when none exists", () => {
    const { deps, files } = makeMemoryFs();
    const result = ensureLocalDaemonToken({ env: ENV, deps, generate: () => "minted-token" });
    expect(result.created).toBe(true);
    expect(result.token).toBe("minted-token");
    expect(files["/mock/token"]?.mode).toBe(TOKEN_FILE_MODE);
  });

  test("is idempotent — an existing token is returned, never rewritten", () => {
    // Load-bearing: the tray supervisor, `setup local-http` and the daemon all
    // call this, and rewriting would invalidate the token every live shim holds.
    const { deps, files } = makeMemoryFs({
      "/mock/token": { content: "existing-token\n", mode: TOKEN_FILE_MODE },
    });
    const result = ensureLocalDaemonToken({
      env: ENV,
      deps,
      generate: () => {
        throw new Error("must not generate when a token already exists");
      },
    });
    expect(result.created).toBe(false);
    expect(result.token).toBe("existing-token");
    expect(files["/mock/token"]?.content).toBe("existing-token\n");
  });

  test("repairs a token file whose mode has drifted wider than 0600", () => {
    const { deps, files } = makeMemoryFs({
      "/mock/token": { content: "existing-token", mode: 0o644 },
    });
    ensureLocalDaemonToken({ env: ENV, deps, generate: () => "unused" });
    expect(files["/mock/token"]?.mode).toBe(TOKEN_FILE_MODE);
  });

  test("mints when the existing file is empty rather than returning an empty token", () => {
    const { deps } = makeMemoryFs({ "/mock/token": { content: "  \n", mode: TOKEN_FILE_MODE } });
    const result = ensureLocalDaemonToken({ env: ENV, deps, generate: () => "fresh" });
    expect(result.created).toBe(true);
    expect(result.token).toBe("fresh");
  });

  test("the real generator produces 64 hex chars", () => {
    const { deps } = makeMemoryFs();
    const result = ensureLocalDaemonToken({ env: ENV, deps });
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("discovery record", () => {
  const record = {
    port: 48765,
    host: "127.0.0.1",
    pid: 999,
    startedAt: "2026-08-11T00:00:00.000Z",
  };

  test("write then read round-trips", () => {
    const { deps } = makeMemoryFs();
    writeDiscoveryRecord(record, { env: ENV, deps });
    expect(readDiscoveryRecord({ env: ENV, deps })).toEqual(record);
  });

  test("writes via a temp file and rename so no reader sees a partial record", () => {
    const { deps, files } = makeMemoryFs();
    writeDiscoveryRecord(record, { env: ENV, deps });
    expect(Object.keys(files)).toEqual([localDaemonDiscoveryPath(ENV)]);
  });

  test("returns null for a missing file", () => {
    const { deps } = makeMemoryFs();
    expect(readDiscoveryRecord({ env: ENV, deps })).toBeNull();
  });

  test("returns null for malformed JSON rather than throwing", () => {
    const { deps } = makeMemoryFs({
      [localDaemonDiscoveryPath(ENV)]: { content: "{not json", mode: 0o644 },
    });
    expect(readDiscoveryRecord({ env: ENV, deps })).toBeNull();
  });

  test("returns null when a required field is missing or mistyped", () => {
    const { deps } = makeMemoryFs({
      [localDaemonDiscoveryPath(ENV)]: {
        content: JSON.stringify({ port: "48765", host: "127.0.0.1", pid: 1, startedAt: "x" }),
        mode: 0o644,
      },
    });
    expect(readDiscoveryRecord({ env: ENV, deps })).toBeNull();
  });

  test("remove deletes the record when this process owns it", () => {
    const { deps } = makeMemoryFs();
    writeDiscoveryRecord(record, { env: ENV, deps });
    expect(removeDiscoveryRecord(999, { env: ENV, deps })).toBe(true);
    expect(readDiscoveryRecord({ env: ENV, deps })).toBeNull();
  });

  test("remove is a no-op when the record belongs to another pid", () => {
    // The adopt path and the lost-bind-race path both exit while another
    // process legitimately holds the port; neither may delete the winner's
    // record on the way out.
    const { deps } = makeMemoryFs();
    writeDiscoveryRecord(record, { env: ENV, deps });
    expect(removeDiscoveryRecord(1234, { env: ENV, deps })).toBe(false);
    expect(readDiscoveryRecord({ env: ENV, deps })).toEqual(record);
  });
});
