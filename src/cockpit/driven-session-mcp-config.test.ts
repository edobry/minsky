/**
 * Tests for the driven-session MCP config synthesizer (mt#3377).
 *
 * The failure this guards against is silent: a driven session that boots with
 * no MCP servers still WORKS — it just degrades to shelling out to the CLI,
 * bypassing the guard and hook wiring the MCP tools carry. Nothing crashes, so
 * only an explicit assertion catches a regression.
 */
import { describe, test, expect } from "bun:test";
import {
  DRIVEN_SESSION_MCP_SERVER_NAME,
  buildDrivenSessionMcpConfig,
  mcpConfigArgs,
  redactMcpConfigForLog,
  resolveDrivenSessionMcpConfig,
  resolveMinskyInvocation,
  selectInheritableServers,
} from "./driven-session-mcp-config";

const WORKSPACE = "/Users/example/.local/state/minsky/sessions/abc-123";
const MINSKY_BIN = "/Users/example/.bun/bin/minsky";
const BUN_BIN = "/opt/homebrew/bin/bun";
const CLI_ENTRY = "/repo/src/cli.ts";
const EMPTY_SERVER_CONFIG = '{"mcpServers":{}}';

describe("resolveMinskyInvocation", () => {
  test("uses the running executable when it IS the minsky binary", () => {
    const invocation = resolveMinskyInvocation([MINSKY_BIN, "cockpit"]);

    expect(invocation.command).toBe(MINSKY_BIN);
    expect(invocation.prefixArgs).toEqual([]);
  });

  test("re-invokes the runtime with the entry script when running from source", () => {
    const invocation = resolveMinskyInvocation([BUN_BIN, CLI_ENTRY, "cockpit", "start"]);

    expect(invocation.command).toBe(BUN_BIN);
    expect(invocation.prefixArgs).toEqual([CLI_ENTRY]);
  });

  test("falls back to PATH resolution for an unrecognized host shape", () => {
    // The only branch that can fail on a minimal PATH. It exists so an
    // unfamiliar host degrades to the pre-mt#3377 behavior rather than
    // throwing at spawn time.
    const invocation = resolveMinskyInvocation(["/usr/bin/node", "/tmp/thing.mjs"]);

    expect(invocation.command).toBe("minsky");
    expect(invocation.prefixArgs).toEqual([]);
  });

  test("falls back rather than throwing on an empty argv", () => {
    expect(resolveMinskyInvocation([])).toEqual({ command: "minsky", prefixArgs: [] });
  });

  test("resolves an absolute command in both recognized shapes", () => {
    // The point of resolving at all: a tray-launched daemon frequently has a
    // minimal PATH with no ~/.bun/bin, so a bare "minsky" would ENOENT.
    for (const invocation of [
      resolveMinskyInvocation([MINSKY_BIN]),
      resolveMinskyInvocation([BUN_BIN, CLI_ENTRY]),
    ]) {
      expect(invocation.command.startsWith("/")).toBe(true);
    }
  });
});

describe("buildDrivenSessionMcpConfig", () => {
  test("declares exactly one server, named minsky", () => {
    const parsed = JSON.parse(
      buildDrivenSessionMcpConfig(WORKSPACE, { command: "/bin/minsky", prefixArgs: [] })
    );

    expect(Object.keys(parsed.mcpServers)).toEqual([DRIVEN_SESSION_MCP_SERVER_NAME]);
  });

  test("points the server's --repo at the driven session's own workspace", () => {
    const parsed = JSON.parse(
      buildDrivenSessionMcpConfig(WORKSPACE, { command: "/bin/minsky", prefixArgs: [] })
    );

    expect(parsed.mcpServers.minsky.command).toBe("/bin/minsky");
    expect(parsed.mcpServers.minsky.args).toEqual(["mcp", "start", "--repo", WORKSPACE]);
  });

  test("threads prefix args ahead of the subcommand when running from source", () => {
    const parsed = JSON.parse(
      buildDrivenSessionMcpConfig(WORKSPACE, {
        command: BUN_BIN,
        prefixArgs: [CLI_ENTRY],
      })
    );

    // Order matters: the script path must precede `mcp start`, or bun would
    // treat "mcp" as the script to run.
    expect(parsed.mcpServers.minsky.args).toEqual([CLI_ENTRY, "mcp", "start", "--repo", WORKSPACE]);
  });

  test("emits a single-line JSON string safe to pass as one argv element", () => {
    const config = buildDrivenSessionMcpConfig(WORKSPACE, {
      command: "/bin/minsky",
      prefixArgs: [],
    });

    expect(config).not.toContain("\n");
    expect(() => JSON.parse(config)).not.toThrow();
  });
});

