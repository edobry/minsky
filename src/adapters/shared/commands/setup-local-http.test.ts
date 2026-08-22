/**
 * `minsky setup local-http` orchestration tests (mt#3816).
 *
 * These are the acceptance tests 1–4 in unit form: dry-run leaves the file's
 * BYTES untouched, execute rewrites it with a byte-identical backup, a second
 * execute is a no-op, and revert restores the original bytes. Those cases skip
 * the daemon step with `skipDaemon: true`; `ensureDaemonRunning` itself is
 * covered in local-http-apply.test.ts, and the ordering between the daemon
 * check and the write is covered by the mt#4337 block at the bottom of THIS
 * file — the `skipDaemon` default above is precisely why nothing here could
 * observe that ordering.
 *
 * mt#4337: this header used to claim AT4's "no listener" half and AT5's live
 * client run were "exercised against real processes in
 * scripts/verify-setup-local-http.ts". That script does not exist and never
 * has — `git log` on the path is empty — so those two halves have NO automated
 * coverage. Tracked as mt#4413; building it is out of mt#4337's scope. Remove
 * this paragraph and point at the script when mt#4413 lands.
 */

import { describe, test, expect } from "bun:test";
import { runSetupLocalHttp } from "./setup-local-http";
import type { ConfigFsDeps } from "../../../mcp/setup/local-http-config";
import type { DaemonProcessDeps } from "../../../mcp/setup/local-http-apply";

const PROJECT = "/w/minsky";
const HOME = "/home/e";
const PROJECT_MCP_JSON = `${PROJECT}/.mcp.json`;
const DAEMON_URL = "http://127.0.0.1:48765/mcp";

/** Idiosyncratic spacing on purpose: a byte assertion must be able to fail. */
const ORIGINAL_BYTES = `{
    "mcpServers": {
        "minsky": {
            "command": "/Users/edobry/.bun/bin/minsky",
            "args": ["mcp", "proxy", "--child-args", "[\\"mcp\\",\\"start\\"]"],
            "type": "stdio"
        },
        "supabase": { "command": "npx", "args": ["-y", "@supabase/mcp-server"] }
    }
}
`;

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

const BASE_DEPS = {
  home: HOME,
  cwd: PROJECT,
  argv: ["/bin/minsky"],
  skipDaemon: true,
  now: new Date("2026-08-12T21:51:00.123Z"),
};

function scenario(): ReturnType<typeof fakeFs> {
  return fakeFs({ [PROJECT_MCP_JSON]: ORIGINAL_BYTES });
}

