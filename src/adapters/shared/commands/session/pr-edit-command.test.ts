import { describe, it, expect } from "bun:test";
import { executeSessionPrEdit, pickTitleScope, type SessionPrEditParams } from "./pr-edit-command";
import type { CommandExecutionContext } from "../../command-registry";
import type { SessionCommandDependencies } from "./types";
import { ResourceNotFoundError, ValidationError } from "@minsky/domain/errors/index";

/**
 * Unit tests for session pr edit title validation
 * Tests command validation logic without external dependencies
 */

describe("session pr edit - conventional commit title validation", () => {
  const context: CommandExecutionContext = {
    interface: "cli",
    workingDirectory: "/tmp",
  } as any;

  // Validation runs before any dep calls — empty stub is sufficient
  const deps = {} as SessionCommandDependencies;

  it("rejects non-conventional title when --type is not provided", async () => {
    await expect(
      executeSessionPrEdit(
        deps,
        {
          title: "Update the title without proper prefix",
          sessionId: "dummy-session",
        } as SessionPrEditParams,
        context
      )
    ).rejects.toThrow(/Invalid title|full conventional commit title/i);
  });

  it("accepts full conventional title without --type", async () => {
    const result = await executeSessionPrEdit(
      deps,
      {
        title: "feat(core): improve handling",
        sessionId: "dummy-session",
        body: "placeholder",
      } as SessionPrEditParams,
      context
    ).catch((e) => e);

    // Validation layer passed; downstream may fail on missing session/PR
    const message = String(result?.message || result);
    expect(/(No PR|Session|Failed to edit session PR)/i.test(message)).toBe(true);
  });

  it("composes title from --type and description-only --title", async () => {
    const result = await executeSessionPrEdit(
      deps,
      {
        type: "feat",
        title: "add x",
        sessionId: "dummy-session",
        body: "placeholder",
      } as SessionPrEditParams,
      context
    ).catch((e) => e);

    const message = String(result?.message || result);
    expect(/(No PR|Session|Failed to edit session PR)/i.test(message)).toBe(true);
  });

  // mt#2821: PR-title create/edit validation parity
  describe("description-length parity (mt#2821)", () => {
    it("rejects a description-only --title over the 80-char budget (same validator session_pr_create uses)", async () => {
      await expect(
        executeSessionPrEdit(
          deps,
          {
            type: "feat",
            title: "a".repeat(87),
            sessionId: "dummy-session",
            body: "placeholder",
          } as SessionPrEditParams,
          context
        )
      ).rejects.toThrow(/too long|87|80/i);
    });

    it("accepts a description-only --title at exactly the 80-char budget", async () => {
      const result = await executeSessionPrEdit(
        deps,
        {
          type: "feat",
          title: "a".repeat(80),
          sessionId: "dummy-session",
          body: "placeholder",
        } as SessionPrEditParams,
        context
      ).catch((e) => e);

      // Validation layer passed; downstream may fail on missing session/PR
      const message = String(result?.message || result);
      expect(/(No PR|Session|Failed to edit session PR)/i.test(message)).toBe(true);
    });

    it("rejects a full conventional title (no --type) whose description exceeds 80 chars", async () => {
      await expect(
        executeSessionPrEdit(
          deps,
          {
            title: `feat(core): ${"a".repeat(87)}`,
            sessionId: "dummy-session",
            body: "placeholder",
          } as SessionPrEditParams,
          context
        )
      ).rejects.toThrow(/too long|87|80/i);
    });
  });
});

