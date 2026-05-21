/**
 * Tests for `session-context-snapshot` mapper functions (mt#2022).
 *
 * The pure mapping functions (`mapTurnTypeToBlockType`,
 * `mapAttachmentTypeToBlockType`) are exercised here without a DB. The full
 * `assembleSessionContextSnapshot` function is DB-dependent; its end-to-end
 * test will land alongside the inspector consumer (mt#2023+) where a
 * Postgres-mocked test rig already exists.
 */

import { describe, expect, test } from "bun:test";
import { mapAttachmentTypeToBlockType, mapTurnTypeToBlockType } from "./session-context-snapshot";

describe("mapTurnTypeToBlockType (mt#2022)", () => {
  test("user line → user-prompt", () => {
    expect(mapTurnTypeToBlockType("user")).toBe("user-prompt");
  });

  test("assistant line (default) → assistant-text", () => {
    expect(mapTurnTypeToBlockType("assistant")).toBe("assistant-text");
  });

  test("assistant line with kind='thinking' → assistant-thinking", () => {
    expect(mapTurnTypeToBlockType("assistant", "thinking")).toBe("assistant-thinking");
  });

  test("assistant line with kind='text' → assistant-text", () => {
    expect(mapTurnTypeToBlockType("assistant", "text")).toBe("assistant-text");
  });

  test("unknown line type → other", () => {
    expect(mapTurnTypeToBlockType("something-else")).toBe("other");
  });
});

describe("mapAttachmentTypeToBlockType (mt#2022)", () => {
  test("attachment + hook_additional_context → hook-injection", () => {
    expect(mapAttachmentTypeToBlockType("attachment", "hook_additional_context")).toBe(
      "hook-injection"
    );
  });

  test("attachment + task_reminder → hook-injection", () => {
    expect(mapAttachmentTypeToBlockType("attachment", "task_reminder")).toBe("hook-injection");
  });

  test("attachment + auto_mode → hook-injection", () => {
    expect(mapAttachmentTypeToBlockType("attachment", "auto_mode")).toBe("hook-injection");
  });

  test("attachment + deferred_tools_delta → deferred-tool-catalog", () => {
    expect(mapAttachmentTypeToBlockType("attachment", "deferred_tools_delta")).toBe(
      "deferred-tool-catalog"
    );
  });

  test("attachment + mcp_instructions_delta → mcp-instructions", () => {
    expect(mapAttachmentTypeToBlockType("attachment", "mcp_instructions_delta")).toBe(
      "mcp-instructions"
    );
  });

  test("attachment + skill_listing → skill-body", () => {
    expect(mapAttachmentTypeToBlockType("attachment", "skill_listing")).toBe("skill-body");
  });

  test("attachment + unrecognized subtype → other (defensive)", () => {
    expect(mapAttachmentTypeToBlockType("attachment", "some_future_subtype")).toBe("other");
  });

  test("system line → metadata", () => {
    expect(mapAttachmentTypeToBlockType("system", "stop_hook_summary")).toBe("metadata");
    expect(mapAttachmentTypeToBlockType("system", "turn_duration")).toBe("metadata");
  });

  test("unrecognized rawJsonlType → other", () => {
    expect(mapAttachmentTypeToBlockType("unknown", "anything")).toBe("other");
  });
});
