import { describe, test, expect, beforeEach } from "bun:test";
import { createSharedCommandRegistry, CommandCategory } from "../../command-registry";
import { registerTranscriptGetCommand, projectTurnsToText } from "./get-command";
import type { TranscriptTextProjectionEntry } from "./get-command";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
// mt#4072 — imported rather than hard-coded so a change to either marker's
// spelling fails these tests instead of quietly making them assert nothing.
import { DISPATCH_STAMP_VERSION } from "@minsky/shared/dispatch-stamp";
import { PROMPT_WATERMARK } from "@minsky/domain/session/prompt-generation";

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

/**
 * A turn row for the projection, with `userOrigin` defaulted (mt#4072).
 *
 * The projection REQUIRES the field rather than treating it as optional — its
 * whole point is that attribution must not be silently dropped — so the default
 * here is `null`, which is what a turn carrying no `userText` gets in the DB.
 * Cases that care about attribution pass it explicitly.
 */
function turnRow(row: {
  turnIndex: number;
  userText: string | null;
  assistantText: string | null;
  userOrigin?: string | null;
}) {
  return { userOrigin: null, ...row };
}

describe("projectTurnsToText", () => {
  test("emits one entry per present role when no role filter is given", () => {
    const entries = projectTurnsToText([
      turnRow({ turnIndex: 0, userText: "hello", assistantText: "hi there" }),
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
      [turnRow({ turnIndex: 0, userText: "hello", assistantText: "hi there" })],
      "user"
    );
    expect(entries).toHaveLength(1);
    const entry = entries[0] as TranscriptTextProjectionEntry;
    expect(entry.role).toBe("user");
    expect(entry.text).toBe("hello");
  });

  test("a turn with a null role-text is skipped, not emitted as empty", () => {
    const entries = projectTurnsToText([
      turnRow({ turnIndex: 0, userText: null, assistantText: "hi" }),
    ]);
    expect(entries).toHaveLength(1);
    const entry = entries[0] as TranscriptTextProjectionEntry;
    expect(entry.role).toBe("assistant");
  });

  test("a turn whose text is ENTIRELY harness markup is excluded", () => {
    const entries = projectTurnsToText([
      turnRow({
        turnIndex: 0,
        userText: "<system-reminder>injected context</system-reminder>",
        assistantText: null,
      }),
    ]);
    expect(entries).toHaveLength(0);
  });

  test("a turn MIXING real content with markup is included, markup stripped, injected: true", () => {
    const entries = projectTurnsToText([
      turnRow({
        turnIndex: 0,
        userText: "please fix the bug <system-reminder>ignore this</system-reminder>",
        assistantText: null,
      }),
    ]);
    expect(entries).toHaveLength(1);
    const entry = entries[0] as TranscriptTextProjectionEntry;
    expect(entry.injected).toBe(true);
    expect(entry.text).not.toContain("system-reminder");
    expect(entry.text).toContain("please fix the bug");
  });

  test("a turn with no markup is included verbatim with injected: false", () => {
    const entries = projectTurnsToText([
      turnRow({ turnIndex: 0, userText: "plain user prompt", assistantText: null }),
    ]);
    expect(entries).toHaveLength(1);
    const entry = entries[0] as TranscriptTextProjectionEntry;
    expect(entry.injected).toBe(false);
    expect(entry.text).toBe("plain user prompt");
  });

  test("multiple turns preserve turnIndex ordering in output", () => {
    const entries = projectTurnsToText(
      [
        turnRow({ turnIndex: 0, userText: "first", assistantText: null }),
        turnRow({ turnIndex: 1, userText: "second", assistantText: null }),
      ],
      "user"
    );
    expect(entries.map((e) => e.turnIndex)).toEqual([0, 1]);
    expect(entries.map((e) => e.text)).toEqual(["first", "second"]);
  });

  test("a slash-command turn (<command-message> wrapper) is excluded entirely", () => {
    const entries = projectTurnsToText([
      turnRow({
        turnIndex: 0,
        userText:
          "<command-message>error-handling</command-message>\n<command-name>error-handling</command-name>",
        assistantText: null,
      }),
    ]);
    expect(entries).toHaveLength(0);
  });

  // ── mt#4072: Minsky's own prompt watermarks ────────────────────────────────
  //
  // `stripHarnessMarkup` strips harness TAGS; these are HTML COMMENTS, so it
  // never touched them. Measured 2026-09-02: 283 turns in the local corpus carry
  // one, 94 of them in 2026-08 — every one projected with markers intact and
  // `injected: false`, i.e. as the operator's own words.

  test("a dispatch prompt's watermark is stripped from the projected text", () => {
    const entries = projectTurnsToText([
      turnRow({
        turnIndex: 0,
        userText: `You are working in Minsky session abc.\n\n${PROMPT_WATERMARK}`,
        assistantText: null,
        userOrigin: "dispatch_brief",
      }),
    ]);

    expect(entries).toHaveLength(1);
    const entry = entries[0] as TranscriptTextProjectionEntry;
    expect(entry.text).not.toContain("minsky:prompt:v1");
    expect(entry.text).toContain("You are working in Minsky session abc.");
  });

  test("the dispatch stamp is stripped too, not just the prompt watermark", () => {
    const entries = projectTurnsToText([
      turnRow({
        turnIndex: 0,
        userText: `Do the thing.\n\n<!-- ${DISPATCH_STAMP_VERSION} parent=abc call=toolu_1 -->`,
        assistantText: null,
        userOrigin: "dispatch_brief",
      }),
    ]);

    const entry = entries[0] as TranscriptTextProjectionEntry;
    expect(entry.text).not.toContain(DISPATCH_STAMP_VERSION);
    expect(entry.text).toBe("Do the thing.");
  });

  test("userOrigin is carried through, so a dispatch prompt is not read as operator text", () => {
    const entries = projectTurnsToText([
      turnRow({
        turnIndex: 0,
        userText: `Audit the retry path.\n\n${PROMPT_WATERMARK}`,
        assistantText: null,
        userOrigin: "dispatch_brief",
      }),
    ]);

    const entry = entries[0] as TranscriptTextProjectionEntry;
    expect(entry.userOrigin).toBe("dispatch_brief");
    // `injected` stays FALSE deliberately — it means "harness markup was
    // stripped", and a Minsky-authored prompt is not harness markup. The
    // attribution answer is `userOrigin`, not this flag.
    expect(entry.injected).toBe(false);
  });

  test("an ASSISTANT entry keeps a quoted watermark — stripping is user-only", () => {
    // PR #3589 R1, BLOCKING. The first cut applied `stripPromptMarkers` to both
    // roles. Minsky writes these into PROMPTS, which are user turns, so the
    // assistant side had nothing to gain — and an assistant EXPLAINING the
    // dispatch format would have had its own quotation silently deleted.
    const explanation = `Dispatch prompts end with ${PROMPT_WATERMARK} so the classifier can see them.`;
    const entries = projectTurnsToText([
      turnRow({ turnIndex: 0, userText: null, assistantText: explanation }),
    ]);

    const entry = entries[0] as TranscriptTextProjectionEntry;
    expect(entry.role).toBe("assistant");
    expect(entry.text).toBe(explanation);
    expect(entry.text).toContain("minsky:prompt:v1");
  });

  test("an assistant entry carries no userOrigin", () => {
    const entries = projectTurnsToText([
      turnRow({
        turnIndex: 0,
        userText: null,
        assistantText: "on it",
        userOrigin: "dispatch_brief",
      }),
    ]);

    const entry = entries[0] as TranscriptTextProjectionEntry;
    expect(entry.role).toBe("assistant");
    expect(entry.userOrigin).toBeUndefined();
  });

  test("a HUMAN-paste prompt watermark is NOT stripped — that turn is the operator", () => {
    // `minsky:task-prompt:v1` marks prompts generated for a human to paste
    // (`tasks decompose|estimate|analyze`), and `stripPromptMarkers` spares it
    // on purpose. Stripping it would relabel genuine operator speech.
    const raw = "Here is the plan.\n\n<!-- minsky:task-prompt:v1 -->";
    const entries = projectTurnsToText([
      turnRow({ turnIndex: 0, userText: raw, assistantText: null, userOrigin: "human" }),
    ]);

    const entry = entries[0] as TranscriptTextProjectionEntry;
    expect(entry.text).toContain("minsky:task-prompt:v1");
    expect(entry.userOrigin).toBe("human");
  });

  test("a turn with no watermark is unchanged", () => {
    const entries = projectTurnsToText([
      turnRow({ turnIndex: 0, userText: "just a message", assistantText: null }),
    ]);

    const entry = entries[0] as TranscriptTextProjectionEntry;
    expect(entry.text).toBe("just a message");
    expect(entry.userOrigin).toBeUndefined();
  });
});
