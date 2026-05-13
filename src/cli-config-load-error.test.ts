/**
 * Integration regression test for mt#1801: config-load schema-validation
 * failure renders cleanly, not with the prior 3x logging + stack + process
 * metadata cascade.
 *
 * Exercises the actual binary (bun src/cli.ts) so the test asserts on the
 * full CLI output path: loader.ts → ConfigValidationError → cli.ts boundary
 * catch → process.exit(1). A pure-unit test would not catch a regression in
 * the boundary-catch wiring at cli.ts itself.
 */
/* eslint-disable custom/no-real-fs-in-tests -- spawn-based CLI test requires a real config file on disk; mock-fs would not be visible to the subprocess */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("CLI config-load error rendering (mt#1801)", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "mt1801-test-"));
    mkdirSync(join(tmpHome, "minsky"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
    const result = spawnSync("bun", ["run", "src/cli.ts", ...args], {
      env: { ...process.env, XDG_CONFIG_HOME: tmpHome },
      encoding: "utf8",
      timeout: 15000,
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status ?? -1,
    };
  }

  test("unknown top-level key: clean 2-line error, exit 1, no stack trace, no metadata dump", () => {
    writeFileSync(
      join(tmpHome, "minsky", "config.yaml"),
      "version: 1\nbackendConfig: {}\ntotallyUnknownKey:\n  someNested: value\n"
    );

    const { stdout, stderr, status } = runCli(["config", "get", "totallyUnknownKey.someNested"]);
    const combined = stdout + stderr;

    // Non-zero exit
    expect(status).toBe(1);

    // Unknown key name surfaces clearly
    expect(combined).toContain("totallyUnknownKey");

    // Specifically NOT the noisy cascade artifacts the prior code emitted:
    expect(combined).not.toContain("uncaughtException");
    expect(combined).not.toContain("memoryUsage");
    expect(combined).not.toContain("loadavg");
    expect(combined).not.toContain("processTicksAndRejections");
    expect(combined).not.toContain("✗ Failed to initialize configuration system");
    // Should not double-print the cause; "Configuration loading failed" must
    // appear at most once. (Pre-mt#1801 it appeared 3-6 times.)
    const cascadeMatches = combined.match(/Configuration (loading|validation) failed/g) ?? [];
    expect(cascadeMatches.length).toBeLessThanOrEqual(1);

    // And the output should be short — a couple of human-readable lines,
    // not a stack-trace dump. Allow up to 5 lines for the cause + hint +
    // safety margin if Bun adds a startup-warning line in the future.
    const lineCount = combined.split("\n").filter((l) => l.trim().length > 0).length;
    expect(lineCount).toBeLessThanOrEqual(5);
  });

  test("valid config: no error rendering, command runs normally", () => {
    // No config file at all → loader treats it as no-config (valid).
    const { status } = runCli(["--version"]);
    // --version exits 0 from commander
    expect(status).toBe(0);
  });
});
