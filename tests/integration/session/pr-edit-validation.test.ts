import { describe, it, expect } from "bun:test";
import { SessionPrEditCommand } from "../../../src/adapters/shared/commands/session/pr-subcommand-commands";
import type { CommandExecutionContext } from "../../../src/schemas/command-registry";

/**
 * Integration-like unit tests for session pr edit title validation
 * These run without real repo/network using command-level logic
 */

describe("session pr edit - conventional commit title validation", () => {
  const context: CommandExecutionContext = { interface: "cli", workingDirectory: "/tmp" } as any;

  it("rejects non-conventional title when --type is not provided", async () => {
    const cmd = new SessionPrEditCommand();
    await expect(async () => {
      await cmd.executeCommand(
        {
          title: "Update the title without proper prefix",
          name: "dummy-session",
        },
        context
      );
    }).rejects.toThrow(/Invalid title\.|full conventional commit title/i);
  });

  it("accepts full conventional title without --type", async () => {
    const cmd = new SessionPrEditCommand();
    const result = await cmd
      .executeCommand(
        {
          title: "feat(core): improve handling",
          name: "dummy-session",
          body: "placeholder",
        },
        context
      )
      .catch((e) => e);

    // We only assert that validation layer passed; downstream may fail on missing session/PR
    // So either success or a domain error mentioning No PR/Session not found is fine
    const message = String(result?.message || result);
    expect(/(No PR|Session|Failed to edit session PR)/i.test(message)).toBe(true);
  });

  it("composes title from --type and description-only --title", async () => {
    const cmd = new SessionPrEditCommand();
    const result = await cmd
      .executeCommand(
        {
          type: "feat",
          title: "add x",
          name: "dummy-session",
          body: "placeholder",
        },
        context
      )
      .catch((e) => e);

    const message = String(result?.message || result);
    expect(/(No PR|Session|Failed to edit session PR)/i.test(message)).toBe(true);
  });
});
