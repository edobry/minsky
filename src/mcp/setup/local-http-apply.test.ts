/**
 * Unit tests for the `minsky setup local-http` effect layer (mt#3816).
 *
 * The filesystem is in-memory and the daemon probe/spawn/kill are injected, so
 * these assert the two properties that matter operationally: a backup is the
 * ORIGINAL bytes taken before any rewrite, and the daemon step can tell
 * "nothing is there" apart from "something else is there".
 */

import { describe, test, expect } from "bun:test";
import {
  applyPlan,
  classifyDaemonProbe,
  ConfigWriteError,
  daemonSpawnCommand,
  ensureDaemonRunning,
  resolveSelfInvocation,
  revertCandidates,
  revertFromBackups,
  stopLocalDaemon,
  type DaemonProcessDeps,
} from "./local-http-apply";
import { planMigration, type ConfigFsDeps, type DiscoveredEntry } from "./local-http-config";
import type { HealthProbeOutcome } from "../daemon/local-daemon";

const DAEMON_URL = "http://127.0.0.1:48765/mcp";
const HEALTH_URL = "http://127.0.0.1:48765/health";
const PROJECT = "/w/minsky";
const HOME = "/home/e";
const PROJECT_MCP_JSON = `${PROJECT}/.mcp.json`;

function fakeFs(files: Record<string, string>): ConfigFsDeps & {
  read(p: string): string | undefined;
  paths(): string[];
} {
  const store = { ...files };
  return {
    read: (p) => store[p],
    paths: () => Object.keys(store),
    existsSync: (p) => Object.prototype.hasOwnProperty.call(store, p),
    readFileSync: (p) => {
      const value = store[p];
      if (value === undefined) throw new Error(`ENOENT: ${p}`);
      return value;
    },
    writeFileSync: (p, data) => {
      store[p] = data;
    },
    renameSync: (from, to) => {
      const value = store[from];
      if (value === undefined) throw new Error(`ENOENT: ${from}`);
      store[to] = value;
      delete store[from];
    },
    readdirSync: (dir) => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return Object.keys(store)
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map((p) => p.slice(prefix.length));
    },
  };
}

const PROXY_ENTRY: DiscoveredEntry = {
  scope: "project",
  file: PROJECT_MCP_JSON,
  serverName: "minsky",
  form: "proxy",
  command: "/bin/minsky",
  args: ["mcp", "proxy"],
};

/** Deliberately idiosyncratic formatting: the backup must preserve it exactly. */
const ORIGINAL_BYTES = `{
    "mcpServers": {
        "minsky": { "command": "/bin/minsky", "args": ["mcp", "proxy"], "type": "stdio" }
    }
}
`;

const NOW = new Date("2026-08-12T21:51:00.123Z");
const BACKUP = `${PROJECT_MCP_JSON}.minsky-backup-2026-08-12T21-51-00-123Z`;

describe("applyPlan", () => {
  test("backs up the ORIGINAL bytes and rewrites the entry", () => {
    const deps = fakeFs({ [PROJECT_MCP_JSON]: ORIGINAL_BYTES });
    const plan = planMigration([PROXY_ENTRY], DAEMON_URL);

    const result = applyPlan(plan, { deps, now: NOW });

    expect(result.entriesRewritten).toBe(1);
    expect(result.backups).toEqual([{ file: PROJECT_MCP_JSON, backup: BACKUP }]);
    expect(deps.read(BACKUP)).toBe(ORIGINAL_BYTES);

    const written = JSON.parse(deps.read(PROJECT_MCP_JSON) as string);
    expect(written.mcpServers.minsky.args).toEqual(["mcp", "shim", "--url", DAEMON_URL]);
    expect(written.mcpServers.minsky.type).toBe("stdio");
  });

  test("leaves no temp file behind", () => {
    const deps = fakeFs({ [PROJECT_MCP_JSON]: ORIGINAL_BYTES });
    applyPlan(planMigration([PROXY_ENTRY], DAEMON_URL), { deps, now: NOW });
    expect(deps.paths().some((p) => p.includes("minsky-tmp"))).toBe(false);
  });

  test("a no-op plan touches nothing at all", () => {
    const deps = fakeFs({ [PROJECT_MCP_JSON]: ORIGINAL_BYTES });
    const result = applyPlan(planMigration([], DAEMON_URL), { deps, now: NOW });
    expect(result.backups).toEqual([]);
    expect(deps.paths()).toEqual([PROJECT_MCP_JSON]);
    expect(deps.read(PROJECT_MCP_JSON)).toBe(ORIGINAL_BYTES);
  });

  test("refuses to write over a config it cannot parse, and writes no backup either", () => {
    const deps = fakeFs({ [PROJECT_MCP_JSON]: "{ not json" });
    const plan = planMigration([PROXY_ENTRY], DAEMON_URL);
    expect(() => applyPlan(plan, { deps, now: NOW })).toThrow(ConfigWriteError);
    expect(deps.read(PROJECT_MCP_JSON)).toBe("{ not json");
    expect(deps.read(BACKUP)).toBeUndefined();
  });

  test("an unreadable config names the file rather than failing opaquely", () => {
    const deps = fakeFs({});
    const plan = planMigration([PROXY_ENTRY], DAEMON_URL);
    expect(() => applyPlan(plan, { deps, now: NOW })).toThrow(PROJECT_MCP_JSON);
  });
});