describe("mcpConfigArgs", () => {
  test("pairs the config with --strict-mcp-config", () => {
    expect(mcpConfigArgs(EMPTY_SERVER_CONFIG)).toEqual([
      "--mcp-config",
      EMPTY_SERVER_CONFIG,
      "--strict-mcp-config",
    ]);
  });

  test("emits nothing for null or undefined", () => {
    expect(mcpConfigArgs(null)).toEqual([]);
    expect(mcpConfigArgs(undefined)).toEqual([]);
  });

  test("emits nothing for an empty string rather than a dangling flag", () => {
    // A bare `--mcp-config` with no value would make the child fail to start.
    expect(mcpConfigArgs("")).toEqual([]);
  });
});

describe("redactMcpConfigForLog", () => {
  const config = buildDrivenSessionMcpConfig(WORKSPACE, {
    command: MINSKY_BIN,
    prefixArgs: [],
  });

  test("collapses the payload to its server names", () => {
    const line = redactMcpConfigForLog(["-p", ...mcpConfigArgs(config)]);

    // The spawn log fires on every start and resume; the raw JSON carries
    // absolute local paths and no diagnostic value.
    expect(line).not.toContain(WORKSPACE);
    expect(line).not.toContain("mcpServers");
    expect(line).toContain("<config: minsky>");
  });

  test("keeps flag presence and the surrounding argv intact", () => {
    // Flag presence is exactly what a reader checks when a driven session has
    // no tools, so redaction must not remove it.
    const line = redactMcpConfigForLog(["-p", ...mcpConfigArgs(config), "--verbose"]);

    expect(line).toBe("-p --mcp-config <config: minsky> --strict-mcp-config --verbose");
  });

  test("leaves argv without the flag untouched", () => {
    expect(redactMcpConfigForLog(["-p", "--verbose"])).toBe("-p --verbose");
  });

  test("does not echo a malformed payload", () => {
    const line = redactMcpConfigForLog(["--mcp-config", "{not json", "--strict-mcp-config"]);

    expect(line).not.toContain("{not json");
    expect(line).toContain("<config: unparseable>");
  });

  test("reports an empty server map distinctly", () => {
    expect(redactMcpConfigForLog(["--mcp-config", EMPTY_SERVER_CONFIG])).toBe(
      "--mcp-config <config: none>"
    );
  });

  test("does not drop a trailing flag that has no value", () => {
    expect(redactMcpConfigForLog(["-p", "--mcp-config"])).toBe("-p --mcp-config");
  });
});

// ---------------------------------------------------------------------------
// Inheriting the operator's other servers (mt#4239)
// ---------------------------------------------------------------------------

/**
 * These touch no filesystem at all. `resolveDrivenSessionMcpConfig` takes its
 * reader as a parameter, so the fs is an injectable edge rather than something
 * to patch or a temp directory to race on — per `testing-standards.mdc
 * §Testable Design`, a seam beats a spy, and `custom/no-real-fs-in-tests`
 * enforces it. The thin `readOperatorMcpServers` wrapper around `readFileSync`
 * is exercised by the production default path and by
 * `scripts/verify-driven-session-mcp-config.ts`.
 */