describe("runSetupLocalHttp — migrate", () => {
  test("AT1: without --execute the file's bytes are unchanged and a diff is printed", async () => {
    const fs = scenario();
    const result = await runSetupLocalHttp({}, { ...BASE_DEPS, fs });

    expect(fs.read(PROJECT_MCP_JSON)).toBe(ORIGINAL_BYTES);
    expect(fs.paths()).toEqual([PROJECT_MCP_JSON]);
    expect(result.changed).toBe(false);
    expect(result.planText).toContain('"proxy"');
    expect(result.planText).toContain(DAEMON_URL);
    expect(result.message).toContain("--execute");
  });

  test("AT2: --execute rewrites the entry and the backup matches the original bytes", async () => {
    const fs = scenario();
    const result = await runSetupLocalHttp({ execute: true }, { ...BASE_DEPS, fs });

    expect(result.changed).toBe(true);
    const backup = fs
      .paths()
      .find((p) => p.startsWith(`${PROJECT_MCP_JSON}.minsky-backup-`)) as string;
    expect(fs.read(backup)).toBe(ORIGINAL_BYTES);

    const written = JSON.parse(fs.read(PROJECT_MCP_JSON) as string);
    expect(written.mcpServers.minsky.args).toEqual(["mcp", "shim", "--url", DAEMON_URL]);
    expect(written.mcpServers.minsky.type).toBe("stdio");
    expect(written.mcpServers.supabase.args).toEqual(["-y", "@supabase/mcp-server"]);
  });

  test("AT3: a second --execute is a no-op and leaves the bytes untouched", async () => {
    const fs = scenario();
    await runSetupLocalHttp({ execute: true }, { ...BASE_DEPS, fs });
    const afterFirst = fs.read(PROJECT_MCP_JSON) as string;
    const pathsAfterFirst = fs.paths().sort();

    const second = await runSetupLocalHttp({ execute: true }, { ...BASE_DEPS, fs });

    expect(second.changed).toBe(false);
    expect(second.message).toContain("Already migrated");
    expect(fs.read(PROJECT_MCP_JSON)).toBe(afterFirst);
    expect(fs.paths().sort()).toEqual(pathsAfterFirst);
  });

  test("a config with no Minsky entry at all is reported as such, not as success-by-silence", async () => {
    const fs = fakeFs({
      [PROJECT_MCP_JSON]: JSON.stringify({ mcpServers: { supabase: { command: "npx" } } }),
    });
    const result = await runSetupLocalHttp({ execute: true }, { ...BASE_DEPS, fs });

    expect(result.changed).toBe(false);
    expect(result.message).toContain("No Minsky MCP entries found");
  });

  test("an entry that cannot run the shim is left alone, and NOT called migrated", async () => {
    // A `bun <path>/src/cli.ts` entry bypasses the `minsky` bin wrapper, which
    // is what routes `mcp shim` (mt#3812) — rewriting it would swap a working
    // proxy config for one that fails at spawn. The wrong report here is the
    // subtle half: writing nothing is correct, but calling it "already
    // migrated" tells the operator the job is done while they are still on
    // the proxy.
    const fs = fakeFs({
      [PROJECT_MCP_JSON]: JSON.stringify({
        mcpServers: {
          minsky: { command: "bun", args: [`${PROJECT}/src/cli.ts`, "mcp", "proxy"] },
        },
      }),
    });
    const before = fs.read(PROJECT_MCP_JSON) as string;

    const result = await runSetupLocalHttp({ execute: true }, { ...BASE_DEPS, fs });

    expect(result.changed).toBe(false);
    expect(fs.read(PROJECT_MCP_JSON)).toBe(before);
    expect(result.message).not.toContain("Already migrated");
    expect(result.message).toContain("cannot be migrated");
    expect(result.planText).toContain("CANNOT be migrated");
  });

  test("a custom --url also decides where the daemon is probed and spawned", async () => {
    // PR #3032 R1 BLOCKING: --url reached only the rewritten config. The
    // ensure-running step still probed 48765 and spawned without a port, so
    // `--url ...:9999` produced a config aimed at a daemon that was never
    // started there.
    const fs = scenario();
    const probed: string[] = [];
    const spawnedArgv: string[][] = [];

    await runSetupLocalHttp(
      { execute: true, url: "http://127.0.0.1:9999/mcp" },
      {
        ...BASE_DEPS,
        fs,
        daemon: {
          probe: async (url: string) => {
            probed.push(url);
            return { kind: "body", body: { service: "minsky-mcp" } };
          },
          spawnDetached: (argv: string[]) => {
            spawnedArgv.push(argv);
          },
          sleep: async () => {},
        },
      }
    );

    expect(probed.every((u) => u === "http://127.0.0.1:9999/health")).toBe(true);
    expect(probed).not.toContain("http://127.0.0.1:48765/health");
  });

  test("an unusable --url fails before anything is written", async () => {
    const fs = scenario();
    const before = fs.read(PROJECT_MCP_JSON) as string;

    await expect(
      runSetupLocalHttp({ execute: true, url: "not-a-url" }, { ...BASE_DEPS, fs })
    ).rejects.toThrow("--url");

    expect(fs.read(PROJECT_MCP_JSON)).toBe(before);
  });

  test("a custom --url is what lands in the rewritten entry", async () => {
    const fs = scenario();
    await runSetupLocalHttp(
      { execute: true, url: "http://127.0.0.1:9999/mcp" },
      { ...BASE_DEPS, fs }
    );
    expect(JSON.parse(fs.read(PROJECT_MCP_JSON) as string).mcpServers.minsky.args).toEqual([
      "mcp",
      "shim",
      "--url",
      "http://127.0.0.1:9999/mcp",
    ]);
  });
});

describe("runSetupLocalHttp — revert", () => {
  test("AT4: --revert restores the pre-migration bytes exactly", async () => {
    const fs = scenario();
    await runSetupLocalHttp({ execute: true }, { ...BASE_DEPS, fs });
    expect(fs.read(PROJECT_MCP_JSON)).not.toBe(ORIGINAL_BYTES);

    const result = await runSetupLocalHttp({ revert: true, execute: true }, { ...BASE_DEPS, fs });

    expect(result.changed).toBe(true);
    expect(fs.read(PROJECT_MCP_JSON)).toBe(ORIGINAL_BYTES);
  });

  test("--revert is also dry-run by default", async () => {
    const fs = scenario();
    await runSetupLocalHttp({ execute: true }, { ...BASE_DEPS, fs });
    const migrated = fs.read(PROJECT_MCP_JSON) as string;

    const preview = await runSetupLocalHttp({ revert: true }, { ...BASE_DEPS, fs });

    expect(preview.changed).toBe(false);
    expect(preview.planText).toContain("Would restore");
    expect(fs.read(PROJECT_MCP_JSON)).toBe(migrated);
  });

  test("reverting with no backup present changes nothing and says so", async () => {
    const fs = scenario();
    const result = await runSetupLocalHttp({ revert: true, execute: true }, { ...BASE_DEPS, fs });

    expect(result.changed).toBe(false);
    expect(result.message).toContain("nothing to revert");
    expect(fs.read(PROJECT_MCP_JSON)).toBe(ORIGINAL_BYTES);
  });
});

