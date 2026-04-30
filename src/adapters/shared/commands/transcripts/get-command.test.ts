import { describe, test, expect, beforeEach } from "bun:test";
import { createSharedCommandRegistry, CommandCategory } from "../../command-registry";
import { registerTranscriptGetCommand } from "./get-command";
import type { AppContainerInterface } from "../../../../composition/types";

const COMMAND_ID = "transcripts.get";

/**
 * Minimal subset of {@link AppContainerInterface} actually exercised by the
 * command's execute() path — only `has()` and `get()` are read. Defining a
 * proper subset type rather than casting through `unknown` keeps test seams
 * type-checked (per `feedback_no_test_only_casts`).
 */
type ContainerSubset = Pick<AppContainerInterface, "has" | "get">;

describe("transcripts.get command", () => {
  let registry: ReturnType<typeof createSharedCommandRegistry>;

  beforeEach(() => {
    registry = createSharedCommandRegistry();
    registerTranscriptGetCommand(undefined, registry);
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
      expect(command.name).toBe("get");
      expect(command.category).toBe(CommandCategory.TRANSCRIPTS);
    });

    test("description mentions turn_index order and turn range", () => {
      const command = getCommand();
      expect(command.description).toContain("turn_index");
      expect(command.description).toContain("turn range");
    });

    test("declares sessionId and turnRange parameters", () => {
      const command = getCommand();
      const params = command.parameters as Record<string, unknown>;
      expect(params.sessionId).toBeDefined();
      expect(params.turnRange).toBeDefined();
    });

    test("sessionId is required; turnRange is optional with no default", () => {
      const command = getCommand();
      const params = command.parameters as Record<
        string,
        { required?: boolean; defaultValue?: unknown } | undefined
      >;
      expect(params.sessionId?.required).toBe(true);
      expect(params.turnRange?.required).toBeFalsy();
      expect(params.turnRange?.defaultValue).toBeUndefined();
    });
  });

  describe("DI guard", () => {
    test("throws when DI container is missing 'persistence'", async () => {
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
      await expect(getCommand().execute({ sessionId: "session-abc" }, ctx)).rejects.toThrow(
        /persistence/
      );
    });
  });

  describe("turnRange parsing", () => {
    test("throws on invalid turnRange format before hitting persistence", async () => {
      // We pass a container that claims to have persistence but returns null
      // from getDatabaseConnection. The turnRange parse error should fire first.
      // Cast through unknown to satisfy the generic AppContainerInterface signature.
      const containerWithPersistence = {
        has: (_key: string) => true,
        get: (_key: string) => ({ getDatabaseConnection: async () => null }),
      } as unknown as AppContainerInterface;
      const ctx = {
        interface: "cli" as const,
        container: containerWithPersistence,
      };
      await expect(
        getCommand().execute({ sessionId: "session-abc", turnRange: "bad-range" }, ctx)
      ).rejects.toThrow(/turnRange|start-end|Invalid/i);
    });
  });
});
