import { describe, it, expect, afterEach } from "bun:test";
import { sharedCommandRegistry, CommandCategory } from "../command-registry";

/**
 * These tests verify that:
 * 1. The observability category exists on CommandCategory
 * 2. registerObservabilityCommands() registers `observability.smoke-test`
 *
 * The "missing apiKey" path is not covered by a unit test here because
 * `mock.module(...)` persists across test files in bun:test (no per-file
 * unmock), and replacing the configuration module would poison other
 * tests that import it later. The error path is covered end-to-end by
 * running the CLI against a project with no key configured:
 *   `bun ./scripts/cli-entry.ts observability smoke-test`
 */

describe("observability commands", () => {
  afterEach(() => {
    sharedCommandRegistry.unregisterCommand("observability.smoke-test");
  });

  it("CommandCategory.OBSERVABILITY exists", () => {
    expect(String(CommandCategory.OBSERVABILITY)).toBe("OBSERVABILITY");
  });

  it("registerObservabilityCommands registers observability.smoke-test", async () => {
    const { registerObservabilityCommands } = await import("./observability");
    registerObservabilityCommands();

    const cmd = sharedCommandRegistry.getCommand("observability.smoke-test");
    expect(cmd).toBeDefined();
    expect(cmd?.category).toBe(CommandCategory.OBSERVABILITY);
    expect(cmd?.name).toBe("smoke-test");
    expect(cmd?.description).toContain("Braintrust");
  });
});
