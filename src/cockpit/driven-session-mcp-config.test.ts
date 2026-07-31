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
  resolveMinskyInvocation,
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