describe("revertFromBackups", () => {
  test("restores the backup's exact bytes", () => {
    const deps = fakeFs({ [PROJECT_MCP_JSON]: ORIGINAL_BYTES });
    applyPlan(planMigration([PROXY_ENTRY], DAEMON_URL), { deps, now: NOW });
    expect(deps.read(PROJECT_MCP_JSON)).not.toBe(ORIGINAL_BYTES);

    const restored = revertFromBackups([PROJECT_MCP_JSON], { deps });

    expect(restored).toEqual([{ file: PROJECT_MCP_JSON, restoredFrom: BACKUP }]);
    expect(deps.read(PROJECT_MCP_JSON)).toBe(ORIGINAL_BYTES);
  });

  test("a candidate with no backup is skipped, not clobbered", () => {
    const deps = fakeFs({ [PROJECT_MCP_JSON]: ORIGINAL_BYTES });
    expect(revertFromBackups([PROJECT_MCP_JSON], { deps })).toEqual([]);
    expect(deps.read(PROJECT_MCP_JSON)).toBe(ORIGINAL_BYTES);
  });

  test("the candidate set is both files this command can write", () => {
    expect(revertCandidates(PROJECT, HOME)).toEqual([PROJECT_MCP_JSON, `${HOME}/.claude.json`]);
  });
});

describe("classifyDaemonProbe", () => {
  const ours: HealthProbeOutcome = { kind: "body", body: { service: "minsky-mcp" } };

  test("an asserted minsky-mcp identity is `running`", () => {
    expect(classifyDaemonProbe(ours).state).toBe("running");
  });

  test("nothing listening is `absent`", () => {
    expect(classifyDaemonProbe({ kind: "unreachable", detail: "ECONNREFUSED" }).state).toBe(
      "absent"
    );
  });

  test("a DIFFERENT Minsky service on the port is `foreign`, not running", () => {
    const status = classifyDaemonProbe({ kind: "body", body: { service: "minsky-cockpit" } });
    expect(status.state).toBe("foreign");
    expect(status.detail).toContain("minsky-cockpit");
  });

  test("a 200 with no identity is `foreign` — absence of a claim is not a pass", () => {
    expect(classifyDaemonProbe({ kind: "body", body: { status: "ok" } }).state).toBe("foreign");
  });

  test("an HTTP error body is `foreign`", () => {
    expect(classifyDaemonProbe({ kind: "http-error", status: 404 }).state).toBe("foreign");
  });
});