describe("selectInheritableServers", () => {
  const GITHUB = { command: "docker", args: ["run", "ghcr.io/github/github-mcp-server"] };
  const SUPABASE = { command: "npx", args: ["-y", "@supabase/mcp-server-supabase"] };
  const NOTION_REMOTE = { type: "http", url: "https://mcp.notion.com/mcp" };

  const AVAILABLE = { github: GITHUB, supabase: SUPABASE, notion: NOTION_REMOTE };

  test("copies a local command server verbatim", () => {
    const { servers, rejected } = selectInheritableServers(["github"], AVAILABLE);

    // Verbatim matters: the entry carries the operator's own credential path,
    // and re-deriving any part of it here would silently drift from `.mcp.json`.
    expect(servers).toEqual({ github: GITHUB });
    expect(rejected).toEqual([]);
  });

  test("skips `minsky` silently — it is synthesized, not inherited", () => {
    const { servers, rejected } = selectInheritableServers(["minsky", "github"], AVAILABLE);

    expect(Object.keys(servers)).toEqual(["github"]);
    // Silently: naming `minsky` in config is correct and idiomatic, so warning
    // about it would train the operator to ignore this channel.
    expect(rejected).toEqual([]);
  });

  test("REFUSES a remote server, with a reason naming the auth cause", () => {
    // The regression guard for mt#4239's falsified premise. Verified live
    // against claude 2.1.226: a --strict-mcp-config payload carrying this exact
    // entry answers "requires authentication, which can't be completed in this
    // non-interactive session". Emitting it would cost up to MCP_TIMEOUT (30s)
    // of first-turn latency per spawn AND still deliver no tools.
    const { servers, rejected } = selectInheritableServers(["notion"], AVAILABLE);

    expect(servers).toEqual({});
    expect(rejected).toHaveLength(1);
    expect(rejected.map((r) => r.name)).toEqual(["notion"]);
    expect(rejected.map((r) => r.reason).join(" ")).toContain("OAuth");
  });

  test("reports a name that is not declared at all", () => {
    const { servers, rejected } = selectInheritableServers(["does-not-exist"], AVAILABLE);

    expect(servers).toEqual({});
    expect(rejected).toEqual([
      { name: "does-not-exist", reason: "not declared in the operator's .mcp.json" },
    ]);
  });

  test("refuses a malformed entry rather than passing it through", () => {
    // `command` present but empty, and a non-object entry. Both are refused by
    // the same positive test, which is why an unrecognized shape fails CLOSED.
    const { servers, rejected } = selectInheritableServers(["a", "b"], {
      a: { command: "" },
      b: "not-an-object",
    });

    expect(servers).toEqual({});
    expect(rejected.map((r) => r.name)).toEqual(["a", "b"]);
  });
});

