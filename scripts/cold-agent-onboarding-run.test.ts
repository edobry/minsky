import { describe, expect, test } from "bun:test";
import {
  buildSandboxEnv,
  CHANNELS,
  evaluateIsolation,
  negativeControlGaps,
  NEGATIVE_CONTROL_CHANNELS,
  parseArgs,
  POSTGRES_ENV_VARS,
  renderVerdicts,
  sandboxPathsUnder,
  stripPathEntry,
  type IsolationObservations,
} from "./cold-agent-onboarding-run";

/** What the sandbox is supposed to look like: every channel closed. */
const SANDBOXED: IsolationObservations = {
  mcpServerNames: [],
  minskyBinaryPath: null,
  minskyConfigPresent: false,
  daemonTokenPresent: false,
  daemonUnauthenticatedMcpStatus: 401,
  claudeCustomizationEntries: [],
  postgresEnvVarsPresent: [],
};

/**
 * What this machine looks like without the sandbox, measured 2026-09-05 and
 * recorded on mt#5012's AT2. This fixture is the unit-level negative control:
 * if `evaluateIsolation` called it clean, the whole suite would be inert.
 *
 * `postgresEnvVarsPresent` is EMPTY on purpose, and that is the whole point of
 * measuring the fixture rather than imagining it. This machine sets none of
 * those variables — the connection string lives in the Minsky config file — so
 * an earlier fixture that asserted `["DATABASE_URL"]` made the database channel
 * look discriminating when the live run showed it was not.
 */
const OPERATOR_MACHINE: IsolationObservations = {
  mcpServerNames: ["minsky"],
  minskyBinaryPath: "/Users/someone/.bun/bin/minsky",
  minskyConfigPresent: true,
  daemonTokenPresent: true,
  daemonUnauthenticatedMcpStatus: 401,
  claudeCustomizationEntries: ["CLAUDE.md", "skills", "plugins", "commands"],
  postgresEnvVarsPresent: [],
};

function verdictFor(obs: IsolationObservations, channel: string) {
  const v = evaluateIsolation(obs).find((entry) => entry.channel === channel);
  if (!v) throw new Error(`no verdict for channel ${channel}`);
  return v;
}

describe("evaluateIsolation", () => {
  test("reports every channel isolated for a correctly sandboxed environment", () => {
    const verdicts = evaluateIsolation(SANDBOXED);
    expect(verdicts).toHaveLength(Object.keys(CHANNELS).length);
    expect(verdicts.every((v) => v.isolated)).toBe(true);
  });

  test("reports the five discriminating channels OPEN on the un-sandboxed machine", () => {
    const verdicts = evaluateIsolation(OPERATOR_MACHINE);
    const open = verdicts.filter((v) => !v.isolated).map((v) => v.channel);
    expect(open.sort()).toEqual([...NEGATIVE_CONTROL_CHANNELS].sort());
  });

  test("names the leaking artifacts rather than only reporting a boolean", () => {
    expect(verdictFor(OPERATOR_MACHINE, "claudeCustomizations").detail).toContain("skills");
    expect(verdictFor(OPERATOR_MACHINE, "minskyBinary").detail).toContain(".bun/bin/minsky");
    expect(verdictFor(OPERATOR_MACHINE, "mcp").detail).toContain("minsky");
  });

  test("matches an MCP server name case-insensitively and as a substring", () => {
    const obs = { ...SANDBOXED, mcpServerNames: ["Minsky-local", "github"] };
    expect(verdictFor(obs, "mcp").isolated).toBe(false);
  });

  test("ignores unrelated MCP servers, which a new user may legitimately have", () => {
    const obs = { ...SANDBOXED, mcpServerNames: ["github", "supabase"] };
    expect(verdictFor(obs, "mcp").isolated).toBe(true);
  });
});

describe("the daemon channel asserts unusability, not unreachability", () => {
  // The port is a fixed contract (ADR-038) and macOS loopback is shared, so a
  // reachable daemon is expected. What must not happen is an unauthenticated
  // caller getting served.
  test("401 is isolated — reachable but refused", () => {
    expect(
      verdictFor({ ...SANDBOXED, daemonUnauthenticatedMcpStatus: 401 }, "daemon").isolated
    ).toBe(true);
  });

  test("no daemon answering is isolated — nothing to use", () => {
    expect(
      verdictFor({ ...SANDBOXED, daemonUnauthenticatedMcpStatus: null }, "daemon").isolated
    ).toBe(true);
  });

  test("200 is OPEN — an unauthenticated caller was served", () => {
    expect(
      verdictFor({ ...SANDBOXED, daemonUnauthenticatedMcpStatus: 200 }, "daemon").isolated
    ).toBe(false);
  });
});

describe("the database channel reads both routes to a connection string", () => {
  // The env route alone cannot discriminate on this machine, which is what the
  // first live AT2 run reported. Both routes are checked so the channel can.
  test("the config-file route alone opens the channel, with no env var set", () => {
    const v = verdictFor({ ...SANDBOXED, minskyConfigPresent: true }, "database");
    expect(v.isolated).toBe(false);
    expect(v.detail).toContain("operator config reachable");
  });

  test("the env route alone opens the channel, with no config present", () => {
    const v = verdictFor({ ...SANDBOXED, postgresEnvVarsPresent: ["DATABASE_URL"] }, "database");
    expect(v.isolated).toBe(false);
    expect(v.detail).toContain("DATABASE_URL");
  });

  test("is isolated only when neither route yields one", () => {
    expect(verdictFor(SANDBOXED, "database").isolated).toBe(true);
  });
});