describe("ensureDaemonRunning", () => {
  const ARGV = daemonSpawnCommand(["/bin/minsky"], PROJECT);
  const healthy: HealthProbeOutcome = { kind: "body", body: { service: "minsky-mcp" } };
  const down: HealthProbeOutcome = { kind: "unreachable", detail: "ECONNREFUSED" };

  function deps(outcomes: HealthProbeOutcome[], spawned: string[][]): DaemonProcessDeps {
    let i = 0;
    return {
      probe: async () => outcomes[Math.min(i++, outcomes.length - 1)] as HealthProbeOutcome,
      spawnDetached: (argv) => {
        spawned.push(argv);
      },
      sleep: async () => {},
    };
  }

  test("spawns nothing when a Minsky daemon is already serving", async () => {
    const spawned: string[][] = [];
    const result = await ensureDaemonRunning(ARGV, {
      healthUrl: HEALTH_URL,
      deps: deps([healthy], spawned),
    });
    expect(result.spawned).toBe(false);
    expect(spawned).toEqual([]);
  });

  test("spawns when absent and reports success once it answers with its identity", async () => {
    const spawned: string[][] = [];
    const result = await ensureDaemonRunning(ARGV, {
      healthUrl: HEALTH_URL,
      deps: deps([down, down, healthy], spawned),
    });
    expect(result.spawned).toBe(true);
    expect(spawned).toEqual([ARGV]);
  });

  test("refuses to spawn over a foreign holder of the port", async () => {
    const spawned: string[][] = [];
    const foreign: HealthProbeOutcome = { kind: "body", body: { service: "minsky-cockpit" } };
    await expect(
      ensureDaemonRunning(ARGV, { healthUrl: HEALTH_URL, deps: deps([foreign], spawned) })
    ).rejects.toThrow(ConfigWriteError);
    expect(spawned).toEqual([]);
  });

  test("a daemon that never becomes healthy fails and points at the revert", async () => {
    const spawned: string[][] = [];
    await expect(
      ensureDaemonRunning(ARGV, {
        healthUrl: HEALTH_URL,
        attempts: 3,
        deps: deps([down], spawned),
      })
    ).rejects.toThrow("--revert");
  });

  test("the spawn command names the repo it binds, so the choice is visible", () => {
    expect(ARGV).toEqual([
      "/bin/minsky",
      "mcp",
      "start",
      "--http",
      "--local-daemon",
      "--repo",
      PROJECT,
    ]);
  });
});

describe("resolveSelfInvocation", () => {
  test("a compiled binary is one token", () => {
    expect(resolveSelfInvocation(["/usr/local/bin/minsky", "setup", "local-http"])).toEqual([
      "/usr/local/bin/minsky",
    ]);
  });

  test("the from-source form keeps the script, or the daemon would be a bun with no script", () => {
    expect(
      resolveSelfInvocation(["/home/e/.bun/bin/bun", `${PROJECT}/src/cli.ts`, "setup"])
    ).toEqual(["/home/e/.bun/bin/bun", `${PROJECT}/src/cli.ts`]);
  });

  test("an empty argv falls back to the installed name rather than producing nothing", () => {
    expect(resolveSelfInvocation([])).toEqual(["minsky"]);
  });
});

describe("stopLocalDaemon", () => {
  const down: HealthProbeOutcome = { kind: "unreachable", detail: "ECONNREFUSED" };
  const healthy: HealthProbeOutcome = { kind: "body", body: { service: "minsky-mcp" } };
  const record = { port: 48765, host: "127.0.0.1", pid: 4242, startedAt: "2026-08-12T21:00:00Z" };

  test("signals the pid from the discovery record and confirms the port went quiet", async () => {
    const killed: Array<[number, string]> = [];
    const result = await stopLocalDaemon({
      healthUrl: HEALTH_URL,
      deps: {
        readRecord: () => record,
        killIfOurs: async (pid, signal) => {
          killed.push([pid, signal]);
          return true;
        },
        probe: async () => down,
        sleep: async () => {},
      },
    });
    expect(killed).toEqual([[4242, "SIGTERM"]]);
    expect(result.stopped).toBe(true);
  });

  test("no discovery record means nothing to stop — not a failure", async () => {
    const result = await stopLocalDaemon({
      healthUrl: HEALTH_URL,
      deps: { readRecord: () => null, sleep: async () => {} },
    });
    expect(result.stopped).toBe(false);
    expect(result.detail).toContain("nothing to stop");
  });

  test("a daemon still answering after SIGTERM is reported, not assumed dead", async () => {
    const result = await stopLocalDaemon({
      healthUrl: HEALTH_URL,
      attempts: 2,
      deps: {
        readRecord: () => record,
        killIfOurs: async () => true,
        probe: async () => healthy,
        sleep: async () => {},
      },
    });
    expect(result.stopped).toBe(false);
    expect(result.detail).toContain("still answering");
  });

  test("a pid whose live command line is not a daemon is NOT killed — stale record", async () => {
    const result = await stopLocalDaemon({
      healthUrl: HEALTH_URL,
      deps: {
        readRecord: () => record,
        killIfOurs: async () => false,
        sleep: async () => {},
      },
    });
    expect(result.stopped).toBe(false);
    expect(result.detail).toContain("stale");
  });
});
