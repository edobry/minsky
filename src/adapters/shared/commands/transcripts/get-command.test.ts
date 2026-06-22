import { describe, test, expect, beforeEach } from "bun:test";
import { createSharedCommandRegistry, CommandCategory } from "../../command-registry";
import { registerTranscriptGetCommand } from "./get-command";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

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

    test("declares conversationId (canonical), sessionId (deprecated alias), and turnRange", () => {
      const command = getCommand();
      const params = command.parameters as Record<string, unknown>;
      expect(params.conversationId).toBeDefined();
      expect(params.sessionId).toBeDefined(); // back-compat alias (mt#2526)
      expect(params.turnRange).toBeDefined();
    });

    test("conversation id is required at runtime (not a schema flag); turnRange optional", () => {
      const command = getCommand();
      const params = command.parameters as Record<
        string,
        { required?: boolean; defaultValue?: unknown } | undefined
      >;
      // Required-ness is enforced at execute time (resolveConversationId) so the
      // deprecated sessionId alias still satisfies it — neither key is schema-required.
      expect(params.conversationId?.required).toBeFalsy();
      expect(params.sessionId?.required).toBeFalsy();
      expect(params.turnRange?.required).toBeFalsy();
      expect(params.turnRange?.defaultValue).toBeUndefined();
    });

    test("execute throws when neither conversationId nor sessionId is provided", async () => {
      const minimalContext = { interface: "cli" as const };
      await expect(getCommand().execute({}, minimalContext)).rejects.toThrow(
        /requires conversationId/
      );
    });

    test("conversationId (canonical) and sessionId (alias) both resolve past to the DI guard", async () => {
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
      // Both keys get past resolution to the DI guard — proving the alias is honored.
      await expect(getCommand().execute({ conversationId: "conv-abc" }, ctx)).rejects.toThrow(
        /persistence/
      );
      await expect(getCommand().execute({ sessionId: "conv-abc" }, ctx)).rejects.toThrow(
        /persistence/
      );
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
