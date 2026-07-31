/**
 * Registration-level regression guard for mt#2727.
 *
 * Exercises the real (non-mocked) registerXCommands() functions to confirm
 * every ai.* command id from the bug report is actually wired into the
 * shared command registry under CommandCategory.AI. This doesn't call
 * execute() (that needs live service-factory wiring, out of scope for a
 * mock.module()-free unit test — see result-builders.test.ts for the
 * return-shape regression guard), but it does guard against a command
 * silently failing to register or being registered under the wrong id.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { sharedCommandRegistry, CommandCategory } from "../../command-registry";

const AI_COMMAND_IDS = [
  "ai.validate",
  "ai.providers.list",
  "ai.complete",
  "ai.fast-apply",
  "ai.chat",
  "ai.models.available",
  "ai.models.refresh",
  "ai.models.list",
  "ai.cache.clear",
];

describe("ai.* command registration", () => {
  afterEach(() => {
    for (const id of AI_COMMAND_IDS) {
      sharedCommandRegistry.unregisterCommand(id);
    }
  });

  it("registers every ai.* command id under CommandCategory.AI", async () => {
    const { registerProviderCommands } = await import("./provider-commands");
    const { registerCompletionCommands } = await import("./completion-commands");
    const { registerModelCacheCommands } = await import("./model-cache-commands");

    registerProviderCommands();
    registerCompletionCommands();
    registerModelCacheCommands();

    for (const id of AI_COMMAND_IDS) {
      const cmd = sharedCommandRegistry.getCommand(id);
      expect(cmd).toBeDefined();
      expect(cmd?.category).toBe(CommandCategory.AI);
      expect(typeof cmd?.execute).toBe("function");
    }
  });
});
