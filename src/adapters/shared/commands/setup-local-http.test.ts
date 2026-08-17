/**
 * `minsky setup local-http` orchestration tests (mt#3816).
 *
 * These are the acceptance tests 1–4 in unit form: dry-run leaves the file's
 * BYTES untouched, execute rewrites it with a byte-identical backup, a second
 * execute is a no-op, and revert restores the original bytes. The daemon step
 * is skipped here (it is covered in local-http-apply.test.ts); AT4's
 * "no listener" half and AT5's live client run are exercised against real
 * processes in scripts/verify-setup-local-http.ts.
 */

import { describe, test, expect } from "bun:test";
import { runSetupLocalHttp } from "./setup-local-http";
import type { ConfigFsDeps } from "../../../mcp/setup/local-http-config";

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
