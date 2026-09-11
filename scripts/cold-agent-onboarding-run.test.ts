/* eslint-disable custom/no-real-fs-in-tests -- mt#5018 AT4's subject is what
   `git clone` does to a REAL working tree's `origin`. A mock filesystem would be
   asserting the mock's behaviour rather than git's, which is precisely the
   substitution that produced the wrong finding this task exists to correct
   (a harness that alters the environment can alter the property under
   measurement). Confined to `mkdtemp` dirs, each removed in `afterAll`; the rule's
   race-condition concern does not apply, since `mkdtempSync` returns a unique
   path per call rather than a shared fixed one. */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildColdAgentPrompt,
  buildSandboxEnv,
  buildSandboxPath,
  CHANNELS,
  cloneTarget,
  DEFAULT_OUT_DIR,
  describeCredentialBilling,
  DISPOSABLE_POSTGRES_IMAGE,
  type HarnessCredential,
  maskGitRemote,
  readGitOrigin,
  evaluateIsolation,
  findFreePort,
  negativeControlGaps,
  NEGATIVE_CONTROL_CHANNELS,
  parseArgs,
  parseMcpServerNames,
  POSTGRES_ENV_VARS,
  preconditionFailures,
  renderVerdicts,
  REQUIRED_TOOLS,
  sandboxEnvVarNames,
  sandboxPathsUnder,
  stripPathEntry,
  transcriptPathFor,
  userScopeMcpServerNamesIn,
  type IsolationObservations,
} from "./cold-agent-onboarding-run";

describe("mt#5066 — the .claude.json half of channel 5, and the durable transcript", () => {
  const madeDirs: string[] = [];
  afterAll(() => {
    for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true });
  });
  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mt5066-"));
    madeDirs.push(dir);
    return dir;
  }

  test("userScopeMcpServerNamesIn reads NAMES only, and an absent file is genuinely empty", () => {
    const dir = tempDir();
    const file = join(dir, ".claude.json");
    expect(userScopeMcpServerNamesIn(file)).toEqual([]);
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { "minsky-server": { command: "minsky", env: { TOKEN: "s3cret" } } },
        firstStartTime: "2026-09-11T00:00:00Z",
      })
    );
    const names = userScopeMcpServerNamesIn(file);
    expect(names).toEqual(["minsky-server"]);
    expect(JSON.stringify(names)).not.toContain("s3cret");
  });

  test("a file with no mcpServers key is empty; an unparseable one opens the channel", () => {
    const dir = tempDir();
    const clean = join(dir, ".claude.json");
    writeFileSync(clean, JSON.stringify({ firstStartTime: "2026-09-11T00:00:00Z" }));
    expect(userScopeMcpServerNamesIn(clean)).toEqual([]);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ not json");
    expect(userScopeMcpServerNamesIn(broken)).toEqual(["UNPARSED:broken.json"]);
  });

  test("the transcript lands beside its record under --out-dir, keyed by the run timestamp", () => {
    const outDir = "/state/cold-agent-runs";
    expect(transcriptPathFor(outDir, 1789019061415)).toBe(
      join(outDir, "transcript-run-1789019061415.txt")
    );
    // Not inside the sandbox root any more (defect 2).
    expect(transcriptPathFor(outDir, 1)).not.toContain("mt5012-cold-");
  });
});
import { PGVECTOR_DOCKER_IMAGE } from "../packages/domain/src/persistence/pgvector-preflight";

// mt#5016 / PR #3678 R1. The harness deliberately imports nothing from the
// domain — it stands in for a machine that has no Minsky installed — so its
// Postgres image is a duplicated literal. A comment saying "keep these in sync"
// is not a mechanism; this is. The test file has no such constraint, so the
// invariant lives here.
//
// This is load-bearing beyond tidiness: hand the cold agent an image without
// pgvector and it cannot migrate, so it improvises an `apt-get` — which the
// harness then faithfully records as an onboarding defect that the harness
// itself caused. That is what happened on 2026-09-05.
// PR #3680 R1 (non-blocking): these shell out to a real `git`. It is already a
// declared prerequisite of the harness under test — `REQUIRED_TOOLS.execute`
// names it, and `preconditionFailures` fails a run without it — so the
// dependency is the subject's, not this suite's invention. Skipped rather than
// failed where the binary is genuinely absent, so a constrained CI cannot turn a
// missing tool into a red test.
const GIT_AVAILABLE =
  spawnSync("git", ["--version"], { encoding: "utf8", timeout: 30_000 }).status === 0;

