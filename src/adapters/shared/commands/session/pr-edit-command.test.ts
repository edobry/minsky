import { describe, it, expect } from "bun:test";
import { executeSessionPrEdit, type SessionPrEditParams } from "./pr-edit-command";
import type { CommandExecutionContext } from "../../command-registry";
import type { SessionCommandDependencies } from "./types";

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
