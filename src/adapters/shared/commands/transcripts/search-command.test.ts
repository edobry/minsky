import { describe, test, expect, beforeEach } from "bun:test";
import { createSharedCommandRegistry, CommandCategory } from "../../command-registry";
import { registerTranscriptSearchCommand } from "./search-command";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

const COMMAND_ID = "transcripts.search";

/**
 * Minimal subset of {@link AppContainerInterface} actually exercised by the
 * command's execute() path — only `has()` and `get()` are read. Defining a
 * proper subset type rather than casting through `unknown` keeps test seams
 * type-checked (per `feedback_no_test_only_casts`).
 */
type ContainerSubset = Pick<AppContainerInterface, "has" | "get">;

describe("transcripts.search command", () => {
  let registry: ReturnType<typeof createSharedCommandRegistry>;

  beforeEach(() => {
    registry = createSharedCommandRegistry();
    registerTranscriptSearchCommand(undefined, registry);
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
      expect(command.name).toBe("search");
      expect(command.category).toBe(CommandCategory.TRANSCRIPTS);
    });

    test("description mentions semantic similarity and cosine distance", () => {
      const command = getCommand();
      expect(command.description).toContain("semantic similarity");
      expect(command.description).toContain("cosine distance");
    });

    test("declares query, limit, role, from, to, and session parameters", () => {
      const command = getCommand();
      const params = command.parameters as Record<string, unknown>;
      expect(params.query).toBeDefined();
      expect(params.limit).toBeDefined();
      expect(params.role).toBeDefined();
      expect(params.from).toBeDefined();
      expect(params.to).toBeDefined();
      expect(params.session).toBeDefined();
    });

    test("query is required; limit defaults to 10; optional params have no default", () => {
      const command = getCommand();
      const params = command.parameters as Record<
        string,
        { required?: boolean; defaultValue?: unknown } | undefined
      >;
      expect(params.query?.required).toBe(true);
      expect(params.limit?.defaultValue).toBe(10);
      expect(params.role?.defaultValue).toBeUndefined();
      expect(params.from?.defaultValue).toBeUndefined();
      expect(params.to?.defaultValue).toBeUndefined();
      expect(params.session?.defaultValue).toBeUndefined();
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
      await expect(getCommand().execute({ query: "hello" }, ctx)).rejects.toThrow(/persistence/);
    });
  });
});