describe.skipIf(!GIT_AVAILABLE)(
  "cloneTarget gives the clone the TARGET's remote, not the clone path (mt#5018 AT4)",
  () => {
    const madeDirs: string[] = [];

    function tempDir(prefix: string): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      madeDirs.push(dir);
      return dir;
    }

    /** A real git repo with one commit and a GitHub-shaped origin. */
    function makeTargetRepo(): string {
      const dir = tempDir("mt5018-target-");
      const run = (...args: string[]) =>
        spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 30_000 });
      spawnSync("git", ["init", "--quiet", dir], { encoding: "utf8", timeout: 30_000 });
      run("config", "user.email", "t@example.com");
      run("config", "user.name", "T");
      writeFileSync(join(dir, "README.md"), "# target\n");
      run("add", "README.md");
      run("commit", "--quiet", "-m", "init");
      run("remote", "add", "origin", "https://github.com/edobry/minsky.git");
      return dir;
    }

    afterAll(() => {
      for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true });
    });

    test("the clone's origin is the target's own remote", () => {
      const target = makeTargetRepo();
      const dest = join(tempDir("mt5018-dest-"), "workspace");

      const origin = cloneTarget(target, dest);

      expect(origin).toBe("https://github.com/edobry/minsky.git");
      expect(readGitOrigin(dest)).toBe("https://github.com/edobry/minsky.git");
    });

    // The negative control, in the same test file rather than as a manual step:
    // this is what the harness did before the fix, and it is why the 2026-09-05
    // run reported sessions as unusable. `session start` refuses any remote
    // without `github.com` in it, and a filesystem path has none.
    test("negative control: a plain clone leaves origin as the local path", () => {
      const target = makeTargetRepo();
      const dest = join(tempDir("mt5018-plain-"), "workspace");

      spawnSync("git", ["clone", "--quiet", target, dest], { encoding: "utf8", timeout: 30_000 });

      expect(readGitOrigin(dest)).toBe(target);
      expect(readGitOrigin(dest)).not.toContain("github.com");
    });

    test("a target with no origin of its own leaves the clone's own origin alone", () => {
      const bare = tempDir("mt5018-noremote-");
      spawnSync("git", ["init", "--quiet", bare], { encoding: "utf8", timeout: 30_000 });
      const run = (...args: string[]) =>
        spawnSync("git", ["-C", bare, ...args], { encoding: "utf8", timeout: 30_000 });
      run("config", "user.email", "t@example.com");
      run("config", "user.name", "T");
      writeFileSync(join(bare, "f.txt"), "x\n");
      run("add", "f.txt");
      run("commit", "--quiet", "-m", "init");

      const dest = join(tempDir("mt5018-noremote-dest-"), "workspace");
      expect(cloneTarget(bare, dest)).toBe(bare);
    });

    test("readGitOrigin returns null for a directory that is not a repo", () => {
      expect(readGitOrigin(tempDir("mt5018-notrepo-"))).toBeNull();
    });

    // PR #3680 R1 BLOCKING. A remote can carry credentials in its userinfo, and
    // this value is both printed and written to disk. End-to-end through the real
    // `cloneTarget`, not just the mask helper — the leak was in what the function
    // RETURNS, so asserting the helper alone would have missed it.
    test("a credential-bearing remote is masked in what cloneTarget returns", () => {
      const target = tempDir("mt5018-cred-");
      spawnSync("git", ["init", "--quiet", target], { encoding: "utf8", timeout: 30_000 });
      const run = (...args: string[]) =>
        spawnSync("git", ["-C", target, ...args], { encoding: "utf8", timeout: 30_000 });
      run("config", "user.email", "t@example.com");
      run("config", "user.name", "T");
      writeFileSync(join(target, "f.txt"), "x\n");
      run("add", "f.txt");
      run("commit", "--quiet", "-m", "init");
      run("remote", "add", "origin", "https://someone:ghp_notarealtokenvalue@github.com/o/r.git");

      const origin = cloneTarget(target, join(tempDir("mt5018-cred-dest-"), "workspace"));

      expect(origin).toBe("https://***:***@github.com/o/r.git");
      expect(origin).not.toContain("ghp_notarealtokenvalue");
      // The host survives: that is what the field is FOR — telling whether a
      // remote-dependent finding is real.
      expect(origin).toContain("github.com");
    });
  }
);