/**
 * mt#4337 acceptance tests. `--execute` used to call `applyPlan` BEFORE
 * `ensureDaemonRunning`, so a refusal left the operator migrated onto the very
 * daemon it had just refused — while the refusal said "Nothing has been
 * written."
 *
 * These assert on the FILE, not on the message. That is the whole point: the
 * refusal text was already correct-looking throughout the defect's life, and
 * the only existing coverage of this path (`local-http-apply.test.ts`)
 * exercises `ensureDaemonRunning` in isolation, where no config exists to
 * observe. Both passed while the bug shipped.
 *
 * The suite above cannot catch it either — every `--execute` case there sets
 * `skipDaemon: true`, which returns before the daemon step is reached.
 */
describe("runSetupLocalHttp — a refused daemon leaves the config untouched (mt#4337)", () => {
  /** A refusal must leave the tree as found: no rewrite, and no backup beside it. */
  function expectNothingWritten(fs: ReturnType<typeof scenario>): void {
    expect(fs.read(PROJECT_MCP_JSON)).toBe(ORIGINAL_BYTES);
    expect(fs.paths()).toEqual([PROJECT_MCP_JSON]);
  }

  const refuseToSpawn = (): void => {
    throw new Error("spawnDetached called on a daemon that must be refused, not spawned");
  };

  const answering = (body: unknown) => ({
    probe: async () => ({ kind: "body" as const, body }),
    spawnDetached: refuseToSpawn,
    sleep: async () => {},
  });

  const NOT_READY = answering({ service: "minsky-mcp", ready: false });
  const READY = answering({ service: "minsky-mcp", ready: true });
  const FOREIGN = {
    probe: async () => ({ kind: "http-error" as const, status: 404 }),
    spawnDetached: refuseToSpawn,
    sleep: async () => {},
  };
  /** Spawning IS expected here — the daemon just never comes up. */
  const NEVER_HEALTHY = {
    probe: async () => ({ kind: "unreachable" as const, detail: "ECONNREFUSED" }),
    spawnDetached: () => {},
    sleep: async () => {},
  };

  function withDaemon(
    daemon: DaemonProcessDeps
  ): Omit<typeof BASE_DEPS, "skipDaemon"> & { daemon: DaemonProcessDeps } {
    const { skipDaemon: _skipDaemon, ...rest } = BASE_DEPS;
    return { ...rest, daemon };
  }

  test("AT1: a not-ready daemon is refused and the config keeps its exact bytes", async () => {
    const fs = scenario();

    await expect(
      runSetupLocalHttp({ execute: true }, { ...withDaemon(NOT_READY), fs })
    ).rejects.toThrow(/cannot reach the database/);

    expectNothingWritten(fs);
  });

  test('AT2: the refusal\'s "Nothing has been written" is true when it is emitted', async () => {
    const fs = scenario();

    const refusal = await runSetupLocalHttp(
      { execute: true },
      { ...withDaemon(NOT_READY), fs }
    ).then(
      () => undefined,
      (error: Error) => error
    );

    expect(refusal?.message).toContain("Nothing has been written.");
    // Claim and tree asserted together, deliberately: pre-fix the message read
    // exactly like this while the entry had already been rewritten.
    expectNothingWritten(fs);
  });

  test("a foreign holder is refused on the same terms — same class, same guarantee", async () => {
    const fs = scenario();

    await expect(
      runSetupLocalHttp({ execute: true }, { ...withDaemon(FOREIGN), fs })
    ).rejects.toThrow(/Nothing has been written/);

    expectNothingWritten(fs);
  });

  test("a daemon we spawned that never becomes healthy also writes nothing", async () => {
    const fs = scenario();

    await expect(
      runSetupLocalHttp({ execute: true }, { ...withDaemon(NEVER_HEALTHY), fs })
    ).rejects.toThrow(/never became healthy/);

    // This path previously told the operator the opposite — "The config has
    // been migrated; run `minsky setup local-http --revert` to undo it."
    expectNothingWritten(fs);
  });

  test("AT3: a ready daemon still migrates and still writes a backup", async () => {
    const fs = scenario();

    const result = await runSetupLocalHttp({ execute: true }, { ...withDaemon(READY), fs });

    expect(result.changed).toBe(true);
    expect(fs.read(PROJECT_MCP_JSON)).not.toBe(ORIGINAL_BYTES);
    const backup = fs.paths().find((p) => p.startsWith(`${PROJECT_MCP_JSON}.minsky-backup-`));
    expect(backup).toBeDefined();
    expect(fs.read(backup as string)).toBe(ORIGINAL_BYTES);
  });

  test("AT4: --revert --execute restores the bytes whatever the daemon reports", async () => {
    for (const daemon of [NOT_READY, FOREIGN, READY]) {
      const fs = scenario();
      await runSetupLocalHttp({ execute: true }, { ...BASE_DEPS, fs });
      expect(fs.read(PROJECT_MCP_JSON)).not.toBe(ORIGINAL_BYTES);

      const result = await runSetupLocalHttp(
        { revert: true, execute: true },
        // `readRecord` stubbed to null so the stop step reports "nothing to
        // stop" instead of reading this machine's real discovery file.
        { ...withDaemon({ ...daemon, readRecord: () => null }), fs }
      );

      expect(result.changed).toBe(true);
      expect(fs.read(PROJECT_MCP_JSON)).toBe(ORIGINAL_BYTES);
    }
  });
});
