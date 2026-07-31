import { describe, test, expect, beforeEach } from "bun:test";
import { createSharedCommandRegistry, CommandCategory } from "../../command-registry";
import { registerTranscriptGetCommand, projectTurnsToText } from "./get-command";
import type { TranscriptTextProjectionEntry } from "./get-command";
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

    test("declares role and projection params (mt#2818)", () => {
      const command = getCommand();
      const params = command.parameters as Record<
        string,
        { required?: boolean; defaultValue?: unknown } | undefined
      >;
      expect(params.role).toBeDefined();
      expect(params.role?.required).toBeFalsy();
      expect(params.projection).toBeDefined();
      expect(params.projection?.required).toBeFalsy();
      expect(params.projection?.defaultValue).toBe("full");
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

// ── projectTurnsToText (mt#2818) ─────────────────────────────────────────────

describe("projectTurnsToText", () => {
  test("emits one entry per present role when no role filter is given", () => {
    const entries = projectTurnsToText([
      { turnIndex: 0, userText: "hello", assistantText: "hi there" },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ turnIndex: 0, role: "user", text: "hello", injected: false });
    expect(entries[1]).toEqual({
      turnIndex: 0,
      role: "assistant",
      text: "hi there",
      injected: false,
    });
  });

  test("role filter restricts to only that role's text", () => {
    const entries = projectTurnsToText(
      [{ turnIndex: 0, userText: "hello", assistantText: "hi there" }],
      "user"
    );
    expect(entries).toHaveLength(1);
    const entry = entries[0] as TranscriptTextProjectionEntry;
    expect(entry.role).toBe("user");
    expect(entry.text).toBe("hello");
  });

  test("a turn with a null role-text is skipped, not emitted as empty", () => {
    const entries = projectTurnsToText([{ turnIndex: 0, userText: null, assistantText: "hi" }]);
    expect(entries).toHaveLength(1);
    const entry = entries[0] as TranscriptTextProjectionEntry;
    expect(entry.role).toBe("assistant");
  });

  test("a turn whose text is ENTIRELY harness markup is excluded", () => {
    const entries = projectTurnsToText([
      {
        turnIndex: 0,
        userText: "<system-reminder>injected context</system-reminder>",
        assistantText: null,
      },
    ]);
    expect(entries).toHaveLength(0);
  });

  test("a turn MIXING real content with markup is included, markup stripped, injected: true", () => {
    const entries = projectTurnsToText([
      {
        turnIndex: 0,
        userText: "please fix the bug <system-reminder>ignore this</system-reminder>",
        assistantText: null,
      },
    ]);
    expect(entries).toHaveLength(1);
    const entry = entries[0] as TranscriptTextProjectionEntry;
    expect(entry.injected).toBe(true);
    expect(entry.text).not.toContain("system-reminder");
    expect(entry.text).toContain("please fix the bug");
  });

  test("a turn with no markup is included verbatim with injected: false", () => {
    const entries = projectTurnsToText([
      { turnIndex: 0, userText: "plain user prompt", assistantText: null },
    ]);
    expect(entries).toHaveLength(1);
    const entry = entries[0] as TranscriptTextProjectionEntry;
    expect(entry.injected).toBe(false);
    expect(entry.text).toBe("plain user prompt");
  });

  test("multiple turns preserve turnIndex ordering in output", () => {
    const entries = projectTurnsToText(
      [
        { turnIndex: 0, userText: "first", assistantText: null },
        { turnIndex: 1, userText: "second", assistantText: null },
      ],
      "user"
    );
    expect(entries.map((e) => e.turnIndex)).toEqual([0, 1]);
    expect(entries.map((e) => e.text)).toEqual(["first", "second"]);
  });

  test("a slash-command turn (<command-message> wrapper) is excluded entirely", () => {
    const entries = projectTurnsToText([
      {
        turnIndex: 0,
        userText:
          "<command-message>error-handling</command-message>\n<command-name>error-handling</command-name>",
        assistantText: null,
      },
    ]);
    expect(entries).toHaveLength(0);
  });
});