// mt#4138: a caller-supplied `task` must survive a session-resolution failure.
describe("session pr edit - task scope survives resolution failure (mt#4138)", () => {
  const context: CommandExecutionContext = {
    interface: "cli",
    workingDirectory: "/tmp",
  } as any;
  const deps = {} as SessionCommandDependencies;
  const DESCRIPTION = "Bound the entity-thread boot await";

  // The seams type is intentionally file-local in the production module (it is
  // test scaffolding, not a contract), so derive it from the function itself
  // rather than importing it.
  type Seams = NonNullable<Parameters<typeof executeSessionPrEdit>[3]>;

  /** Records the title the command actually handed to the edit path. */
  function recordingEditPr() {
    const seen: { title?: string } = {};
    const editPr = (async (editParams: { title?: string }) => {
      seen.title = editParams.title;
      return {
        prBranch: "pr/test",
        baseBranch: "main",
        title: editParams.title,
        body: "b",
        updated: true,
      };
    }) as unknown as NonNullable<Seams["editPr"]>;
    return { seen, editPr };
  }

  it("keeps the scope when resolution throws ResourceNotFoundError (the post-merge shape)", async () => {
    const { seen, editPr } = recordingEditPr();

    const result = await executeSessionPrEdit(
      deps,
      {
        type: "fix",
        title: DESCRIPTION,
        task: "mt#4133",
        body: "placeholder",
      } as SessionPrEditParams,
      context,
      {
        // The real resolver throws exactly this for an explicit task whose
        // session was cleaned up at merge — and it is NOT a ValidationError,
        // which is why the old catch swallowed it and dropped the scope.
        resolveSessionContext: async () => {
          throw new ResourceNotFoundError(
            'No session found for task ID "mt#4133"',
            "task",
            "mt#4133"
          );
        },
        editPr,
      }
    );

    expect(seen.title).toBe(`fix(mt#4133): ${DESCRIPTION}`);
    expect(result.titleScopeDropped).toBe(false);
  });

  it("keeps the scope when resolution throws a generic error (e.g. a DB timeout)", async () => {
    const { seen, editPr } = recordingEditPr();

    await executeSessionPrEdit(
      deps,
      {
        type: "fix",
        title: DESCRIPTION,
        task: "mt#4133",
        body: "placeholder",
      } as SessionPrEditParams,
      context,
      {
        resolveSessionContext: async () => {
          throw new Error("write CONNECT_TIMEOUT");
        },
        editPr,
      }
    );

    expect(seen.title).toBe(`fix(mt#4133): ${DESCRIPTION}`);
  });

  it("still propagates a ValidationError from resolution rather than swallowing it", async () => {
    const { editPr } = recordingEditPr();

    await expect(
      executeSessionPrEdit(
        deps,
        {
          type: "fix",
          title: DESCRIPTION,
          task: "mt#4133",
          body: "placeholder",
        } as SessionPrEditParams,
        context,
        {
          resolveSessionContext: async () => {
            throw new ValidationError("No session detected.");
          },
          editPr,
        }
      )
    ).rejects.toThrow(/No session detected/);
  });

  it("prefers the resolved id over the caller's when resolution succeeds", async () => {
    const { seen, editPr } = recordingEditPr();

    await executeSessionPrEdit(
      deps,
      {
        type: "fix",
        title: DESCRIPTION,
        task: "mt#4133",
        body: "placeholder",
      } as SessionPrEditParams,
      context,
      {
        resolveSessionContext: async () => ({ taskId: "mt#9999" }),
        editPr,
      }
    );

    expect(seen.title).toBe(`fix(mt#9999): ${DESCRIPTION}`);
  });

  it("composes a scopeless title, and does not flag one, when no task is available at all", async () => {
    const { seen, editPr } = recordingEditPr();

    const result = await executeSessionPrEdit(
      deps,
      {
        type: "fix",
        title: DESCRIPTION,
        sessionId: "dummy-session",
        body: "placeholder",
      } as SessionPrEditParams,
      context,
      {
        resolveSessionContext: async () => ({}),
        editPr,
      }
    );

    expect(seen.title).toBe(`fix: ${DESCRIPTION}`);
    // No task was ever named, so nothing was dropped.
    expect(result.titleScopeDropped).toBe(false);
  });
});

describe("pickTitleScope (mt#4138)", () => {
  const fmt = (id: string) => id;

  it("uses the caller's task when no resolved id exists", () => {
    expect(pickTitleScope("mt#4133", undefined, fmt)).toBe("mt#4133");
  });

  it("prefers the resolved id when both exist", () => {
    expect(pickTitleScope("mt#4133", "mt#9999", fmt)).toBe("mt#9999");
  });

  it("returns undefined when neither exists", () => {
    expect(pickTitleScope(undefined, undefined, fmt)).toBeUndefined();
  });

  it("returns undefined when the formatter cannot render the id", () => {
    expect(pickTitleScope("   ", undefined, () => "")).toBeUndefined();
  });
});
