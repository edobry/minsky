/**
 * Unit tests for the `minsky setup local-http` decision core (mt#3816).
 *
 * Every filesystem interaction goes through an in-memory ConfigFsDeps, so
 * these exercise the decisions (what is a Minsky entry, which scope it lives
 * in, what the rewrite produces, what a no-op looks like) without a home
 * directory — per this repo's `custom/no-real-fs-in-tests` convention.
 */

import { describe, test, expect } from "bun:test";
import {
  applyRewritesToDocument,
  backupPathFor,
  backupTimestamp,
  canRouteShim,
  classifyForm,
  detectIndent,
  discoverMinskyEntries,
  findLatestBackup,
  isMinskyInvocation,
  isNoOp,
  planMigration,
  renderPlan,
  rewriteToShimArgs,
  type ConfigFsDeps,
  type DiscoveredEntry,
  type PlannedRewrite,
} from "./local-http-config";

const DAEMON_URL = "http://127.0.0.1:48765/mcp";

const HOME = "/home/e";
const PROJECT = "/w/minsky";
const OTHER_PROJECT = "/w/other";
const CLAUDE_JSON = `${HOME}/.claude.json`;
const PROJECT_MCP_JSON = `${PROJECT}/.mcp.json`;
const DEV_CLI_PATH = "/Users/edobry/Projects/minsky/src/cli.ts";
/** The installed bin — the one invocation form that can route `mcp shim`. */
const INSTALLED_MINSKY = "/Users/edobry/.bun/bin/minsky";

