import { describe, test, expect } from "bun:test";
import { generatePlist, LAUNCHD_LABEL, DEFAULT_DAEMON_PORT } from "./launchd";

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
