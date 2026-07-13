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

  test("unknown top-level key: warns but does not crash (mt#2161)", () => {
    writeFileSync(
      join(tmpHome, "minsky", "config.yaml"),
      "version: 1\nbackendConfig: {}\ntotallyUnknownKey:\n  someNested: value\n"
    );

    const { stdout, stderr, status } = runCli(["config", "get", "version"]);
    const combined = stdout + stderr;

    // mt#2161: unknown top-level keys are warned, not fatal. The CLI should
    // start successfully and serve the config get request.
    expect(status).toBe(0);

    // The warning should name the unknown key
    expect(combined).toContain("totallyUnknownKey");
    expect(combined).toContain("Unrecognized");

    // Should NOT crash with stack traces or cascade artifacts
    expect(combined).not.toContain("uncaughtException");
    expect(combined).not.toContain("memoryUsage");
    expect(combined).not.toContain("processTicksAndRejections");
  });

  test("valid config: no error rendering, command runs normally", () => {
    // No config file at all → loader treats it as no-config (valid).
    const { status } = runCli(["--version"]);
    // --version exits 0 from commander
    expect(status).toBe(0);
  });

  test("STRUCTURED mode + LOGLEVEL=debug: unknown key warns, no crash (mt#2161 + PR #1090 R1 guard)", () => {
    writeFileSync(
      join(tmpHome, "minsky", "config.yaml"),
      "version: 1\nbackendConfig: {}\nrogueKey: value\n"
    );

    const result = spawnSync("bun", ["run", "src/cli.ts", "config", "get", "version"], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: tmpHome,
        MINSKY_LOG_MODE: "STRUCTURED",
        LOGLEVEL: "debug",
      },
      encoding: "utf8",
      timeout: 15000,
    });
    const combined = (result.stdout ?? "") + (result.stderr ?? "");

    // mt#2161: warn-and-continue, not crash
    expect(result.status).toBe(0);
    expect(combined).toContain("rogueKey");
    // No cascade artifacts:
    expect(combined).not.toContain("CustomConfigurationProvider.initialize failed");
    expect(combined).not.toContain("uncaughtException");
    expect(combined).not.toContain("memoryUsage");
  });
});