/** In-memory ConfigFsDeps over a path→contents map. */
function fakeFs(files: Record<string, string>): ConfigFsDeps {
  const store = { ...files };
  return {
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

/** The operator's real entry shape, read from `.mcp.json` on 2026-08-12. */
const REAL_PROXY_ARGS = [
  "mcp",
  "proxy",
  "--child-args",
  '["mcp","start","--repo","/Users/edobry/Projects/minsky"]',
];

const SHIM_ARGS = ["mcp", "shim", "--url", DAEMON_URL];

describe("isMinskyInvocation", () => {
  test("recognizes the installed binary by basename, absolute or bare", () => {
    expect(isMinskyInvocation(INSTALLED_MINSKY, REAL_PROXY_ARGS)).toBe(true);
    expect(isMinskyInvocation("minsky", REAL_PROXY_ARGS)).toBe(true);
  });

  test("recognizes the from-source dev form via the script path", () => {
    expect(isMinskyInvocation("/Users/edobry/.bun/bin/bun", [DEV_CLI_PATH, "mcp", "start"])).toBe(
      true
    );
  });

  test("does not claim an unrelated server", () => {
    expect(isMinskyInvocation("npx", ["-y", "@notionhq/notion-mcp-server"])).toBe(false);
    expect(isMinskyInvocation("/usr/local/bin/docker", ["run", "postgres-mcp"])).toBe(false);
  });
});

describe("classifyForm", () => {
  test("reads the token after `mcp`, wherever `mcp` sits", () => {
    expect(classifyForm(REAL_PROXY_ARGS)).toBe("proxy");
    expect(classifyForm(SHIM_ARGS)).toBe("shim");
    expect(classifyForm([DEV_CLI_PATH, "mcp", "proxy"])).toBe("proxy");
  });

  test("anything that is not proxy or shim is `other`, including a bare start", () => {
    expect(classifyForm(["mcp", "start", "--repo", PROJECT])).toBe("other");
    expect(classifyForm(["tasks", "list"])).toBe("other");
  });
});

describe("rewriteToShimArgs", () => {
  test("drops the proxy's --child-args payload", () => {
    expect(rewriteToShimArgs(REAL_PROXY_ARGS, DAEMON_URL)).toEqual(SHIM_ARGS);
  });

  test("preserves an interpreter prefix that precedes `mcp`", () => {
    expect(rewriteToShimArgs([DEV_CLI_PATH, "mcp", "proxy"], DAEMON_URL)).toEqual([
      DEV_CLI_PATH,
      ...SHIM_ARGS,
    ]);
  });
});

describe("discoverMinskyEntries", () => {
  function scenario(): ConfigFsDeps {
    return fakeFs({
      [PROJECT_MCP_JSON]: JSON.stringify({
        mcpServers: {
          minsky: { command: INSTALLED_MINSKY, args: REAL_PROXY_ARGS },
          supabase: { command: "npx", args: ["-y", "@supabase/mcp-server"] },
          "minsky-hosted": { url: "https://mcp.example.com/mcp" },
        },
      }),
      [CLAUDE_JSON]: JSON.stringify({
        mcpServers: {
          "minsky-user": { command: "minsky", args: SHIM_ARGS },
        },
        projects: {
          [OTHER_PROJECT]: {
            mcpServers: { minsky: { command: "minsky", args: ["mcp", "proxy"] } },
          },
          "/w/rubato": {
            mcpServers: { notion: { command: "npx", args: ["-y", "notion-mcp"] } },
          },
        },
      }),
    });
  }

  test("finds Minsky entries in all three scopes and ignores unrelated servers", () => {
    const found = discoverMinskyEntries({ projectRoot: PROJECT, home: HOME, deps: scenario() });
    expect(found.map((e) => `${e.scope}:${e.serverName}:${e.form}`).sort()).toEqual([
      "local:minsky:proxy",
      "project:minsky:proxy",
      "user:minsky-user:shim",
    ]);
  });

  test("carries the project path for a local-scope entry, since that is per-project", () => {
    const found = discoverMinskyEntries({ projectRoot: PROJECT, home: HOME, deps: scenario() });
    const local = found.find((e) => e.scope === "local");
    expect(local?.projectPath).toBe(OTHER_PROJECT);
    expect(local?.file).toBe(CLAUDE_JSON);
  });

  test("a remote entry with a url and no command is not mistaken for an invocation", () => {
    const found = discoverMinskyEntries({ projectRoot: PROJECT, home: HOME, deps: scenario() });
    expect(found.some((e) => e.serverName === "minsky-hosted")).toBe(false);
  });

  test("a malformed config yields no entries rather than aborting the scan", () => {
    const deps = fakeFs({
      [PROJECT_MCP_JSON]: "{ this is not json",
      [CLAUDE_JSON]: JSON.stringify({
        mcpServers: { minsky: { command: "minsky", args: ["mcp", "proxy"] } },
      }),
    });
    const found = discoverMinskyEntries({ projectRoot: PROJECT, home: HOME, deps });
    expect(found.map((e) => e.scope)).toEqual(["user"]);
  });

  test("absent config files are simply empty", () => {
    const found = discoverMinskyEntries({ projectRoot: PROJECT, home: HOME, deps: fakeFs({}) });
    expect(found).toEqual([]);
  });
});

describe("planMigration", () => {
  const proxyEntry: DiscoveredEntry = {
    scope: "project",
    file: PROJECT_MCP_JSON,
    serverName: "minsky",
    form: "proxy",
    command: "minsky",
    args: REAL_PROXY_ARGS,
  };
  const shimEntry: DiscoveredEntry = {
    scope: "user",
    file: CLAUDE_JSON,
    serverName: "minsky-user",
    form: "shim",
    command: "minsky",
    args: SHIM_ARGS,
  };
  const rawEntry: DiscoveredEntry = {
    scope: "user",
    file: CLAUDE_JSON,
    serverName: "minsky-raw",
    form: "other",
    command: "minsky",
    args: ["mcp", "start", "--repo", PROJECT],
  };
  const entries = [proxyEntry, shimEntry, rawEntry];

  test("splits entries into rewrite / already-migrated / skipped", () => {
    const plan = planMigration(entries, DAEMON_URL);
    expect(plan.rewrites).toHaveLength(1);
    expect(plan.alreadyMigrated.map((e) => e.serverName)).toEqual(["minsky-user"]);
    expect(plan.skipped.map((e) => e.serverName)).toEqual(["minsky-raw"]);
    expect(plan.filesTouched).toEqual([PROJECT_MCP_JSON]);
    expect(isNoOp(plan)).toBe(false);
  });

  test("a config already fully on the shim is a no-op", () => {
    const plan = planMigration([shimEntry], DAEMON_URL);
    expect(isNoOp(plan)).toBe(true);
    expect(plan.filesTouched).toEqual([]);
  });

  test("the rendered plan shows both sides and names the untouched populations", () => {
    const rendered = renderPlan(planMigration(entries, DAEMON_URL), DAEMON_URL);
    expect(rendered).toContain('"proxy"');
    expect(rendered).toContain('"shim","--url"');
    expect(rendered).toContain("Already on the shim");
    expect(rendered).toContain("left alone");
  });

  test("a no-op plan says so rather than rendering an empty diff", () => {
    expect(renderPlan(planMigration([], DAEMON_URL), DAEMON_URL)).toContain("nothing to migrate");
  });
});

/**
 * `mcp shim` is routed by the `minsky` bin wrapper (`scripts/cli-entry.ts`),
 * not by the CLI — so an entry that invokes Minsky by SCRIPT PATH would migrate
 * to a command that cannot run. These pin the discrimination and the reporting.
 *
 * The three routing verdicts below were measured against the real binaries on
 * 2026-08-16, not assumed:
 *
 *   minsky mcp shim --url …             → runs
 *   bun dist/minsky.js mcp shim --url … → error: unknown command 'shim'
 *   bun src/cli.ts mcp shim --url …     → error: unknown command 'shim'
 */
describe("canRouteShim", () => {
  test("the installed binary routes, by basename, absolute or bare", () => {
    expect(canRouteShim(INSTALLED_MINSKY, ["mcp", "proxy"])).toBe(true);
    expect(canRouteShim("minsky", ["mcp", "proxy"])).toBe(true);
  });

  test("a script-path invocation does NOT route — it bypasses the bin wrapper", () => {
    expect(canRouteShim("bun", [DEV_CLI_PATH, "mcp", "proxy"])).toBe(false);
    expect(canRouteShim("bun", ["/w/minsky/dist/minsky.js", "mcp", "proxy"])).toBe(false);
    expect(canRouteShim("node", ["/w/minsky/dist/minsky.js", "mcp", "proxy"])).toBe(false);
  });

  test("`bunx`/`npx` route, because they resolve the package's bin", () => {
    expect(canRouteShim("bunx", ["minsky", "mcp", "proxy"])).toBe(true);
    expect(canRouteShim("npx", ["minsky", "mcp", "proxy"])).toBe(true);
  });

  test("every entry this predicate rejects is still recognized as Minsky's", () => {
    // The two are deliberately separate questions: `isMinskyInvocation` decides
    // whether we OWN the entry, `canRouteShim` whether we can migrate it. If
    // rejection here also meant non-recognition, the entry would silently
    // vanish from the report instead of appearing as unmigratable.
    const devArgs = [DEV_CLI_PATH, "mcp", "proxy"];
    expect(isMinskyInvocation("bun", devArgs)).toBe(true);
    expect(canRouteShim("bun", devArgs)).toBe(false);
  });
});

describe("planMigration: proxy entries that cannot run the shim", () => {
  const devProxyEntry: DiscoveredEntry = {
    scope: "local",
    file: CLAUDE_JSON,
    projectPath: PROJECT,
    serverName: "minsky-dev",
    form: "proxy",
    command: "bun",
    args: [DEV_CLI_PATH, "mcp", "proxy"],
  };

  test("is reported as unroutable, never rewritten", () => {
    const plan = planMigration([devProxyEntry], DAEMON_URL);
    expect(plan.rewrites).toEqual([]);
    expect(plan.unroutable.map((e) => e.serverName)).toEqual(["minsky-dev"]);
    // The decisive assertion: nothing on disk is touched. Rewriting this entry
    // would replace a working proxy config with one that fails at spawn.
    expect(plan.filesTouched).toEqual([]);
    expect(isNoOp(plan)).toBe(true);
  });

  test("does not divert a routable proxy entry alongside it", () => {
    const routable: DiscoveredEntry = {
      scope: "project",
      file: PROJECT_MCP_JSON,
      serverName: "minsky",
      form: "proxy",
      command: "minsky",
      args: REAL_PROXY_ARGS,
    };
    const plan = planMigration([devProxyEntry, routable], DAEMON_URL);
    expect(plan.rewrites.map((r) => r.entry.serverName)).toEqual(["minsky"]);
    expect(plan.unroutable.map((e) => e.serverName)).toEqual(["minsky-dev"]);
    expect(plan.filesTouched).toEqual([PROJECT_MCP_JSON]);
  });

  test("the report names the entry, the cause, and the remedy", () => {
    const rendered = renderPlan(planMigration([devProxyEntry], DAEMON_URL), DAEMON_URL);
    expect(rendered).toContain("CANNOT be migrated");
    expect(rendered).toContain("minsky-dev");
    expect(rendered).toContain(DEV_CLI_PATH);
    expect(rendered).toContain("bin wrapper");
    expect(rendered).toContain("installed `minsky` binary");
  });

  test("an all-unroutable plan does not claim there was nothing to find", () => {
    // "found none" and "found some, none migratable" are the same empty diff.
    // Reporting the first for the second would tell the operator their config
    // is already clean when it is in fact stuck on the proxy.
    const rendered = renderPlan(planMigration([devProxyEntry], DAEMON_URL), DAEMON_URL);
    expect(rendered).not.toContain("No proxy-form Minsky MCP entries found");
    expect(rendered).toContain("No Minsky MCP entries can be migrated");
  });
});

describe("applyRewritesToDocument", () => {
  test("rewrites args and preserves every sibling key", () => {
    const raw = `${JSON.stringify(
      {
        mcpServers: {
          minsky: {
            type: "stdio",
            command: "/bin/minsky",
            args: REAL_PROXY_ARGS,
            env: { MINSKY_LOG_MODE: "HUMAN" },
          },
        },
      },
      null,
      2
    )}\n`;

    const entry: DiscoveredEntry = {
      scope: "project",
      file: PROJECT_MCP_JSON,
      serverName: "minsky",
      form: "proxy",
      command: "/bin/minsky",
      args: REAL_PROXY_ARGS,
    };
    const rewrite: PlannedRewrite = {
      entry,
      beforeArgs: REAL_PROXY_ARGS,
      afterArgs: rewriteToShimArgs(REAL_PROXY_ARGS, DAEMON_URL),
    };

    const out = applyRewritesToDocument(raw, [rewrite]);
    const server = JSON.parse(out as string).mcpServers.minsky;
    expect(server.args).toEqual(SHIM_ARGS);
    expect(server.type).toBe("stdio");
    expect(server.command).toBe("/bin/minsky");
    expect(server.env).toEqual({ MINSKY_LOG_MODE: "HUMAN" });
  });

  test("reaches a local-scope entry through its project key", () => {
    const raw = `${JSON.stringify(
      {
        projects: {
          [OTHER_PROJECT]: {
            mcpServers: { minsky: { command: "minsky", args: ["mcp", "proxy"] } },
          },
        },
      },
      null,
      2
    )}\n`;

    const entry: DiscoveredEntry = {
      scope: "local",
      file: CLAUDE_JSON,
      serverName: "minsky",
      projectPath: OTHER_PROJECT,
      form: "proxy",
      command: "minsky",
      args: ["mcp", "proxy"],
    };
    const out = applyRewritesToDocument(raw, [
      { entry, beforeArgs: ["mcp", "proxy"], afterArgs: SHIM_ARGS },
    ]);

    expect(JSON.parse(out as string).projects[OTHER_PROJECT].mcpServers.minsky.args).toEqual(
      SHIM_ARGS
    );
  });

  test("returns null on an unparseable document instead of writing a guess", () => {
    expect(applyRewritesToDocument("{ nope", [])).toBeNull();
  });
});

describe("detectIndent: tab-indented documents", () => {
  test("tabs are preserved rather than collapsed to the numeric default", () => {
    // PR #3032 R1 (non-blocking): returning 2 for a tab-indented file made
    // `JSON.stringify` reformat every line -- the whole-file diff this
    // function exists to prevent, produced by the one input it could not
    // express an answer for.
    expect(detectIndent('{\n\t"a": {\n\t\t"b": 1\n\t}\n}')).toBe("\t");
  });

  test("a tab-indented config round-trips without reformatting its untouched lines", () => {
    const raw = `{\n\t"mcpServers": {\n\t\t"minsky": {\n\t\t\t"command": "minsky",\n\t\t\t"args": ["mcp", "proxy"]\n\t\t}\n\t}\n}\n`;
    const entry: DiscoveredEntry = {
      scope: "project",
      file: PROJECT_MCP_JSON,
      serverName: "minsky",
      form: "proxy",
      command: "minsky",
      args: ["mcp", "proxy"],
    };
    const rewrite: PlannedRewrite = {
      entry,
      beforeArgs: entry.args,
      afterArgs: SHIM_ARGS,
    };

    const written = applyRewritesToDocument(raw, [rewrite]);
    if (written === null) throw new Error("expected a rewrite, got no change");

    expect(written).toContain('\t"mcpServers"');
    expect(written).not.toContain('  "mcpServers"');
    expect(JSON.parse(written).mcpServers.minsky.args).toEqual(SHIM_ARGS);
  });
});

describe("detectIndent", () => {
  test("reads the document's own indentation, defaulting to 2", () => {
    expect(detectIndent(JSON.stringify({ a: { b: 1 } }, null, 4))).toBe(4);
    expect(detectIndent(JSON.stringify({ a: { b: 1 } }, null, 2))).toBe(2);
    expect(detectIndent('{"a":1}')).toBe(2);
    // Was asserted as 2 -- that expectation encoded the reformat-the-whole-file
    // defect rather than a decision. Tabs now round-trip as themselves.
    expect(detectIndent(JSON.stringify({ a: { b: 1 } }, null, "\t"))).toBe("\t");
  });
});

describe("backups", () => {
  test("the backup path is derived from the file plus one stamped instant", () => {
    const stamp = backupTimestamp(new Date("2026-08-12T21:51:00.123Z"));
    expect(stamp).toBe("2026-08-12T21-51-00-123Z");
    expect(backupPathFor(PROJECT_MCP_JSON, stamp)).toBe(
      `${PROJECT_MCP_JSON}.minsky-backup-2026-08-12T21-51-00-123Z`
    );
  });

  test("the latest backup wins, and a sibling file's backups are not candidates", () => {
    const deps = fakeFs({
      [PROJECT_MCP_JSON]: "{}",
      [`${PROJECT_MCP_JSON}.minsky-backup-2026-08-12T21-51-00-123Z`]: "older",
      [`${PROJECT_MCP_JSON}.minsky-backup-2026-08-12T22-01-00-000Z`]: "newer",
      [`${PROJECT}/other.json.minsky-backup-2026-08-12T23-00-00-000Z`]: "unrelated",
    });
    expect(findLatestBackup(PROJECT_MCP_JSON, deps)).toBe(
      `${PROJECT_MCP_JSON}.minsky-backup-2026-08-12T22-01-00-000Z`
    );
  });

  test("no backups is null, not a throw", () => {
    expect(findLatestBackup(PROJECT_MCP_JSON, fakeFs({ [PROJECT_MCP_JSON]: "{}" }))).toBeNull();
  });
});
