import { describe, test, expect, beforeEach } from "bun:test";
import { createSharedCommandRegistry, CommandCategory } from "../../command-registry";
import { registerTranscriptSpawnsExtractCommand } from "./spawns-extract-command";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

const COMMAND_ID = "transcripts.spawns-extract";

/**
 * Minimal subset of {@link AppContainerInterface} actually exercised by the
 * command's execute() path — only `has()` and `get()` are read. Defining a
 * proper subset type rather than casting through `unknown` keeps test seams
 * type-checked (per `feedback_no_test_only_casts`).
 */
type ContainerSubset = Pick<AppContainerInterface, "has" | "get">;

describe("transcripts.spawns-extract command", () => {
  let registry: ReturnType<typeof createSharedCommandRegistry>;

  beforeEach(() => {
    registry = createSharedCommandRegistry();
    registerTranscriptSpawnsExtractCommand(undefined, registry);
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
      expect(command.name).toBe("spawns-extract");
      expect(command.category).toBe(CommandCategory.TRANSCRIPTS);
    });

    test("description mentions spawn extraction", () => {
      const command = getCommand();
      expect(command.description).toContain("spawn");
      expect(command.description).toContain("agent_spawns");
    });

    test("declares all and session parameters", () => {
      const command = getCommand();
      const params = command.parameters as Record<string, { defaultValue?: unknown }>;
      expect(params.all).toBeDefined();
      expect(params.session).toBeDefined();
    });

    test("all defaults to false; session has no default", () => {
      const command = getCommand();
      const params = command.parameters as Record<string, { defaultValue?: unknown } | undefined>;
      expect(params.all?.defaultValue).toBe(false);
      expect(params.session?.defaultValue).toBeUndefined();
    });
  });

  describe("scope-routing validation", () => {
    test("throws when neither --all nor --session is provided", async () => {
      // The validation gate runs before any DI container access, so we can
      // pass an empty context and assert the validation error fires first.
      const minimalContext = { interface: "cli" as const };
      await expect(getCommand().execute({}, minimalContext)).rejects.toThrow(
        /requires either --all or --session/
      );
    });

    test("validation message guides toward --all for sweeps", async () => {
      const minimalContext = { interface: "cli" as const };
      await expect(getCommand().execute({}, minimalContext)).rejects.toThrow(/--all/);
    });
  });

  describe("DI guard", () => {
    test("throws when DI container is missing 'persistence'", async () => {
      // Validation passes (--all is set), but the container has no persistence
      // binding. The DI guard must surface this with a clear message rather
      // than failing silently or throwing a generic null-deref.
      // The command only reads .has()/.get() from the container; ContainerSubset
      // narrows the test seam to those two members rather than constructing a
      // full AppContainerInterface stub.
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
      await expect(getCommand().execute({ all: true }, ctx)).rejects.toThrow(/persistence/);
    });
  });
});
