import { describe, test, expect, beforeEach } from "bun:test";
import { createSharedCommandRegistry, CommandCategory } from "../../command-registry";
import { registerTranscriptListCommand } from "./list-command";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

const COMMAND_ID = "transcripts.list";

/**
 * Minimal subset of {@link AppContainerInterface} actually exercised by the
 * command's execute() path — mirrors get-command.test.ts's ContainerSubset.
 */
type ContainerSubset = Pick<AppContainerInterface, "has" | "get">;

describe("transcripts.list command", () => {
  let registry: ReturnType<typeof createSharedCommandRegistry>;

  beforeEach(() => {
    registry = createSharedCommandRegistry();
    registerTranscriptListCommand(undefined, registry);
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
      expect(command.name).toBe("list");
      expect(command.category).toBe(CommandCategory.TRANSCRIPTS);
    });

    test("description mentions truncation metadata and zero-disk-access default", () => {
      const command = getCommand();
      expect(command.description).toContain("returned");
      expect(command.description).toContain("checkDiskCoverage");
    });

    test("declares limit and checkDiskCoverage params, both optional", () => {
      const command = getCommand();
      const params = command.parameters as Record<
        string,
        { required?: boolean; defaultValue?: unknown } | undefined
      >;
      expect(params.limit).toBeDefined();
      expect(params.limit?.required).toBeFalsy();
      expect(params.checkDiskCoverage).toBeDefined();
      expect(params.checkDiskCoverage?.required).toBeFalsy();
      expect(params.checkDiskCoverage?.defaultValue).toBe(false);
    });
  });

  describe("DI guard", () => {
    test("throws when DI container is missing 'persistence'", async () => {
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
      await expect(getCommand().execute({}, ctx)).rejects.toThrow(/persistence/);
    });

    test("throws when getDatabaseConnection() returns null", async () => {
      const containerWithPersistence = {
        has: (_key: string) => true,
        get: (_key: string) => ({ getDatabaseConnection: async () => null }),
      } as unknown as AppContainerInterface;
      const ctx = {
        interface: "cli" as const,
        container: containerWithPersistence,
      };
      await expect(getCommand().execute({}, ctx)).rejects.toThrow(
        /getDatabaseConnection\(\) returned null/
      );
    });
  });
});
