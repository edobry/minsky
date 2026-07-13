/**
 * CommandPalette navigation regression tests (mt#2518).
 *
 * The `handleSelect` callback was refactored from an inline switch to use the
 * shared `entityToPath` codec. These tests verify that the refactored code
 * produces the same paths the old inline switch produced — i.e., the
 * `entityToPath` results match the expected routes for each entity type.
 *
 * We test the codec's output directly (not the full React component) to avoid
 * a DOM/router setup while still pinning the navigation contract.
 */
import { describe, test, expect } from "bun:test";
import { entityToPath } from "../lib/entity-codec";

describe("CommandPalette navigation (codec regression)", () => {
  test("task id → /tasks/:encoded", () => {
    // Old code: `/tasks/${encodeURIComponent(entity.id)}`
    const id = "mt#2399";
    expect(entityToPath("task", id)).toBe(`/tasks/${encodeURIComponent(id)}`);
  });

  test("session id → /agents/:encoded", () => {
    // Old code: `/agents/${encodeURIComponent(entity.id)}`
    const id = "4d44d12b-58f0-433e-95b3-8b914693fa39";
    expect(entityToPath("session", id)).toBe(`/agents/${encodeURIComponent(id)}`);
  });

  test("ask id → /ask/:encoded", () => {
    // Old code: `/ask/${encodeURIComponent(entity.id)}`
    const id = "0a1b2c3d-0000-0000-0000-000000000000";
    expect(entityToPath("ask", id)).toBe(`/ask/${encodeURIComponent(id)}`);
  });

  test("memory id → /memory/:encoded", () => {
    // Old code: `/memory/${encodeURIComponent(entity.id)}`
    const id = "bd38be2c-1234-5678-9abc-def000000000";
    expect(entityToPath("memory", id)).toBe(`/memory/${encodeURIComponent(id)}`);
  });

  test("# in task id is encoded as %23", () => {
    // Critical: mt#2399 → mt%232399 so the browser doesn't treat # as a fragment
    expect(entityToPath("task", "mt#2399")).toBe("/tasks/mt%232399");
  });
});
