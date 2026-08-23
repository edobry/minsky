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
  healthUrlForMcpUrl,
  parseDaemonEndpoint,
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

describe("classifyDaemonProbe — mt#4297 readiness, not just identity", () => {
  // The incumbent that motivated this: right identity, 200, and no database.
  const unreadyByMode: HealthProbeOutcome = {
    kind: "body",
    body: { service: "minsky-mcp", persistence: { mode: "unconfigured" } },
  };

  test("`ready: false` is `not-ready`, not `running`", () => {
    const status = classifyDaemonProbe({
      kind: "body",
      body: { service: "minsky-mcp", ready: false, persistence: { mode: "unconfigured" } },
    });
    expect(status.state).toBe("not-ready");
    expect(status.detail).toContain("database");
  });

  test("`ready: true` is `running`", () => {
    expect(
      classifyDaemonProbe({
        kind: "body",
        body: { service: "minsky-mcp", ready: true, persistence: { mode: "connected" } },
      }).state
    ).toBe("running");
  });

  test("falls back to persistence.mode for a daemon predating the `ready` field", () => {
    expect(classifyDaemonProbe(unreadyByMode).state).toBe("not-ready");
  });

  test("persistence.mode `connected` with no `ready` field is `running`", () => {
    expect(
      classifyDaemonProbe({
        kind: "body",
        body: { service: "minsky-mcp", persistence: { mode: "connected" } },
      }).state
    ).toBe("running");
  });

  test("neither signal present stays `running` — cannot-tell is not not-ready", () => {
    // Refusing here would have failed closed against every daemon built before
    // this change, turning a safety check into an outage during rollout.
    expect(classifyDaemonProbe({ kind: "body", body: { service: "minsky-mcp" } }).state).toBe(
      "running"
    );
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

  test("mt#4297: refuses a not-ready incumbent, and spawns nothing", async () => {
    // The state observed live: right identity, 200, no database. Before this,
    // `running` was returned and the migration proceeded onto it. Spawning is
    // asserted absent for a specific reason -- `not-ready` falls through the
    // `running`/`foreign` guards, so a missing branch would spawn a second
    // daemon that loses the bind race and adopts the very incumbent being
    // refused, and the config would be rewritten anyway.
    const spawned: string[][] = [];
    const unready: HealthProbeOutcome = {
      kind: "body",
      body: { service: "minsky-mcp", ready: false, persistence: { mode: "unconfigured" } },
    };

    await expect(
      ensureDaemonRunning(ARGV, { healthUrl: HEALTH_URL, deps: deps([unready], spawned) })
    ).rejects.toThrow(/cannot reach the database/);
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

  test("a daemon this call started is not described as one that was already up", async () => {
    // `classifyDaemonProbe`'s detail is phrased for the pre-spawn probe, where
    // adopting an existing daemon is the news. Reusing it after a spawn made the
    // caller print "Started the local MCP daemon (a minsky-mcp daemon is already
    // serving the port)" -- both outcomes asserted in one line, observed against
    // the real command while verifying AT1.
    const adopted = await ensureDaemonRunning(ARGV, {
      healthUrl: HEALTH_URL,
      deps: deps([healthy], []),
    });
    const started = await ensureDaemonRunning(ARGV, {
      healthUrl: HEALTH_URL,
      deps: deps([down, healthy], []),
    });

    expect(adopted.spawned).toBe(false);
    expect(adopted.status.detail).toContain("already serving");

    expect(started.spawned).toBe(true);
    expect(started.status.detail).not.toContain("already");
    // Still confirms health, so the line is not merely emptied out.
    expect(started.status.detail).toContain("/health");
  });

  test("probes the endpoint it was given, not the default", async () => {
    // PR #3032 R1: --url wrote a config pointing at one port while the ensure
    // step probed 48765, so the operator could be left aimed at nothing.
    const probed: string[] = [];
    const result = await ensureDaemonRunning(ARGV, {
      healthUrl: "http://127.0.0.1:9999/health",
      deps: {
        probe: async (url: string) => {
          probed.push(url);
          return healthy;
        },
        spawnDetached: () => {},
        sleep: async () => {},
      },
    });
    expect(probed).toEqual(["http://127.0.0.1:9999/health"]);
    expect(result.spawned).toBe(false);
  });

  test("refuses to spawn over a foreign holder of the port", async () => {
    const spawned: string[][] = [];
    const foreign: HealthProbeOutcome = { kind: "body", body: { service: "minsky-cockpit" } };
    await expect(
      ensureDaemonRunning(ARGV, { healthUrl: HEALTH_URL, deps: deps([foreign], spawned) })
    ).rejects.toThrow(ConfigWriteError);
    expect(spawned).toEqual([]);
  });

  test("mt#4337: a daemon that never becomes healthy reports that nothing was written", async () => {
    // This assertion used to be `.rejects.toThrow("--revert")`, because the
    // message pointed the operator at `setup local-http --revert` to undo a
    // migration that had already happened. It no longer has: the caller now
    // runs this step BEFORE `applyPlan`, so there is nothing to revert and
    // saying otherwise would send the operator to a command with no backup to
    // restore. See the CALLER INVARIANT on `ensureDaemonRunning`.
    const spawned: string[][] = [];
    await expect(
      ensureDaemonRunning(ARGV, {
        healthUrl: HEALTH_URL,
        attempts: 3,
        deps: deps([down], spawned),
      })
    ).rejects.toThrow("Nothing has been written.");
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

  test("a package runner keeps its package argument", () => {
    // PR #3032 R1: argv[1] under `bunx minsky ...` is the bin NAME, not a
    // script path, so the extension test missed it and the prefix collapsed to
    // a bare `bunx` -- spawning `bunx mcp start ...`, which names no package
    // and cannot run.
    expect(resolveSelfInvocation(["/home/e/.bun/bin/bunx", "minsky", "setup"])).toEqual([
      "/home/e/.bun/bin/bunx",
      "minsky",
    ]);
    expect(resolveSelfInvocation(["/usr/local/bin/npx", "minsky", "setup"])).toEqual([
      "/usr/local/bin/npx",
      "minsky",
    ]);
  });
});

describe("daemon endpoint threading", () => {
  test("a URL yields the host and port the daemon must bind", () => {
    expect(parseDaemonEndpoint("http://127.0.0.1:9999/mcp")).toEqual({
      host: "127.0.0.1",
      port: 9999,
    });
    expect(healthUrlForMcpUrl("http://127.0.0.1:9999/mcp")).toBe("http://127.0.0.1:9999/health");
  });

  test("an unusable URL is reported as such rather than silently defaulting", () => {
    // Falling back to the default here is what produced the mismatch: a config
    // aimed at one endpoint and a probe aimed at another.
    expect(parseDaemonEndpoint("not-a-url")).toBeNull();
    expect(parseDaemonEndpoint("")).toBeNull();
    expect(healthUrlForMcpUrl("not-a-url")).toBeNull();
  });

  test("a non-default endpoint is carried into the spawn command", () => {
    const argv = daemonSpawnCommand(["/bin/minsky"], PROJECT, { host: "127.0.0.1", port: 9999 });
    expect(argv).toEqual([
      "/bin/minsky",
      "mcp",
      "start",
      "--http",
      "--local-daemon",
      "--repo",
      PROJECT,
      "--host",
      "127.0.0.1",
      "--port",
      "9999",
    ]);
  });

  test("the default endpoint adds no flags -- the mode already supplies them", () => {
    const withDefault = daemonSpawnCommand(["/bin/minsky"], PROJECT, {
      host: "127.0.0.1",
      port: 48765,
    });
    expect(withDefault).toEqual(daemonSpawnCommand(["/bin/minsky"], PROJECT));
    expect(withDefault).not.toContain("--port");
  });
});

describe("stopLocalDaemon", () => {
  const down: HealthProbeOutcome = { kind: "unreachable", detail: "ECONNREFUSED" };
  const healthy: HealthProbeOutcome = { kind: "body", body: { service: "minsky-mcp" } };
  const record = { port: 48765, host: "127.0.0.1", pid: 4242, startedAt: "2026-08-12T21:00:00Z" };

  test("mt#4297: a still-serving but not-ready daemon is NOT reported as stopped", async () => {
    // This guard was `status.state !== "running"`, so adding `not-ready` to the
    // union silently made a live, still-listening daemon report `stopped: true`
    // — a false success at a call site that never mentions the new state. The
    // check now enumerates the gone-states instead of negating the up-state.
    const unready: HealthProbeOutcome = {
      kind: "body",
      body: { service: "minsky-mcp", ready: false, persistence: { mode: "unconfigured" } },
    };
    const result = await stopLocalDaemon({
      healthUrl: HEALTH_URL,
      attempts: 2,
      deps: {
        readRecord: () => record,
        killIfOurs: async () => true,
        probe: async () => unready,
        sleep: async () => {},
      },
    });
    expect(result.stopped).toBe(false);
    expect(result.detail).toContain("still answering");
  });

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
