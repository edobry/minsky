/**
 * Regression test for mt#2702: `config set` / `config unset` must not echo a
 * credential value back to stdout.
 *
 * Exercises the real binary (bun src/cli.ts) against a throwaway
 * XDG_CONFIG_HOME rather than unit-testing the masking helper. The helper
 * (`maskValueForPath`) already had coverage and already worked — the defect
 * was that the write path never CALLED it, which only a test of the real
 * wiring can see. Spawning also covers the two render branches together: the
 * registered formatter and the --json branch that stringifies the payload.
 *
 * The fake secrets below are literals invented for this test. Assertions are
 * on their ABSENCE, so the test fails open (a leak makes it red) rather than
 * depending on the exact mask sentinel.
 */
/* eslint-disable custom/no-real-fs-in-tests -- spawn-based CLI test needs a real config dir on disk; a mocked fs is not visible to the subprocess */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const FAKE_SECRET = "mt2702-fake-token-do-not-use-9z9z9z";
const FAKE_PRIOR_SECRET = "mt2702-fake-prior-token-1a1a1a";

describe("config write-echo credential masking (mt#2702)", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "mt2702-test-"));
    mkdirSync(join(tmpHome, "minsky"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function runCli(args: string[]): { combined: string; status: number } {
    const result = spawnSync("bun", ["run", "src/cli.ts", ...args], {
      env: { ...process.env, XDG_CONFIG_HOME: tmpHome },
      encoding: "utf8",
      timeout: 60000,
    });
    return {
      combined: (result.stdout ?? "") + (result.stderr ?? ""),
      status: result.status ?? -1,
    };
  }

  /** Seed a config that already holds a credential, so unset has one to echo. */
  function seedExistingToken(): void {
    writeFileSync(
      join(tmpHome, "minsky", "config.yaml"),
      `version: 1\nmcp:\n  auth:\n    token: ${FAKE_PRIOR_SECRET}\n`
    );
  }

  test("AT1: set on a credential key does not echo the value", () => {
    seedExistingToken();

    const { combined, status } = runCli(["config", "set", "mcp.auth.token", FAKE_SECRET]);

    expect(status).toBe(0);
    // The key is still named, so the confirmation stays useful.
    expect(combined).toContain("mcp.auth.token");
    // Neither the value written nor the one it replaced may appear.
    expect(combined).not.toContain(FAKE_SECRET);
    expect(combined).not.toContain(FAKE_PRIOR_SECRET);
  });

  test("AT2: set on a non-credential key still echoes the value in full", () => {
    // The spec's AT2 named `tasks.defaultBackend`, which no longer exists in
    // the config schema (`tasksConfigSchema` is a strictObject; setting it
    // fails validation). `tasks.strictIds` is the closest live non-credential
    // key. Asserting the whole rendered line rather than the bare value keeps
    // this from passing on an incidental "true" elsewhere in the output.
    const { combined, status } = runCli(["config", "set", "tasks.strictIds", "true"]);

    expect(status).toBe(0);
    // No UX regression for ordinary settings — the value is still shown.
    expect(combined).toContain("tasks.strictIds = true");
  });

  test("AT3: --json carries only the masked form (the payload MCP returns)", () => {
    seedExistingToken();

    // The --json branch is `JSON.stringify(result)` over the same object the
    // command's execute returns, which is the object the MCP adapter serializes
    // into its tool result. Asserting here covers both callers.
    const { combined, status } = runCli(["config", "set", "mcp.auth.token", FAKE_SECRET, "--json"]);

    expect(status).toBe(0);
    expect(combined).not.toContain(FAKE_SECRET);
    expect(combined).not.toContain(FAKE_PRIOR_SECRET);
    // newValue/previousValue are present as keys — masked, not dropped.
    expect(combined).toContain("newValue");
  });

  test("unset on a credential key does not echo the removed value", () => {
    seedExistingToken();

    const { combined, status } = runCli(["config", "unset", "mcp.auth.token", "--json"]);

    expect(status).toBe(0);
    expect(combined).not.toContain(FAKE_PRIOR_SECRET);
  });
});
