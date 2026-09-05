import { describe, expect, test } from "bun:test";
import {
  buildColdAgentPrompt,
  buildSandboxEnv,
  buildSandboxPath,
  CHANNELS,
  evaluateIsolation,
  negativeControlGaps,
  NEGATIVE_CONTROL_CHANNELS,
  parseArgs,
  POSTGRES_ENV_VARS,
  preconditionFailures,
  renderVerdicts,
  sandboxPathsUnder,
  stripPathEntry,
  type IsolationObservations,
} from "./cold-agent-onboarding-run";

/** What the sandbox is supposed to look like: every channel closed. */
const SANDBOXED: IsolationObservations = {
  mcpServerNames: [],
  minskyBinaryPath: null,
  bunBinaryPath: "/tmp/sbx/bin/bun",
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
  bunBinaryPath: "/Users/someone/.bun/bin/bun",
  minskyConfigPresent: true,
  daemonTokenPresent: true,
  daemonUnauthenticatedMcpStatus: 401,
  claudeCustomizationEntries: ["CLAUDE.md", "skills", "plugins", "commands"],
  postgresEnvVarsPresent: [],
};

/** The operator's install location, shared by the PATH-stripping tests. */
const OPERATOR_BIN_DIR = "/home/u/.bun/bin";
const OPERATOR_MINSKY_BIN = `${OPERATOR_BIN_DIR}/minsky`;

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
      { PATH: `/usr/bin:${OPERATOR_BIN_DIR}` },
      paths,
      "sk-ant-".padEnd(40, "x"),
      OPERATOR_MINSKY_BIN
    );
    // Asserted as absence plus retention, not as an exact string: the sandbox
    // bin dirs are prepended, so an equality check here would break every time
    // one is added and would say nothing about what this test is for.
    const entries = (env.PATH ?? "").split(":");
    expect(entries).not.toContain(OPERATOR_BIN_DIR);
    expect(entries).toContain("/usr/bin");
  });
});

describe("buildSandboxPath", () => {
  // `bun` and `minsky` share a directory on this machine, so the strip that
  // removes one removes the other. These assert the prerequisite comes back.
  test("prepends the sandbox bin dirs ahead of the operator's PATH", () => {
    const result = buildSandboxPath("/usr/bin:/bin", null, ["/sbx/bin", "/sbx/bun/bin"]);
    expect(result).toBe("/sbx/bin:/sbx/bun/bin:/usr/bin:/bin");
  });

  test("still removes the directory holding minsky", () => {
    const result = buildSandboxPath(`/usr/bin:${OPERATOR_BIN_DIR}`, OPERATOR_MINSKY_BIN, [
      "/sbx/bin",
    ]);
    expect(result).toBe("/sbx/bin:/usr/bin");
    expect(result).not.toContain(OPERATOR_BIN_DIR);
  });

  test("yields only the prepended dirs when the operator PATH is empty", () => {
    expect(buildSandboxPath("", null, ["/sbx/bin"])).toBe("/sbx/bin");
  });
});

describe("preconditionFailures", () => {
  test("passes when bun is reachable in the sandbox", () => {
    expect(preconditionFailures(SANDBOXED)).toEqual([]);
  });

  test("fails when the strip took bun along with minsky", () => {
    const failures = preconditionFailures({ ...SANDBOXED, bunBinaryPath: null });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("prerequisite");
  });

  test("a missing bun is NOT reported as a contamination channel", () => {
    // It is the opposite of contamination — a broken sandbox, not a clean one.
    // Reading it as an isolated channel would let a harness failure be written
    // up as a Minsky onboarding finding.
    const verdicts = evaluateIsolation({ ...SANDBOXED, bunBinaryPath: null });
    expect(verdicts.every((v) => v.isolated)).toBe(true);
  });
});

describe("buildSandboxEnv global-install redirection", () => {
  const paths = sandboxPathsUnder("/tmp/sbx");

  test("points BUN_INSTALL at the sandbox so `bun add -g` cannot touch the operator's bin", () => {
    const env = buildSandboxEnv({}, paths, "sk-ant-".padEnd(40, "x"), null);
    expect(env.BUN_INSTALL).toBe(paths.bunInstallDir);
  });

  test("points npm's prefix at the sandbox too, for the README's npm branch", () => {
    const env = buildSandboxEnv({}, paths, "sk-ant-".padEnd(40, "x"), null);
    expect(env.NPM_CONFIG_PREFIX).toBe(paths.npmPrefixDir);
  });

  test("puts both sandbox install dirs on PATH ahead of everything else", () => {
    const env = buildSandboxEnv({ PATH: "/usr/bin" }, paths, "sk-ant-".padEnd(40, "x"), null);
    const entries = (env.PATH ?? "").split(":");
    expect(entries[0]).toBe(paths.binDir);
    expect(entries).toContain(`${paths.bunInstallDir}/bin`);
    expect(entries).toContain(`${paths.npmPrefixDir}/bin`);
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

describe("buildColdAgentPrompt", () => {
  // Credential-free on purpose. The real URL carries a generated password, and
  // a fixture shaped like one trips the gitleaks pre-commit scan — correctly,
  // since nothing downstream can tell a placeholder from a live credential.
  const DB_URL = "postgresql://127.0.0.1:45001/coldrun";
  const prompt = buildColdAgentPrompt(DB_URL);

  test("names Minsky as the thing to set up — that IS what is being measured", () => {
    expect(prompt).toContain("Minsky");
    expect(prompt).toContain("github.com/edobry/minsky");
  });

  test("names the database rather than configuring it, so the config step is still exercised", () => {
    expect(prompt).toContain(DB_URL);
    expect(prompt).toContain("empty Postgres");
  });

  test("asks how the agent knows it worked, which is where false success shows up", () => {
    expect(prompt).toContain("how you know");
    expect(prompt).toContain("guess");
  });

  test("carries no Minsky command names — those must come from the docs", () => {
    // A prompt that said `minsky init` would hand the agent the answer to the
    // question the run is asking.
    expect(prompt).not.toContain("minsky init");
    expect(prompt).not.toContain("minsky setup");
    expect(prompt).not.toContain("bun add");
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