describe("maskGitRemote", () => {
  test("masks userinfo in an https remote", () => {
    expect(maskGitRemote("https://u:tok@github.com/o/r.git")).toBe(
      "https://***:***@github.com/o/r.git"
    );
  });

  // The empty-username case is the specific drift `maskConnectionString`'s
  // docblock records a hand-rolled copy getting wrong — asserted here so the
  // import cannot be quietly replaced by a local regex that reintroduces it.
  test("masks an empty username too", () => {
    expect(maskGitRemote("https://:tok@github.com/o/r.git")).toBe(
      "https://***:***@github.com/o/r.git"
    );
  });

  test("leaves a credential-free https remote alone", () => {
    expect(maskGitRemote("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
  });

  test("leaves an ssh remote alone — it carries no secret and no scheme", () => {
    expect(maskGitRemote("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  });

  test("leaves a local path alone", () => {
    expect(maskGitRemote("/Users/someone/Projects/minsky")).toBe("/Users/someone/Projects/minsky");
  });

  test("passes null through", () => {
    expect(maskGitRemote(null)).toBeNull();
  });
});

// mt#5018 SC4. Every run says who pays, before spending any of it. The two
// phrasings must be distinguishable — a message that read the same either way
// would satisfy the code path and tell the operator nothing (mem#704).
describe("describeCredentialBilling names who pays", () => {
  test("the subscription phrasing says there is no metered spend", () => {
    const text = describeCredentialBilling("subscription");
    expect(text).toContain("subscription");
    expect(text).toContain("no metered");
  });

  test("the API-key phrasing says spend is metered, and why it was chosen", () => {
    const text = describeCredentialBilling("api-key");
    expect(text).toContain("metered");
    expect(text).toContain("no subscription token configured");
  });

  test("the two are not the same string", () => {
    expect(describeCredentialBilling("subscription")).not.toBe(
      describeCredentialBilling("api-key")
    );
  });
});

describe("the disposable Postgres image tracks what `minsky setup db` prints", () => {
  test("harness image equals PGVECTOR_DOCKER_IMAGE", () => {
    expect(DISPOSABLE_POSTGRES_IMAGE).toBe(PGVECTOR_DOCKER_IMAGE);
  });
});

/** What the sandbox is supposed to look like: every channel closed. */
const SANDBOXED: IsolationObservations = {
  mcpServerNames: [],
  minskyBinaryPath: null,
  bunBinaryPath: "/tmp/sbx/bin/bun",
  minskyConfigPresent: false,
  daemonTokenPresent: false,
  daemonProbe: { kind: "status", code: 401 },
  claudeCustomizationEntries: [],
  userScopeMcpServerNames: [],
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
  daemonProbe: { kind: "status", code: 401 },
  claudeCustomizationEntries: ["CLAUDE.md", "skills", "plugins", "commands"],
  // mt#5066: measured 2026-09-11 — the operator's real `~/.claude.json` carries a
  // user-scope `minsky-server` entry (name only; values are never read).
  userScopeMcpServerNames: ["minsky-server"],
  postgresEnvVarsPresent: [],
};

/** The operator's install location, shared by the PATH-stripping tests. */
const OPERATOR_BIN_DIR = "/home/u/.bun/bin";
const CUSTOMIZATIONS_CHANNEL = "claudeCustomizations";
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
    expect(verdictFor(OPERATOR_MACHINE, CUSTOMIZATIONS_CHANNEL).detail).toContain("skills");
    expect(verdictFor(OPERATOR_MACHINE, "minskyBinary").detail).toContain(".bun/bin/minsky");
    expect(verdictFor(OPERATOR_MACHINE, "mcp").detail).toContain("minsky");
  });

  test("matches an MCP server name case-insensitively and as a substring", () => {
    const obs = { ...SANDBOXED, mcpServerNames: ["Minsky-local", "github"] };
    expect(verdictFor(obs, "mcp").isolated).toBe(false);
  });

  test("mt#5066: channel 5 is OPEN on a user-scope MCP registration even when the customizations dir is clean", () => {
    // The 2026-09-10 run's exact shape: `claude-config/` carried nothing, and the
    // channel read ISOLATED while `.claude.json` — the file `minsky setup` writes —
    // was never looked at. The probe must fail on the file alone.
    const obs: IsolationObservations = {
      ...SANDBOXED,
      claudeCustomizationEntries: [],
      userScopeMcpServerNames: ["minsky-server"],
    };
    const verdict = verdictFor(obs, CUSTOMIZATIONS_CHANNEL);
    expect(verdict.isolated).toBe(false);
    expect(verdict.detail).toContain("minsky-server");
  });

  test("mt#5066: an unreadable .claude.json opens the channel rather than closing it", () => {
    const obs: IsolationObservations = {
      ...SANDBOXED,
      userScopeMcpServerNames: ["UNPARSED:.claude.json"],
    };
    expect(verdictFor(obs, CUSTOMIZATIONS_CHANNEL).isolated).toBe(false);
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
  test("401 is isolated — reachable but refused, which is what AT1(d) requires", () => {
    const obs = { ...SANDBOXED, daemonProbe: { kind: "status", code: 401 } as const };
    expect(verdictFor(obs, "daemon").isolated).toBe(true);
  });

  test("nothing listening is isolated — there is no daemon to use", () => {
    const obs = { ...SANDBOXED, daemonProbe: { kind: "refused" } as const };
    expect(verdictFor(obs, "daemon").isolated).toBe(true);
  });

  test("200 is OPEN — an unauthenticated caller was served", () => {
    const obs = { ...SANDBOXED, daemonProbe: { kind: "status", code: 200 } as const };
    expect(verdictFor(obs, "daemon").isolated).toBe(false);
  });

  test("a probe that did not COMPLETE is OPEN, not a pass", () => {
    // The finding a reviewer caught on R3: the previous shape collapsed
    // "nothing listening" and "the probe failed" into one null, so a timeout
    // against a live, usable daemon reported ISOLATED — mem#704's can't-fail
    // probe, in the one direction this harness exists to prevent.
    const obs = {
      ...SANDBOXED,
      daemonProbe: { kind: "error", reason: "TimeoutError: signal timed out" } as const,
    };
    const v = verdictFor(obs, "daemon");
    expect(v.isolated).toBe(false);
    expect(v.detail).toContain("did not complete");
  });

  test("names which of the three outcomes it saw, so the detail is diagnosable", () => {
    const refused = { ...SANDBOXED, daemonProbe: { kind: "refused" } as const };
    const unauth = { ...SANDBOXED, daemonProbe: { kind: "status", code: 401 } as const };
    expect(verdictFor(refused, "daemon").detail).toContain("nothing listening");
    expect(verdictFor(unauth, "daemon").detail).toContain("401");
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

// mt#5018. The fixtures are credentials now, not a bare key string, and the
// subscription one is the DEFAULT the harness resolves — so it is what the
// pre-existing cases use. Module scope because three describes need them.
// The prefixes are the real families: `sk-ant-oat01-` is a subscription token
// from `claude setup-token`, `sk-ant-api03-` an API key (mt#5023).
const SUBSCRIPTION: HarnessCredential = {
  kind: "subscription",
  value: "sk-ant-oat01-".padEnd(60, "x"),
};
const API_KEY: HarnessCredential = { kind: "api-key", value: "sk-ant-api03-".padEnd(60, "x") };

describe("buildSandboxEnv", () => {
  const paths = sandboxPathsUnder("/tmp/sbx");

  test("strips every operator Postgres connection variable", () => {
    const base = Object.fromEntries(POSTGRES_ENV_VARS.map((n) => [n, "postgres://operator/db"]));
    const env = buildSandboxEnv(base, paths, SUBSCRIPTION, null);
    for (const name of POSTGRES_ENV_VARS) expect(env[name]).toBeUndefined();
  });

  test("redirects the Claude config dir, which is what closes the customization channel", () => {
    const env = buildSandboxEnv({}, paths, SUBSCRIPTION, null);
    expect(env.CLAUDE_CONFIG_DIR).toBe(paths.claudeConfigDir);
  });

  test("redirects Minsky's state dir and daemon token path", () => {
    const env = buildSandboxEnv({}, paths, SUBSCRIPTION, null);
    expect(env.MINSKY_STATE_DIR).toBe(paths.minskyStateDir);
    expect(env.MINSKY_LOCAL_MCP_TOKEN_PATH).toBe(paths.daemonTokenPath);
  });

  test("does NOT redirect HOME — a sandboxed HOME loses Claude Code's own login", () => {
    const env = buildSandboxEnv({ HOME: "/Users/someone" }, paths, SUBSCRIPTION, null);
    expect(env.HOME).toBe("/Users/someone");
  });

  // mt#5018 SC1/SC4. The old test here asserted `ANTHROPIC_API_KEY` was set,
  // encoding the belief that a relocated config dir forces metered auth. It
  // does not: a subscription token in the env survives the relocation, verified
  // live. These four assert the credential ACTUALLY handed to `claude`.
  test("passes a subscription token as CLAUDE_CODE_OAUTH_TOKEN", () => {
    const env = buildSandboxEnv({}, paths, SUBSCRIPTION, null);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(SUBSCRIPTION.value);
  });

  // The load-bearing one. Anthropic documents that in `-p` mode an
  // ANTHROPIC_API_KEY present in the environment is "always used", overriding
  // the subscription — so INHERITING the operator's exported key would silently
  // bill the metered path while the harness believed it had chosen the
  // subscription. Deleting it is what makes the choice real.
  test("DELETES an inherited ANTHROPIC_API_KEY when billing the subscription", () => {
    const env = buildSandboxEnv(
      { ANTHROPIC_API_KEY: "sk-ant-api03-operators-own-exported-key" },
      paths,
      SUBSCRIPTION,
      null
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("falls back to ANTHROPIC_API_KEY when that is the resolved credential", () => {
    const env = buildSandboxEnv({}, paths, API_KEY, null);
    expect(env.ANTHROPIC_API_KEY).toBe(API_KEY.value);
  });

  // PR #3680 R1 (non-blocking) asked whether the deletion can affect other
  // consumers of the inherited env. It cannot — the function works on a copy —
  // and this is the assertion that keeps that true, since a line added above
  // the spread would silently change it.
  test("deletes from a COPY: the caller's environment object is untouched", () => {
    const base = { ANTHROPIC_API_KEY: "sk-ant-api03-operators-own", PATH: "/usr/bin" };
    buildSandboxEnv(base, paths, SUBSCRIPTION, null);
    expect(base.ANTHROPIC_API_KEY).toBe("sk-ant-api03-operators-own");
    expect(base.PATH).toBe("/usr/bin");
  });

  test("does not leave a stale OAuth token behind on the API-key path either", () => {
    const env = buildSandboxEnv(
      { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-stale" },
      paths,
      API_KEY,
      null
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test("removes the operator's minsky install from PATH", () => {
    const env = buildSandboxEnv(
      { PATH: `/usr/bin:${OPERATOR_BIN_DIR}` },
      paths,
      SUBSCRIPTION,
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
    const env = buildSandboxEnv({}, paths, SUBSCRIPTION, null);
    expect(env.BUN_INSTALL).toBe(paths.bunInstallDir);
  });

  test("points npm's prefix at the sandbox too, for the README's npm branch", () => {
    const env = buildSandboxEnv({}, paths, SUBSCRIPTION, null);
    expect(env.NPM_CONFIG_PREFIX).toBe(paths.npmPrefixDir);
  });

  test("puts both sandbox install dirs on PATH ahead of everything else", () => {
    const env = buildSandboxEnv({ PATH: "/usr/bin" }, paths, SUBSCRIPTION, null);
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

  test("defaults the run-record directory outside the repository", () => {
    expect(parseArgs([], 0).outDir).toBe(DEFAULT_OUT_DIR);
    expect(DEFAULT_OUT_DIR).not.toContain("/minsky/scripts");
  });

  test("reads --out-dir", () => {
    expect(parseArgs(["--out-dir", "/tmp/records"], 0).outDir).toBe("/tmp/records");
  });

  test("treats a flag following --target as an omitted value, not as the value", () => {
    // `--target --execute` used to yield target "--execute", which would then
    // be cloned as a repo path.
    expect(parseArgs(["--target", "--execute"], 0).target).toBeNull();
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

describe("parseMcpServerNames", () => {
  // The failure DIRECTION is what these pin. A missed name reads as an absent
  // server, which reports the channel ISOLATED when it is not — a false pass in
  // the one direction the harness exists to prevent.
  test("reads the name from the standard '<name>: <command>' shape", () => {
    expect(parseMcpServerNames("minsky: bun run shim.ts\ngithub: bunx gh-mcp")).toEqual([
      "minsky",
      "github",
    ]);
  });

  test("keeps a name containing spaces, which the old character class dropped", () => {
    expect(parseMcpServerNames("my minsky server: bun run shim.ts")).toEqual(["my minsky server"]);
  });

  test("keeps a name the old anchored pattern would have missed after indentation", () => {
    expect(parseMcpServerNames("    minsky: bun run shim.ts")).toEqual(["minsky"]);
  });

  test("skips a bare URL line, whose scheme colon is not a name", () => {
    expect(parseMcpServerNames("https://example.com/mcp")).toEqual([]);
  });

  test("skips blank and comment lines", () => {
    expect(parseMcpServerNames("\n\n# Configured servers\n")).toEqual([]);
  });

  test("surfaces an entry-shaped line it cannot name rather than dropping it", () => {
    // Dropping it would close the channel silently; surfacing it opens the
    // channel and makes a human look.
    const names = parseMcpServerNames("  : bun run shim.ts");
    expect(names).toHaveLength(1);
    // `startsWith` rather than a `toStartWith` matcher: the matcher works on
    // this Bun but is not part of the standard expect surface, and a test that
    // fails on a runner upgrade for matcher reasons is noise.
    expect(names[0]?.startsWith("UNPARSED:")).toBe(true);
  });
});

describe("sandboxEnvVarNames", () => {
  test("reports the names of variables the sandbox set", () => {
    const names = sandboxEnvVarNames({ PATH: "/usr/bin" }, { PATH: "/sbx:/usr/bin", FOO: "1" });
    expect(names).toEqual(["FOO", "PATH"]);
  });

  test("NEVER reports a value — the record is written to disk beside an API key", () => {
    const secret = "sk-ant-".padEnd(40, "x");
    const names = sandboxEnvVarNames({}, { ANTHROPIC_API_KEY: secret });
    expect(names).toEqual(["ANTHROPIC_API_KEY"]);
    expect(JSON.stringify(names)).not.toContain(secret);
  });

  test("is derived by diff, so a variable added to buildSandboxEnv cannot escape it", () => {
    const paths = sandboxPathsUnder("/tmp/sbx");
    const env = buildSandboxEnv({}, paths, SUBSCRIPTION, null);
    const names = sandboxEnvVarNames({}, env);
    for (const expected of ["CLAUDE_CONFIG_DIR", "MINSKY_STATE_DIR", "BUN_INSTALL", "PATH"]) {
      expect(names).toContain(expected);
    }
  });

  test("omits a variable the sandbox left untouched", () => {
    expect(sandboxEnvVarNames({ HOME: "/h" }, { HOME: "/h" })).toEqual([]);
  });
});

describe("findFreePort", () => {
  test("returns the first port nothing is listening on", () => {
    expect(findFreePort((p) => p < 45003, 45000, 10)).toBe(45003);
  });

  test("returns the base port when it is already free", () => {
    expect(findFreePort(() => false, 45000, 10)).toBe(45000);
  });

  test("throws rather than returning a busy port when the span is exhausted", () => {
    // The old arithmetic could not fail visibly: a collision surfaced as
    // "Postgres never became ready", indistinguishable from a bad image pull.
    expect(() => findFreePort(() => true, 45000, 5)).toThrow("no free port");
  });
});

describe("preconditionFailures — harness tools", () => {
  test("names each missing tool the harness itself invokes", () => {
    const failures = preconditionFailures(SANDBOXED, ["docker", "git"]);
    expect(failures).toHaveLength(2);
    expect(failures.join(" ")).toContain("docker");
    expect(failures.join(" ")).toContain("git");
  });

  test("passes when nothing is missing", () => {
    expect(preconditionFailures(SANDBOXED, [])).toEqual([]);
  });

  test("reports a missing tool alongside a missing prerequisite, not instead of it", () => {
    const failures = preconditionFailures({ ...SANDBOXED, bunBinaryPath: null }, ["docker"]);
    expect(failures).toHaveLength(2);
  });

  test("scopes docker and git to the execute path", () => {
    // Requiring them in assertion mode would refuse a run that would work.
    expect(REQUIRED_TOOLS.always).not.toContain("docker");
    expect(REQUIRED_TOOLS.execute).toContain("docker");
  });

  test("declares every tool the execute path shells out to, including nc", () => {
    // R1 generalized the precondition check and still missed `nc`, which the
    // free-port probe invokes. The declared set is only useful if it is
    // complete.
    for (const tool of ["docker", "git", "nc"]) {
      expect(REQUIRED_TOOLS.execute).toContain(tool);
    }
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