describe("negativeControlGaps", () => {
  test("is empty when the un-sandboxed machine opens every discriminating channel", () => {
    expect(negativeControlGaps(evaluateIsolation(OPERATOR_MACHINE))).toEqual([]);
  });

  test("names a channel that failed to discriminate", () => {
    // A machine with no minsky binary installed: that channel cannot tell a
    // working sandbox from a broken one, and the control must say so rather
    // than let the suite's pass stand on it.
    const noBinary = { ...OPERATOR_MACHINE, minskyBinaryPath: null };
    expect(negativeControlGaps(evaluateIsolation(noBinary))).toEqual(["minskyBinary"]);
  });

  test("excludes the daemon channel, which cannot discriminate either way", () => {
    expect(NEGATIVE_CONTROL_CHANNELS).not.toContain("daemon");
  });
});

describe("stripPathEntry", () => {
  test("removes the directory holding the binary", () => {
    const result = stripPathEntry("/usr/bin:/home/u/.bun/bin:/bin", "/home/u/.bun/bin/minsky");
    expect(result).toBe("/usr/bin:/bin");
  });

  test("leaves PATH untouched when the binary was not found", () => {
    expect(stripPathEntry("/usr/bin:/bin", null)).toBe("/usr/bin:/bin");
  });

  test("removes every occurrence of the directory", () => {
    const result = stripPathEntry("/a:/home/u/bin:/b:/home/u/bin", "/home/u/bin/minsky");
    expect(result).toBe("/a:/b");
  });

  test("drops empty PATH segments rather than leaving an implicit cwd entry", () => {
    expect(stripPathEntry("/usr/bin::/bin", null)).toBe("/usr/bin:/bin");
  });
});

describe("buildSandboxEnv", () => {
  const paths = sandboxPathsUnder("/tmp/sbx");

  test("strips every operator Postgres connection variable", () => {
    const base = Object.fromEntries(POSTGRES_ENV_VARS.map((n) => [n, "postgres://operator/db"]));
    const env = buildSandboxEnv(base, paths, "sk-ant-".padEnd(40, "x"), null);
    for (const name of POSTGRES_ENV_VARS) expect(env[name]).toBeUndefined();
  });

  test("redirects the Claude config dir, which is what closes the customization channel", () => {
    const env = buildSandboxEnv({}, paths, "sk-ant-".padEnd(40, "x"), null);
    expect(env.CLAUDE_CONFIG_DIR).toBe(paths.claudeConfigDir);
  });

  test("redirects Minsky's state dir and daemon token path", () => {
    const env = buildSandboxEnv({}, paths, "sk-ant-".padEnd(40, "x"), null);
    expect(env.MINSKY_STATE_DIR).toBe(paths.minskyStateDir);
    expect(env.MINSKY_LOCAL_MCP_TOKEN_PATH).toBe(paths.daemonTokenPath);
  });

  test("does NOT redirect HOME — a sandboxed HOME loses Claude Code's own login", () => {
    const env = buildSandboxEnv({ HOME: "/Users/someone" }, paths, "sk-ant-".padEnd(40, "x"), null);
    expect(env.HOME).toBe("/Users/someone");
  });

  test("supplies the API key that replaces the OAuth session the moved config dir loses", () => {
    const key = "sk-ant-".padEnd(40, "x");
    expect(buildSandboxEnv({}, paths, key, null).ANTHROPIC_API_KEY).toBe(key);
  });

  test("removes the operator's minsky install from PATH", () => {
    const env = buildSandboxEnv(
      { PATH: "/usr/bin:/home/u/.bun/bin" },
      paths,
      "sk-ant-".padEnd(40, "x"),
      "/home/u/.bun/bin/minsky"
    );
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("parseArgs", () => {
  test("defaults to assertion-only, so the metered run is opt-in", () => {
    expect(parseArgs([], 0).execute).toBe(false);
  });

  test("reads --execute and --target", () => {
    const opts = parseArgs(["--execute", "--target", "/tmp/repo"], 0);
    expect(opts.execute).toBe(true);
    expect(opts.target).toBe("/tmp/repo");
  });

  test("reports a --target with no value as absent rather than as the next flag", () => {
    expect(parseArgs(["--target"], 0).target).toBeNull();
  });

  test("takes the clock as a parameter so a run record is reproducible", () => {
    expect(parseArgs([], 1_700_000_000_000).nowMs).toBe(1_700_000_000_000);
  });
});

describe("renderVerdicts", () => {
  test("marks open channels distinguishably from isolated ones", () => {
    const rendered = renderVerdicts("t:", evaluateIsolation(OPERATOR_MACHINE));
    expect(rendered).toContain("OPEN");
    expect(rendered).toContain("ISOLATED");
  });
});

describe("sandboxPathsUnder", () => {
  test("keeps every sandbox path inside the given root", () => {
    const paths = sandboxPathsUnder("/tmp/root");
    for (const value of Object.values(paths)) {
      expect(value.startsWith("/tmp/root")).toBe(true);
    }
  });
});
