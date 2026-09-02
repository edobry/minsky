import { describe, test, expect, beforeEach } from "bun:test";
import { createSharedCommandRegistry, CommandCategory } from "../../command-registry";
import { registerTranscriptSearchCommand } from "./search-command";
// Registered into a throwaway registry by the parity test below, which asserts
// the two search tools still share one projection default (mt#4917).
import { registerTranscriptSearchTextCommand } from "./search-text-command";
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

    test("description mentions semantic similarity and vector distance", () => {
      const command = getCommand();
      expect(command.description).toContain("semantic similarity");
      // mt#4344: the ranking metric is L2 (`<->`), matching the table's
      // vector_l2_ops index — it was described as "cosine distance" while the
      // query used `<=>` against an L2 index, which is exactly the drift this
      // wording change (and operator-class-alignment.ts) exists to stop.
      expect(command.description).toContain("vector distance");
      expect(command.description).not.toContain("cosine distance");
    });

    test("declares query, limit, role, from, to, session, and allProjects parameters", () => {
      const command = getCommand();
      const params = command.parameters as Record<string, unknown>;
      expect(params.query).toBeDefined();
      expect(params.limit).toBeDefined();
      expect(params.role).toBeDefined();
      expect(params.from).toBeDefined();
      expect(params.to).toBeDefined();
      expect(params.session).toBeDefined();
      expect(params.allProjects).toBeDefined();
    });

    test("query is required; limit defaults to 10; allProjects defaults to false; other optional params have no default", () => {
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
      expect(params.allProjects?.defaultValue).toBe(false);
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

  describe("projection (mt#4917)", () => {
    test("declares a projection parameter defaulting to snippet", () => {
      const params = getCommand().parameters as Record<
        string,
        { required?: boolean; defaultValue?: unknown } | undefined
      >;
      expect(params.projection).toBeDefined();
      expect(params.projection?.required).toBe(false);
      expect(params.projection?.defaultValue).toBe("snippet");
    });

    test("matches search-text's default, so the two tools read the same way", () => {
      // The pair is the point: an agent that learns one tool's default and
      // applies it to the other must not be surprised. Both parameters are
      // built by the same `projectionParam()`, and this asserts the result
      // rather than trusting that they still share it.
      const registryB = createSharedCommandRegistry();
      registerTranscriptSearchTextCommand(undefined, registryB);
      const siblingParams = registryB.getCommand("transcripts.search-text")?.parameters as Record<
        string,
        { defaultValue?: unknown } | undefined
      >;
      const ownParams = getCommand().parameters as Record<
        string,
        { defaultValue?: unknown } | undefined
      >;

      expect(ownParams.projection?.defaultValue).toBe(
        siblingParams.projection?.defaultValue as string
      );
    });

    test("the description names the default and points at how to read a hit in full", () => {
      const description = getCommand().description;
      expect(description).toContain("snippet");
      expect(description).toContain("transcripts_get");
    });

    test("the description says its snippet marks no matched spans", () => {
      // A caller comparing the two tools will notice the FTS one brackets its
      // matches and this one does not; the description has to say why rather
      // than leaving it to read as a bug.
      expect(getCommand().description).toContain("no matched spans");
    });
  });
});
