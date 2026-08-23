import { describe, test, expect } from "bun:test";
import {
  generatePlist,
  resolveDaemonStatus,
  readUptime,
  readPid,
  formatUptime,
  LAUNCHD_LABEL,
  DEFAULT_DAEMON_PORT,
  type DaemonStatusProbes,
} from "./launchd";

const TEST_REPO = "/Users/test/Projects/minsky";

describe("launchd plist generation", () => {
  test("generates valid XML with default port", () => {
    const plist = generatePlist({ repoPath: TEST_REPO });
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<true/>");
    expect(plist).toContain("src/cli.ts");
    expect(plist).toContain("--no-dev-chromium");
    expect(plist).toContain(`--port`);
    expect(plist).toContain(String(DEFAULT_DAEMON_PORT));
  });

  test("includes KeepAlive with SuccessfulExit false", () => {
    const plist = generatePlist({ repoPath: TEST_REPO });
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
  });

  test("includes RunAtLoad", () => {
    const plist = generatePlist({ repoPath: TEST_REPO });
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<true/>");
  });

  test("uses custom port when specified", () => {
    const plist = generatePlist({ repoPath: TEST_REPO, port: 4000 });
    expect(plist).toContain("4000");
  });

  test("sets WorkingDirectory to repoPath", () => {
    const plist = generatePlist({ repoPath: "/opt/minsky" });
    expect(plist).toContain("<string>/opt/minsky</string>");
  });

  test("includes log paths under ~/.local/state/minsky/logs/", () => {
    const plist = generatePlist({ repoPath: TEST_REPO });
    expect(plist).toContain("cockpit-stdout.log");
    expect(plist).toContain("cockpit-stderr.log");
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("<key>StandardErrorPath</key>");
  });

  test("ThrottleInterval is 60 seconds (not 5) to avoid crash-loop amplification", () => {
    const plist = generatePlist({ repoPath: TEST_REPO });
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain("<integer>60</integer>");
    // Guard: 5 was the old too-aggressive value that amplified crash-loops (gh#1761).
    expect(plist).not.toContain("<integer>5</integer>");
  });

  test("includes PATH and HOME in EnvironmentVariables", () => {
    const plist = generatePlist({ repoPath: TEST_REPO });
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<key>HOME</key>");
  });

  test("generated daemon plist does NOT contain --watch (watch is a dev affordance, not for supervised daemons)", () => {
    // Guard: --watch + KeepAlive is the crash-loop amplifier that caused 49,650
    // restarts in the gh#1761 incident. This assertion prevents regressions.
    const plist = generatePlist({ repoPath: TEST_REPO });
    expect(plist).not.toContain("--watch");
  });

  test("escapes XML special characters in paths", () => {
    const plist = generatePlist({ repoPath: "/path/with <special> & chars" });
    expect(plist).toContain("&lt;special&gt;");
    expect(plist).toContain("&amp;");
    expect(plist).not.toContain("<special>");
  });
});

