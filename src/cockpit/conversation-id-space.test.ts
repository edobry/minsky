/**
 * Tests for the conversation id-space fail-loud classifier (mt#2525 / mt#2420).
 */
import { describe, test, expect } from "bun:test";
import { classifySnapshotMiss, WRONG_ID_SPACE_MESSAGE } from "./conversation-id-space";

describe("classifySnapshotMiss (mt#2525)", () => {
  test("a known WORKSPACE id → wrong_id_space (the mt#2420 mistake)", async () => {
    const result = await classifySnapshotMiss("task359", async () => true);
    expect(result).toBe("wrong_id_space");
  });

  test("an id unknown to the workspace substrate → not_found", async () => {
    const result = await classifySnapshotMiss("some-conversation-uuid", async () => false);
    expect(result).toBe("not_found");
  });

  test("a probe that throws falls open to not_found (never crashes the request)", async () => {
    const result = await classifySnapshotMiss("any-id", async () => {
      throw new Error("provider unavailable");
    });
    expect(result).toBe("not_found");
  });

  test("the requested id is the value passed to the workspace probe", async () => {
    let seen: string | undefined;
    await classifySnapshotMiss("workspace-xyz", async (id) => {
      seen = id;
      return false;
    });
    expect(seen).toBe("workspace-xyz");
  });

  test("the user-safe message names both id-spaces descriptively (no premature rename)", () => {
    expect(WRONG_ID_SPACE_MESSAGE).toContain("workspace session id");
    expect(WRONG_ID_SPACE_MESSAGE).toContain("harness conversation id");
  });
});
