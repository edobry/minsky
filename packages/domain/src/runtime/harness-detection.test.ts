/**
 * Tests for agent harness detection and installed client detection.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as path from "path";
import {
  detectAgentHarness,
  hasNativeSubagentSupport,
  detectInstalledClients,
  resolveInitClient,
  clientFromAgentId,
  resolveAgentHarness,
  describeUnresolvedClient,
  MANAGED_CLIENTS,
  HARNESS_SOURCES,
  isManagedClient,
} from "./harness-detection";
import { workspaceConfigSchema } from "../configuration/schemas/workspace";

const CLAUDE_AND_CURSOR_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PROJECT_DIR",
  "CURSOR_SESSION_ID",
  "CURSOR_TRACE_ID",
  "VSCODE_PID",
];

function withCleanEnv(envVars: string[]) {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const v of envVars) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of envVars) {
      if (savedEnv[v] === undefined) {
        delete process.env[v];
      } else {
        process.env[v] = savedEnv[v];
      }
    }
  });
}

/**
 * Run `fn` with the harness env vars cleared and `overrides` applied, then
 * restore every one of them — the per-test form of `withCleanEnv` for the
 * `resolveAgentHarness` block, whose cases each need a different environment.
 */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const v of CLAUDE_AND_CURSOR_ENV_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const v of CLAUDE_AND_CURSOR_ENV_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  }
}

