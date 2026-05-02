import { describe, test, expect, beforeEach } from "bun:test";
import { createSharedCommandRegistry, CommandCategory } from "../../command-registry";
import { registerTranscriptSimilarCommand } from "./similar-command";
import type { AppContainerInterface } from "../../../../composition/types";

const COMMAND_ID = "transcripts.similar";

/**
 * Minimal subset of {@link AppContainerInterface} actually exercised by the
 * command's execute() path — only `has()` and `get()` are read. Defining a
 * proper subset type rather than casting through `unknown` keeps test seams
 * type-checked (per `feedback_no_test_only_casts`).
 */
type ContainerSubset = Pick<AppContainerInterface, "has" | "get">;

describe("transcripts.similar command", () => {
  let registry: ReturnType<typeof createSharedCommandRegistry>;

  beforeEach(() => {
    registry = createSharedCommandRegistry();
    registerTranscriptSimilarCommand(undefined, registry);
  });

  function getCommand() {
    const command = registry.getCommand(COMMAND_ID);
    if (!command) {
      throw new Error(`${COMMAND_ID} should be registered`);
    }
    return command;
  }

  describe("registration", () => {
    test(`registers under id ${COMMAND_ID}`, () => {
      const command = getCommand();
      expect(command.name).toBe("similar");
      expect(command.category).toBe(CommandCategory.TRANSCRIPTS);
    });

    test("description mentions turnId and sessionId", () => {
      const command = getCommand();
      expect(command.description).toContain("turnId");
      expect(command.description).toContain("sessionId");
    });

    test("declares turnId, sessionId, and limit parameters", () => {
      const command = getCommand();
      const params = command.parameters as Record<string, unknown>;
      expect(params.turnId).toBeDefined();
      expect(params.sessionId).toBeDefined();
      expect(params.limit).toBeDefined();
    });

    test("limit defaults to 10; turnId and sessionId have no default", () => {
      const command = getCommand();
      const params = command.parameters as Record<string, { defaultValue?: unknown } | undefined>;
      expect(params.limit?.defaultValue).toBe(10);
      expect(params.turnId?.defaultValue).toBeUndefined();
      expect(params.sessionId?.defaultValue).toBeUndefined();
    });
  });

  describe("scope-routing validation", () => {
    test("throws when neither turnId nor sessionId is provided", async () => {
      const minimalContext = { interface: "cli" as const };
      await expect(getCommand().execute({}, minimalContext)).rejects.toThrow(
        /requires exactly one of --turnId or --sessionId/
      );
    });

    test("throws when both turnId and sessionId are provided", async () => {
      const minimalContext = { interface: "cli" as const };
      await expect(
        getCommand().execute(
          { turnId: "abc-session:1", sessionId: "def-session-uuid" },
          minimalContext
        )
      ).rejects.toThrow(/only one of --turnId or --sessionId/);
    });

    test("validation message for missing args guides toward --turnId and --sessionId", async () => {
      const minimalContext = { interface: "cli" as const };
      await expect(getCommand().execute({}, minimalContext)).rejects.toThrow(/--turnId/);
    });
  });

  describe("DI guard", () => {
    test("throws when DI container is missing 'persistence' (turnId path)", async () => {
      // Validation passes (turnId is set), but the container has no persistence binding.
      const containerWithoutPersistence: ContainerSubset = {
        has: (_key: string) => false,
        get: (_key: string) => {
          throw new Error("not bound");
        },
      };
      const ctx = {
        interface: "cli" as const,
        container: containerWithoutPersistence as AppContainerInterface,
      };
      await expect(getCommand().execute({ turnId: "some-session:0" }, ctx)).rejects.toThrow(
        /persistence/
      );
    });

    test("throws when DI container is missing 'persistence' (sessionId path)", async () => {
      const containerWithoutPersistence: ContainerSubset = {
        has: (_key: string) => false,
        get: (_key: string) => {
          throw new Error("not bound");
        },
      };
      const ctx = {
        interface: "cli" as const,
        container: containerWithoutPersistence as AppContainerInterface,
      };
      await expect(getCommand().execute({ sessionId: "some-session-uuid" }, ctx)).rejects.toThrow(
        /persistence/
      );
    });
  });
});
