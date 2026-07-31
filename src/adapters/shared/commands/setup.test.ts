/**
 * Tests for the `setup` shared command's DB-connection inheritance (mt#2502).
 *
 * Hermetic: injects a mock `performSetup` + `runInteractiveSetupDb` (both defined as
 * `SetupCommandDeps`) so no filesystem, config loader, terminal prompt, or live database
 * is touched. Covers the three scenarios named in the mt#2502 spec: resolve-and-reuse,
 * nothing-resolves (wizard fallback), and idempotent re-run (wizard invoked only once
 * across two consecutive `setup` calls once a connection has been written).
 */

import { describe, test, expect } from "bun:test";
import { setupTestMocks } from "../../../utils/test-utils/mocking";
import { sharedCommandRegistry } from "../command-registry";
import { registerSetupCommands, type SetupCommandDeps } from "./setup";
import type { SetupResult } from "@minsky/domain/setup";

setupTestMocks();

const BASE_RESULT: Omit<SetupResult, "dbConnection"> = {
  success: true,
  localConfigPath: "/mock/repo/.minsky/config.local.yaml",
  harnessConfigPath: "/mock/repo/.cursor/mcp.json",
  client: "cursor",
  message: "Setup complete.",
};

const WIZARD_SUCCESS_MESSAGE = "Postgres configured via wizard.";

function registerWithDeps(overrides: SetupCommandDeps): void {
  registerSetupCommands(overrides);
}

type RunCommandResult = { success: boolean; message: string };

async function runCommand(params: Record<string, unknown> = {}): Promise<RunCommandResult> {
  const cmd = sharedCommandRegistry.getCommand("setup");
  if (!cmd) throw new Error("setup command not registered");
  return (await cmd.execute(
    { client: "cursor", skipAgentSettings: true, ...params },
    {}
  )) as RunCommandResult;
}

describe("setup command — DB-connection inheritance (mt#2502)", () => {
  test("resolves-and-reuses: prints the source, verifies connectivity, skips the wizard", async () => {
    let wizardCalls = 0;
    registerWithDeps({
      performSetup: async () => ({
        ...BASE_RESULT,
        dbConnection: {
          found: true,
          connectionString: "postgresql://user:pass@host:5432/db",
          source: "user config (~/.config/minsky/config.yaml)",
          sourceName: "user",
          connectivity: { ok: true },
        },
      }),
      runInteractiveSetupDb: async () => {
        wizardCalls += 1;
        return { success: true, message: "wizard ran" };
      },
    });

    const result = await runCommand();

    expect(result.success).toBe(true);
    expect(result.message).toContain("Using existing Postgres connection from user config");
    expect(wizardCalls).toBe(0);
  });

  test("nothing resolves: falls into the interactive setup db wizard", async () => {
    let wizardCalls = 0;
    let wizardParams: unknown;
    registerWithDeps({
      performSetup: async () => ({
        ...BASE_RESULT,
        dbConnection: { found: false },
      }),
      runInteractiveSetupDb: async (options) => {
        wizardCalls += 1;
        wizardParams = options;
        return { success: true, message: WIZARD_SUCCESS_MESSAGE };
      },
    });

    const result = await runCommand({ connectionString: "postgresql://a:b@c:5432/d", yes: true });

    expect(wizardCalls).toBe(1);
    expect(wizardParams).toEqual({
      connectionString: "postgresql://a:b@c:5432/d",
      yes: true,
    });
    expect(result.message).toContain(WIZARD_SUCCESS_MESSAGE);
  });

  test("resolved connection fails connectivity: falls back to the wizard with a diagnostic", async () => {
    let wizardCalls = 0;
    registerWithDeps({
      performSetup: async () => ({
        ...BASE_RESULT,
        dbConnection: {
          found: true,
          connectionString: "postgresql://user:pass@stale-host:5432/db",
          source: "repo config (.minsky/config.yaml)",
          sourceName: "project",
          connectivity: { ok: false, error: "ECONNREFUSED" },
        },
      }),
      runInteractiveSetupDb: async () => {
        wizardCalls += 1;
        return { success: true, message: WIZARD_SUCCESS_MESSAGE };
      },
    });

    const result = await runCommand();

    expect(wizardCalls).toBe(1);
    expect(result.message).toContain("repo config");
    expect(result.message).toContain("ECONNREFUSED");
    expect(result.message).toContain(WIZARD_SUCCESS_MESSAGE);
  });

  test("idempotent re-run: the wizard only fires once across two consecutive setup calls", async () => {
    let wizardCalls = 0;
    let configWritten = false;

    registerWithDeps({
      performSetup: async () => ({
        ...BASE_RESULT,
        dbConnection: configWritten
          ? {
              found: true,
              connectionString: "postgresql://user:pass@host:5432/db",
              source: "user config (~/.config/minsky/config.yaml)",
              sourceName: "user",
              connectivity: { ok: true },
            }
          : { found: false },
      }),
      runInteractiveSetupDb: async () => {
        wizardCalls += 1;
        // Simulate the wizard having written the connection to user config, which the
        // NEXT `setup` invocation's config-loader resolution would now pick up.
        configWritten = true;
        return { success: true, message: WIZARD_SUCCESS_MESSAGE };
      },
    });

    const first = await runCommand();
    const second = await runCommand();

    expect(wizardCalls).toBe(1);
    expect(first.message).toContain(WIZARD_SUCCESS_MESSAGE);
    expect(second.message).toContain("Using existing Postgres connection from user config");
  });
});