describe("detectAgentHarness", () => {
  withCleanEnv(CLAUDE_AND_CURSOR_ENV_VARS);

  // CLAUDECODE=1 (no underscore) is the canonical Claude Code 2.1.x env var.
  test("returns 'claude-code' when CLAUDECODE is set", () => {
    process.env.CLAUDECODE = "1";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'claude-code' when CLAUDE_CODE_ENTRYPOINT is set", () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'claude-code' when CLAUDE_CODE_SESSION_ID is set", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "abc-123";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'claude-code' when CLAUDE_CODE_SUBAGENT_MODEL is set", () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = "sonnet";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'claude-code' when CLAUDE_CODE_EXECPATH is set", () => {
    process.env.CLAUDE_CODE_EXECPATH = "/Users/me/.local/share/claude/versions/2.1.136";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'claude-code' when CLAUDE_PROJECT_DIR is set", () => {
    process.env.CLAUDE_PROJECT_DIR = "/some/project";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'claude-code' when legacy CLAUDE_CODE is set", () => {
    process.env.CLAUDE_CODE = "1";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  test("returns 'cursor' when CURSOR_SESSION_ID is set", () => {
    process.env.CURSOR_SESSION_ID = "abc123";
    expect(detectAgentHarness()).toBe("cursor");
  });

  test("returns 'cursor' when VSCODE_PID is set", () => {
    process.env.VSCODE_PID = "1234";
    expect(detectAgentHarness()).toBe("cursor");
  });

  test("returns 'standalone' when no relevant env vars are set", () => {
    expect(detectAgentHarness()).toBe("standalone");
  });

  // mt#2712 R1: this case was covered by the now-deleted stale duplicate
  // (tests/domain/runtime/harness-detection.test.ts's "claude-code takes
  // priority over cursor") but had no equivalent here -- the canonical
  // suite was not a strict superset. Re-added so the priority behavior
  // stays covered.
  test("claude-code takes priority over cursor when both are set", () => {
    process.env.CLAUDECODE = "1";
    process.env.VSCODE_PID = "1234";
    expect(detectAgentHarness()).toBe("claude-code");
  });
});

describe("hasNativeSubagentSupport", () => {
  withCleanEnv(CLAUDE_AND_CURSOR_ENV_VARS);

  test("returns true when running in claude-code (CLAUDECODE)", () => {
    process.env.CLAUDECODE = "1";
    expect(hasNativeSubagentSupport()).toBe(true);
  });

  // mt#2712 R1: this case was covered by the now-deleted stale duplicate
  // (tests/domain/runtime/harness-detection.test.ts's "returns false for
  // cursor (not yet supported)") but had no equivalent here -- the
  // canonical suite was not a strict superset. Re-added so cursor's
  // no-native-subagent-support behavior stays covered.
  test("returns false for cursor (not yet supported)", () => {
    process.env.CURSOR_SESSION_ID = "abc123";
    expect(hasNativeSubagentSupport()).toBe(false);
  });

  test("returns false in standalone mode", () => {
    expect(hasNativeSubagentSupport()).toBe(false);
  });
});

describe("detectInstalledClients", () => {
  test("returns an array", () => {
    const clients = detectInstalledClients();
    expect(Array.isArray(clients)).toBe(true);
  });

  test("returns stable results on repeated calls", () => {
    // detectInstalledClients probes the real filesystem; verify it is deterministic.
    // Both outcomes (cursor present or absent) are valid depending on the machine.
    const clients1 = detectInstalledClients();
    const clients2 = detectInstalledClients();
    expect(clients1).toEqual(clients2);
  });

  test("returned values are all ManagedClient members", () => {
    const validClients = new Set([
      "cursor",
      "claude-desktop",
      "claude-code",
      "vscode",
      "windsurf",
      "junie",
      "codex",
      "openhands",
    ]);
    const clients = detectInstalledClients();
    for (const c of clients) {
      expect(validClients.has(c)).toBe(true);
    }
  });

  describe("claude-code detection (mt#4676)", () => {
    test("reports claude-code when ~/.claude/ exists", () => {
      const clients = detectInstalledClients({
        pathExists: (p) => p.endsWith(`${path.sep}.claude`),
      });
      expect(clients).toContain("claude-code");
    });

    test("does not report claude-code when ~/.claude/ is absent", () => {
      const clients = detectInstalledClients({ pathExists: () => false });
      expect(clients).not.toContain("claude-code");
    });

    test("ambiguous case: reports both claude-code and cursor when both directories exist", () => {
      // mt#4676's originating repro: CLAUDECODE=1 live, ~/.cursor/ ALSO present
      // (from a prior editor install). detectInstalledClients() itself makes no
      // ordering claim between the two -- resolveInitClient() is what decides
      // which one wins for `init`, and that decision is tested separately below.
      const clients = detectInstalledClients({ pathExists: () => true });
      expect(clients).toContain("claude-code");
      expect(clients).toContain("cursor");
    });
  });
});

/**
 * mt#5153. `resolveInitClient` used to rank the installed clients when the
 * environment was silent (`STANDALONE_CLIENT_PRIORITY`, cursor first), so on
 * a multi-client machine every no-signal run wrote a silent `harness: cursor`.
 * It now answers only from a signal — flag, MCP caller identity, CLI
 * environment — or from the ONE installed client; otherwise it says so.
 */
describe("resolveInitClient (mt#5153)", () => {
  const FIVE_INSTALLED = ["cursor", "claude-code", "claude-desktop", "vscode", "codex"] as const;
  const CLAUDE_CONV = "com.anthropic.claude-code:conv:2f1c3b1a-9d6f-4e1b-8a0c-5b7d9e2f4a61";
  const CLAUDE_PROC = "com.anthropic.claude-code:proc:f36a2fd77a664ba3";
  const CURSOR_PROC = "com.cursor.cursor:proc:0123456789abcdef";
  const UNKNOWN_PROC = "unknown:proc:0123456789abcdef";

  describe("precedence", () => {
    test("an explicit client outranks every detected signal", () => {
      expect(
        resolveInitClient({
          explicit: "codex",
          callerAgentId: CLAUDE_CONV,
          harness: "cursor",
          installedClients: [...FIVE_INSTALLED],
        })
      ).toEqual({ kind: "resolved", client: "codex", source: "flag" });
    });

    test("over MCP the caller's identity wins, and the environment is NOT consulted", () => {
      // The daemon's env is its spawner's — here it says cursor, the caller is
      // Claude Code. The caller is right.
      expect(
        resolveInitClient({
          callerAgentId: CLAUDE_CONV,
          harness: "cursor",
          installedClients: [...FIVE_INSTALLED],
        })
      ).toEqual({ kind: "resolved", client: "claude-code", source: "mcp-client" });
      expect(resolveInitClient({ callerAgentId: CURSOR_PROC, harness: "claude-code" })).toEqual({
        kind: "resolved",
        client: "cursor",
        source: "mcp-client",
      });
    });

    test("over MCP with an unmapped caller kind, the environment is STILL not consulted", () => {
      // 2026-09-14's daemon carried CLAUDECODE=1 from a tray relaunched out of
      // an agent's Bash; a Claude Desktop caller must not inherit that.
      expect(
        resolveInitClient({
          callerAgentId: UNKNOWN_PROC,
          harness: "claude-code",
          installedClients: [...FIVE_INSTALLED],
        })
      ).toEqual({ kind: "ambiguous", installed: [...FIVE_INSTALLED] });
    });

    test("on the CLI path (no caller id) the environment decides", () => {
      expect(
        resolveInitClient({ harness: "claude-code", installedClients: [...FIVE_INSTALLED] })
      ).toEqual({ kind: "resolved", client: "claude-code", source: "env" });
      expect(resolveInitClient({ harness: "cursor", installedClients: ["claude-code"] })).toEqual({
        kind: "resolved",
        client: "cursor",
        source: "env",
      });
    });
  });

  describe("installed-ness is not a signal", () => {
    test("exactly one installed client is the answer, with source `installed`", () => {
      expect(resolveInitClient({ harness: "standalone", installedClients: ["junie"] })).toEqual({
        kind: "resolved",
        client: "junie",
        source: "installed",
      });
    });

    test("two or more installed with no signal is AMBIGUOUS — never a ranked pick", () => {
      // The flowtato repro: five clients installed, cursor listed first. The old
      // resolver returned "cursor"; this one refuses to choose.
      const result = resolveInitClient({
        harness: "standalone",
        installedClients: [...FIVE_INSTALLED],
      });
      expect(result).toEqual({ kind: "ambiguous", installed: [...FIVE_INSTALLED] });
      // Order of installation must not leak into an answer either way.
      expect(
        resolveInitClient({ harness: "standalone", installedClients: ["claude-code", "cursor"] })
          .kind
      ).toBe("ambiguous");
    });

    test("nothing installed with no signal is NONE — not cursor", () => {
      expect(resolveInitClient({ harness: "standalone", installedClients: [] })).toEqual({
        kind: "none",
      });
    });
  });

  test("defaults to the real detectors when called with no arguments", () => {
    // Machine-dependent value; assert the shape only.
    const result = resolveInitClient();
    expect(["resolved", "ambiguous", "none"]).toContain(result.kind);
  });

  describe("clientFromAgentId", () => {
    test("maps the three recorded kinds, on conv- and proc-scoped ids alike", () => {
      expect(clientFromAgentId(CLAUDE_CONV)).toBe("claude-code");
      expect(clientFromAgentId(CLAUDE_PROC)).toBe("claude-code");
      expect(clientFromAgentId(CURSOR_PROC)).toBe("cursor");
      expect(clientFromAgentId("com.openai.codex:proc:0123456789abcdef")).toBe("codex");
    });

    test("walks a native subagent to its parent's harness", () => {
      expect(clientFromAgentId(`minsky.native-subagent:run:task-mt123@${CLAUDE_PROC}`)).toBe(
        "claude-code"
      );
    });

    test("an unknown kind, a malformed id, or nothing is null — no signal, not a guess", () => {
      expect(clientFromAgentId(UNKNOWN_PROC)).toBeNull();
      expect(clientFromAgentId("app.zed.zed:proc:0123456789abcdef")).toBeNull();
      expect(clientFromAgentId("not an agent id")).toBeNull();
      expect(clientFromAgentId("minsky.native-subagent:run:task-mt1")).toBeNull();
      expect(clientFromAgentId(null)).toBeNull();
      expect(clientFromAgentId(undefined)).toBeNull();
    });
  });

  describe("resolveAgentHarness (mt#4510)", () => {
    test("over MCP a Claude Code caller is claude-code whatever the process env says", () => {
      withEnv({ CLAUDECODE: undefined, VSCODE_PID: "1" }, () => {
        expect(resolveAgentHarness({ callerAgentId: CLAUDE_CONV })).toBe("claude-code");
      });
    });

    test("over MCP an unmapped caller is standalone even under CLAUDECODE=1", () => {
      withEnv({ CLAUDECODE: "1" }, () => {
        expect(resolveAgentHarness({ callerAgentId: UNKNOWN_PROC })).toBe("standalone");
        expect(resolveAgentHarness({ callerAgentId: CURSOR_PROC })).toBe("cursor");
      });
    });

    test("with no caller id it is the environment", () => {
      withEnv({ CLAUDECODE: "1" }, () => {
        expect(resolveAgentHarness()).toBe("claude-code");
      });
    });
  });

  describe("describeUnresolvedClient", () => {
    test("names the installed clients, the flag, and every accepted value", () => {
      const message = describeUnresolvedClient(
        { kind: "ambiguous", installed: ["cursor", "claude-code"] },
        "--client"
      );
      expect(message).toContain("2 MCP clients are installed (cursor, claude-code)");
      expect(message).toContain("--client");
      for (const client of MANAGED_CLIENTS) expect(message).toContain(client);
    });

    test("the none case says nothing is installed and still names the remedy", () => {
      const message = describeUnresolvedClient({ kind: "none" }, "--client");
      expect(message).toContain("no known MCP client is installed");
      expect(message).toContain("--client");
    });
  });

  describe("the runtime lists match the types they shadow", () => {
    test("isManagedClient accepts exactly MANAGED_CLIENTS", () => {
      for (const client of MANAGED_CLIENTS) expect(isManagedClient(client)).toBe(true);
      expect(isManagedClient("claude")).toBe(false);
      expect(isManagedClient(undefined)).toBe(false);
    });

    test("workspaceConfigSchema.harnessSource accepts exactly HARNESS_SOURCES", () => {
      // The schema carries its own literal enum (the configuration package
      // does not import the runtime module); this pins the two together.
      for (const source of HARNESS_SOURCES) {
        expect(workspaceConfigSchema.safeParse({ harnessSource: source }).success).toBe(true);
      }
      expect(workspaceConfigSchema.safeParse({ harnessSource: "ranked" }).success).toBe(false);
    });
  });
});

describe("describeUnresolvedClient names the witness that came back empty (mt#5153)", () => {
  test("over MCP the refusal names the unrecognised client id, not the environment", () => {
    const message = describeUnresolvedClient(
      { kind: "ambiguous", installed: ["cursor", "claude-code"] },
      "--client",
      { kind: "mcp-client", agentId: "unknown:proc:0123456789abcdef" }
    );
    expect(message).toContain("the MCP client making this call (unknown:proc:0123456789abcdef)");
    expect(message).not.toContain("no harness signal in the environment");
  });
});
