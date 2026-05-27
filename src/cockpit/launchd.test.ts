import { describe, test, expect } from "bun:test";
import { generatePlist, LAUNCHD_LABEL, DEFAULT_DAEMON_PORT } from "./launchd";

describe("launchd plist generation", () => {
  test("generates valid XML with default options", () => {
    const plist = generatePlist();
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<true/>");
    expect(plist).toContain("--no-dev-chromium");
    expect(plist).toContain(`--port`);
    expect(plist).toContain(String(DEFAULT_DAEMON_PORT));
  });

  test("includes KeepAlive with SuccessfulExit false", () => {
    const plist = generatePlist();
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
  });

  test("includes RunAtLoad", () => {
    const plist = generatePlist();
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<true/>");
  });

  test("uses custom port when specified", () => {
    const plist = generatePlist({ port: 4000 });
    expect(plist).toContain("4000");
  });

  test("sets WorkingDirectory to repoPath when specified", () => {
    const plist = generatePlist({ repoPath: "/opt/minsky" });
    expect(plist).toContain("<string>/opt/minsky</string>");
  });

  test("includes log paths under ~/.local/state/minsky/logs/", () => {
    const plist = generatePlist();
    expect(plist).toContain("cockpit-stdout.log");
    expect(plist).toContain("cockpit-stderr.log");
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("<key>StandardErrorPath</key>");
  });

  test("includes ThrottleInterval", () => {
    const plist = generatePlist();
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain("<integer>5</integer>");
  });

  test("includes PATH and HOME in EnvironmentVariables", () => {
    const plist = generatePlist();
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<key>HOME</key>");
  });

  test("escapes XML special characters in paths", () => {
    const plist = generatePlist({ repoPath: "/path/with <special> & chars" });
    expect(plist).toContain("&lt;special&gt;");
    expect(plist).toContain("&amp;");
    expect(plist).not.toContain("<special>");
  });
});