describe("resolveDaemonStatus (mt#3682)", () => {
  const PLIST = "/tmp/does-not-matter/com.minsky.cockpit.plist";
  const HEALTH = { uptime: "3h 12m", commit: "abc1234" };

  /**
   * `probes` is passed in rather than patched onto `fs`/`execSync`/`fetch`,
   * which is why the decision was extracted from the IO in the first place
   * (ADR-036 bans in-place patching).
   */
  function probes(overrides: Partial<DaemonStatusProbes> = {}): DaemonStatusProbes {
    return {
      plistExists: () => false,
      launchctlPid: () => null,
      health: async () => null,
      ...overrides,
    };
  }

  test("a serving daemon with no plist reports running, not 'not installed'", async () => {
    // The reproduced defect: a tray-supervised daemon answers on :3737 while
    // `cockpit status` prints "not installed", because the health probe used to
    // sit behind an `installed` early return.
    const status = await resolveDaemonStatus(
      DEFAULT_DAEMON_PORT,
      PLIST,
      probes({ health: async () => HEALTH })
    );

    expect(status.running).toBe(true);
    expect(status.installed).toBe(false);
    expect(status.supervisor).toBe("external");
    expect(status.uptime).toBe(HEALTH.uptime);
    expect(status.commit).toBe(HEALTH.commit);
  });

  test("with no plist and nothing serving, not-running and not-installed are both reported", async () => {
    // The two facts have to be separable: the single `installed`-gated early
    // return could only ever express one of them.
    const status = await resolveDaemonStatus(DEFAULT_DAEMON_PORT, PLIST, probes());

    expect(status.running).toBe(false);
    expect(status.installed).toBe(false);
    expect(status.supervisor).toBeNull();
    expect(status.pid).toBeNull();
  });

  test("launchd is credited only when it is actually holding the process", async () => {
    const underLaunchd = await resolveDaemonStatus(
      DEFAULT_DAEMON_PORT,
      PLIST,
      probes({ plistExists: () => true, launchctlPid: () => 4242, health: async () => HEALTH })
    );
    expect(underLaunchd.supervisor).toBe("launchd");
    expect(underLaunchd.pid).toBe(4242);

    // An agent that is installed but not loaded, beside a port that answers:
    // something else won the bind, which ADR-014's single-owner invariant
    // permits. Crediting launchd here would misreport who to restart.
    const adopted = await resolveDaemonStatus(
      DEFAULT_DAEMON_PORT,
      PLIST,
      probes({ plistExists: () => true, launchctlPid: () => null, health: async () => HEALTH })
    );
    expect(adopted.supervisor).toBe("external");
  });

  test("the launchd-managed path keeps reporting every field it did before", async () => {
    // Regression control: the fix must not degrade the path that already worked.
    const status = await resolveDaemonStatus(
      8080,
      PLIST,
      probes({ plistExists: () => true, launchctlPid: () => 99, health: async () => HEALTH })
    );

    expect(status).toMatchObject({
      installed: true,
      running: true,
      pid: 99,
      port: 8080,
      uptime: HEALTH.uptime,
      commit: HEALTH.commit,
      url: "http://localhost:8080",
      plistPath: PLIST,
    });
  });

  test("an installed-but-not-responding agent still surfaces its launchd pid", async () => {
    const status = await resolveDaemonStatus(
      DEFAULT_DAEMON_PORT,
      PLIST,
      probes({ plistExists: () => true, launchctlPid: () => 77 })
    );

    expect(status.running).toBe(false);
    expect(status.installed).toBe(true);
    expect(status.pid).toBe(77);
    expect(status.supervisor).toBeNull();
  });

  test("uptime is read from the field the health payload actually carries (PR #2744 R1)", () => {
    // The defect this pins: the reader asked for a string `uptime`, while
    // `/api/health` emits a numeric `uptimeSec`. Every healthy daemon reported
    // `uptime: null` beside a correctly-populated `commit` — visible in this
    // PR's own live-verification output before the fix.
    expect(readUptime({ status: "ok", commit: "abc1234", uptimeSec: 11_580 })).toBe("3h 13m");

    // A string `uptime` still wins if a future payload adds one, so the reader
    // cannot be re-broken by the reverse mismatch.
    expect(readUptime({ uptime: "already a string", uptimeSec: 60 })).toBe("already a string");

    // Neither field present, or the wrong type: null rather than a fabricated value.
    expect(readUptime({ status: "ok" })).toBeNull();
    expect(readUptime({ uptimeSec: "3600" })).toBeNull();
  });

  test("formatUptime renders each magnitude, and sub-minute is not blank", () => {
    expect(formatUptime(0)).toBe("<1m");
    expect(formatUptime(59)).toBe("<1m");
    expect(formatUptime(60)).toBe("1m");
    expect(formatUptime(3_600)).toBe("1h");
    expect(formatUptime(90_000)).toBe("1d 1h");
    expect(formatUptime(132_365)).toBe("1d 12h 46m");
  });

  test("launchd is not consulted at all when no agent is installed", async () => {
    let launchctlCalls = 0;
    const status = await resolveDaemonStatus(
      DEFAULT_DAEMON_PORT,
      PLIST,
      probes({
        launchctlPid: () => {
          launchctlCalls++;
          return 1234;
        },
        health: async () => HEALTH,
      })
    );

    expect(launchctlCalls).toBe(0);
    expect(status.pid).toBeNull();
  });

  test("a tray-supervised daemon reports the pid health gave it (mt#4232)", async () => {
    // The earmark this discharges: launchctl was the only pid source, so
    // `cockpit status` printed a blank pid for every daemon launchd did not
    // hold — which is the DEFAULT setup under ADR-014.
    const status = await resolveDaemonStatus(
      DEFAULT_DAEMON_PORT,
      PLIST,
      probes({ health: async () => ({ ...HEALTH, pid: 5150 }) })
    );

    expect(status.pid).toBe(5150);
    expect(status.supervisor).toBe("external");
  });

  test("health's pid does NOT make launchd the credited supervisor (mt#4232)", async () => {
    // `pid` is present under BOTH supervisors, so deciding `supervisor` from the
    // merged field would credit launchd for every serving daemon. The
    // discriminator stays launchctl's own record.
    const status = await resolveDaemonStatus(
      DEFAULT_DAEMON_PORT,
      PLIST,
      probes({ plistExists: () => true, health: async () => ({ ...HEALTH, pid: 5150 }) })
    );

    expect(status.pid).toBe(5150);
    expect(status.supervisor).toBe("external");
  });

  test("launchctl's pid outranks health's when both are present (mt#4232)", async () => {
    const status = await resolveDaemonStatus(
      DEFAULT_DAEMON_PORT,
      PLIST,
      probes({
        plistExists: () => true,
        launchctlPid: () => 4242,
        health: async () => ({ ...HEALTH, pid: 5150 }),
      })
    );

    expect(status.pid).toBe(4242);
    expect(status.supervisor).toBe("launchd");
  });

  test("readPid accepts a real pid and rejects everything that is not one (mt#4232)", () => {
    expect(readPid({ pid: 5150 })).toBe(5150);

    // A daemon predating the field. Null, not a guess — the caller falls back to
    // resolving the pid from the port.
    expect(readPid({ status: "ok" })).toBeNull();

    // Values that are `typeof "number"` and still not pids. `process.kill` on
    // one of these throws rather than returning something reportable, so they
    // are rejected here instead.
    expect(readPid({ pid: Number.NaN })).toBeNull();
    expect(readPid({ pid: Number.POSITIVE_INFINITY })).toBeNull();
    expect(readPid({ pid: 12.5 })).toBeNull();
    expect(readPid({ pid: 0 })).toBeNull();
    expect(readPid({ pid: -1 })).toBeNull();
    expect(readPid({ pid: "5150" })).toBeNull();
  });
});