describe("resolveDrivenSessionMcpConfig", () => {
  const INVOCATION = { command: MINSKY_BIN, prefixArgs: [] as string[] };

  const OPERATOR_SERVERS = {
    minsky: { command: "/stale/minsky", args: ["mcp", "start"] },
    github: { command: "docker", args: ["run", "github-mcp"] },
    supabase: { command: "npx", args: ["-y", "supabase-mcp"] },
    notion: { type: "http", url: "https://mcp.notion.com/mcp" },
  };

  /**
   * A reader standing in for the operator's `.mcp.json`.
   *
   * Injected rather than written to a temp directory: `custom/no-real-fs-in-tests`
   * forbids real filesystem access here, and the reason applies directly — a
   * shared temp path races between concurrently-running test files.
   */
  const OPERATOR_READER = () => ({ servers: OPERATOR_SERVERS, error: null });

  function serversIn(config: string): string[] {
    return Object.keys((JSON.parse(config) as { mcpServers: Record<string, unknown> }).mcpServers);
  }

  test("AT1 — the default set is exactly minsky + github, with the repo path", () => {
    const resolution = resolveDrivenSessionMcpConfig(WORKSPACE, {
      readServers: OPERATOR_READER,
      invocation: INVOCATION,
    });

    expect(serversIn(resolution.config).sort()).toEqual(["github", "minsky"]);
    const parsed = JSON.parse(resolution.config) as {
      mcpServers: { minsky: { args: string[] } };
    };
    expect(parsed.mcpServers.minsky.args).toContain(WORKSPACE);
    expect(resolution.sourceError).toBeNull();
  });

  test("AT2 — an explicit list is honored, and minsky is re-added when omitted", () => {
    const withSupabase = resolveDrivenSessionMcpConfig(WORKSPACE, {
      readServers: OPERATOR_READER,
      invocation: INVOCATION,
      names: ["minsky", "supabase"],
    });
    expect(serversIn(withSupabase.config).sort()).toEqual(["minsky", "supabase"]);

    const withoutMinsky = resolveDrivenSessionMcpConfig(WORKSPACE, {
      readServers: OPERATOR_READER,
      invocation: INVOCATION,
      names: ["github"],
    });
    expect(serversIn(withoutMinsky.config).sort()).toEqual(["github", "minsky"]);
  });

  test("AT3 — an unresolvable name is omitted and reported, and the spawn still works", () => {
    const resolution = resolveDrivenSessionMcpConfig(WORKSPACE, {
      readServers: OPERATOR_READER,
      invocation: INVOCATION,
      names: ["minsky", "does-not-exist"],
    });

    expect(serversIn(resolution.config)).toEqual(["minsky"]);
    expect(resolution.rejected.map((r) => r.name)).toEqual(["does-not-exist"]);
  });

  test("AT4 — a remote entry is refused rather than shipped into the payload", () => {
    const resolution = resolveDrivenSessionMcpConfig(WORKSPACE, {
      readServers: OPERATOR_READER,
      invocation: INVOCATION,
      names: ["minsky", "notion"],
    });

    expect(serversIn(resolution.config)).toEqual(["minsky"]);
    expect(resolution.rejected.map((r) => r.name)).toEqual(["notion"]);
  });

  test("an inherited `minsky` entry can never shadow the synthesized one", () => {
    // The fixture's `minsky` points at /stale/minsky with no --repo. If
    // inheritance won, the driven session would talk to the wrong build against
    // the wrong repo — the two facts no file on disk can know.
    const resolution = resolveDrivenSessionMcpConfig(WORKSPACE, {
      readServers: OPERATOR_READER,
      invocation: INVOCATION,
      names: ["minsky"],
    });

    const parsed = JSON.parse(resolution.config) as {
      mcpServers: { minsky: { command: string; args: string[] } };
    };
    expect(parsed.mcpServers.minsky.command).toBe(MINSKY_BIN);
    expect(parsed.mcpServers.minsky.args).toEqual(["mcp", "start", "--repo", WORKSPACE]);
  });

  test("an unreadable source degrades to minsky-only, still spawnable, and says why", () => {
    // Degrading must never fail the spawn: a driven session with one server is
    // usable, and one that will not start is not. So the payload still carries
    // `minsky` and the reason travels beside it rather than as an exception.
    const resolution = resolveDrivenSessionMcpConfig(WORKSPACE, {
      invocation: INVOCATION,
      readServers: (path) => ({ servers: {}, error: `could not read ${path}: ENOENT` }),
    });

    expect(serversIn(resolution.config)).toEqual(["minsky"]);
    expect(resolution.sourceError).toContain("could not read");
    // The default set still asked for github, so its absence is reported too —
    // the operator sees BOTH why the source failed and what they lost by it.
    expect(resolution.rejected.map((r) => r.name)).toEqual(["github"]);
  });

  test("the spawn log leaks no credential from an inherited entry", () => {
    // Load-bearing as of mt#4239, and newly so: before it, the payload held one
    // entry this code wrote itself. It now carries entries copied VERBATIM out
    // of the operator's `.mcp.json`, which is exactly where credentials live —
    // so the redaction that was merely tidy is now the thing standing between a
    // token and a log line that is persisted AND ingested.
    // Not a real credential — a synthetic marker whose only job is to be
    // searched for in the rendered log line.
    const FAKE_TOKEN = "ghp_NOT_A_REAL_TOKEN_FIXTURE";

    const resolution = resolveDrivenSessionMcpConfig(WORKSPACE, {
      invocation: INVOCATION,
      names: ["github"],
      readServers: () => ({
        servers: {
          github: {
            command: "docker",
            args: ["run", "ghcr.io/github/github-mcp-server"],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: FAKE_TOKEN },
          },
        },
        error: null,
      }),
    });

    const line = redactMcpConfigForLog(["-p", ...mcpConfigArgs(resolution.config)]);

    expect(line).toBe("-p --mcp-config <config: github,minsky> --strict-mcp-config");
    expect(line).not.toContain(FAKE_TOKEN);
    expect(line).not.toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
    // Control: the secret really IS in the payload being redacted, so the
    // assertions above are about the redaction and not about an empty config.
    expect(resolution.config).toContain(FAKE_TOKEN);
  });

  test("the source path handed to the reader is the daemon's, not the session's", () => {
    // The distinction this pins is load-bearing: `.mcp.json` is gitignored, so a
    // session-workspace clone never has one. Reading the session's `repoPath`
    // would resolve nothing and silently restore the pre-mt#4239 behavior.
    const seen: string[] = [];

    resolveDrivenSessionMcpConfig(WORKSPACE, {
      sourceDir: "/daemon/checkout",
      invocation: INVOCATION,
      readServers: (path) => {
        seen.push(path);
        return { servers: OPERATOR_SERVERS, error: null };
      },
    });

    expect(seen).toEqual(["/daemon/checkout/.mcp.json"]);
    expect(seen[0]).not.toContain(WORKSPACE);
  });
});
