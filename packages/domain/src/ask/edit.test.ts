/**
 * Tests for `editAskContent` (mt#2668) — the content-update surface for
 * non-terminal Asks.
 *
 * Exercises the domain function end-to-end against `FakeAskRepository`
 * (which mirrors the Drizzle backend's non-terminal guard), verifying:
 *   1. Content fields update in place; `state` is never changed.
 *   2. Terminal asks (closed/cancelled/expired) are rejected with a clear error.
 *   3. Provenance: every edit appends an editHistory note (editor, timestamp,
 *      touched fields) that caller-supplied metadata cannot clobber.
 *   4. Metadata shallow-merge preserves unrelated existing keys.
 *   5. Parameter validation: empty id / no editable fields are rejected.
 */

import { describe, expect, test } from "bun:test";

import {
  editAskContent,
  providedEditableFields,
  sanitizeMetadata,
  EDIT_HISTORY_METADATA_KEY,
  type AskEditNote,
} from "./edit";
import { FakeAskRepository } from "./repository";
import type { Ask, AskState } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KIND_DIRECTION_DECIDE = "direction.decide" as const;

// Centralized fixture string — defangs custom/no-magic-string-duplication.
const REFRESHED_QUESTION = "Refreshed question";

async function seedAskAtState(repo: FakeAskRepository, state: AskState): Promise<Ask> {
  const created = await repo.create({
    kind: KIND_DIRECTION_DECIDE,
    classifierVersion: "v1.0.0",
    requestor: "minsky.agent:test",
    title: "Original title",
    question: "Original question",
    options: [{ label: "A: original", value: "a" }],
    contextRefs: [{ kind: "task", ref: "mt#0001", description: "original ref" }],
    metadata: { stagedFiles: "all" },
  });
  if (state === "detected") return created;
  const seeded: Ask = { ...created, state };
  repo._seedAtState(seeded);
  return seeded;
}

// ---------------------------------------------------------------------------
// providedEditableFields
// ---------------------------------------------------------------------------

describe("providedEditableFields", () => {
  test("returns only the fields actually provided", () => {
    expect(providedEditableFields({ question: "q", metadata: { a: 1 } })).toEqual([
      "question",
      "metadata",
    ]);
  });

  test("returns empty array when nothing editable is provided", () => {
    expect(providedEditableFields({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sanitizeMetadata
// ---------------------------------------------------------------------------

describe("sanitizeMetadata", () => {
  test("drops __proto__, prototype, and constructor own-keys, keeps the rest", () => {
    const hostile = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": "x", "prototype": "y", "benign": 1}'
    ) as Record<string, unknown>;

    const clean = sanitizeMetadata(hostile);

    expect(Object.keys(clean)).toEqual(["benign"]);
    expect(clean.benign).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("returns an equivalent copy when nothing is forbidden", () => {
    expect(sanitizeMetadata({ a: 1, b: "two" })).toEqual({ a: 1, b: "two" });
  });
});

// ---------------------------------------------------------------------------
// editAskContent — happy paths
// ---------------------------------------------------------------------------

describe("editAskContent", () => {
  test("updates question in place and leaves state unchanged (suspended stays suspended)", async () => {
    const repo = new FakeAskRepository();
    const suspended = await seedAskAtState(repo, "suspended");

    const { ask } = await editAskContent(repo, {
      id: suspended.id,
      question: REFRESHED_QUESTION,
    });

    expect(ask.question).toBe(REFRESHED_QUESTION);
    expect(ask.state).toBe("suspended");
    expect(ask.title).toBe("Original title");

    const persisted = await repo.getById(suspended.id);
    expect(persisted?.question).toBe(REFRESHED_QUESTION);
    expect(persisted?.state).toBe("suspended");
  });

  test("updates options and contextRefs wholesale", async () => {
    const repo = new FakeAskRepository();
    const suspended = await seedAskAtState(repo, "suspended");

    const { ask } = await editAskContent(repo, {
      id: suspended.id,
      options: [
        { label: "B: replacement", value: "b" },
        { label: "C: another", value: "c" },
      ],
      contextRefs: [{ kind: "task", ref: "mt#2668" }],
    });

    expect(ask.options).toEqual([
      { label: "B: replacement", value: "b" },
      { label: "C: another", value: "c" },
    ]);
    expect(ask.contextRefs).toEqual([{ kind: "task", ref: "mt#2668" }]);
  });

  test("appends an editHistory provenance note with editor, timestamp, and touched fields", async () => {
    const repo = new FakeAskRepository();
    const suspended = await seedAskAtState(repo, "suspended");

    const { ask } = await editAskContent(repo, {
      id: suspended.id,
      question: "Refreshed",
      editor: "com.anthropic.claude-code:proc:abc123",
    });

    const history = ask.metadata[EDIT_HISTORY_METADATA_KEY] as AskEditNote[];
    expect(Array.isArray(history)).toBe(true);
    expect(history).toHaveLength(1);
    expect(history[0]?.editor).toBe("com.anthropic.claude-code:proc:abc123");
    expect(history[0]?.fields).toEqual(["question"]);
    expect(Number.isNaN(Date.parse(history[0]?.editedAt ?? ""))).toBe(false);
  });

  test("second edit appends a second note (append-only history)", async () => {
    const repo = new FakeAskRepository();
    const suspended = await seedAskAtState(repo, "suspended");

    await editAskContent(repo, { id: suspended.id, question: "First edit" });
    const { ask } = await editAskContent(repo, { id: suspended.id, title: "Second edit" });

    const history = ask.metadata[EDIT_HISTORY_METADATA_KEY] as AskEditNote[];
    expect(history).toHaveLength(2);
    expect(history[0]?.fields).toEqual(["question"]);
    expect(history[1]?.fields).toEqual(["title"]);
  });

  test("editor defaults to minsky.agent:unknown when absent or blank", async () => {
    const repo = new FakeAskRepository();
    const suspended = await seedAskAtState(repo, "suspended");

    const { ask } = await editAskContent(repo, {
      id: suspended.id,
      question: "Refreshed",
      editor: "   ",
    });

    const history = ask.metadata[EDIT_HISTORY_METADATA_KEY] as AskEditNote[];
    expect(history[0]?.editor).toBe("minsky.agent:unknown");
  });

  test("metadata shallow-merges over existing keys, preserving unrelated ones", async () => {
    const repo = new FakeAskRepository();
    const suspended = await seedAskAtState(repo, "suspended");

    const { ask } = await editAskContent(repo, {
      id: suspended.id,
      metadata: { refreshedFrom: "docs/research/mt2206-fable-naming-cycle.md" },
    });

    expect(ask.metadata.stagedFiles).toBe("all");
    expect(ask.metadata.refreshedFrom).toBe("docs/research/mt2206-fable-naming-cycle.md");
  });

  test("forbidden metadata keys are stripped from the merge and Object.prototype is not polluted", async () => {
    const repo = new FakeAskRepository();
    const suspended = await seedAskAtState(repo, "suspended");

    // JSON.parse produces a literal own "__proto__" data property — the
    // realistic shape of hostile input arriving over the MCP wire.
    const hostile = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": "x", "prototype": "y", "benign": "kept"}'
    ) as Record<string, unknown>;

    const { ask } = await editAskContent(repo, { id: suspended.id, metadata: hostile });

    expect(Object.prototype.hasOwnProperty.call(ask.metadata, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(ask.metadata, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(ask.metadata, "prototype")).toBe(false);
    expect(ask.metadata.benign).toBe("kept");
    // The global prototype was never touched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("caller-supplied editHistory in metadata cannot clobber the appended note", async () => {
    const repo = new FakeAskRepository();
    const suspended = await seedAskAtState(repo, "suspended");

    const { ask } = await editAskContent(repo, {
      id: suspended.id,
      metadata: { [EDIT_HISTORY_METADATA_KEY]: "malicious-overwrite" },
    });

    const history = ask.metadata[EDIT_HISTORY_METADATA_KEY] as AskEditNote[];
    expect(Array.isArray(history)).toBe(true);
    expect(history).toHaveLength(1);
    expect(history[0]?.fields).toEqual(["metadata"]);
  });

  test("all non-terminal states are editable", async () => {
    for (const state of ["detected", "classified", "routed", "suspended", "responded"] as const) {
      const repo = new FakeAskRepository();
      const ask = await seedAskAtState(repo, state);
      const { ask: edited } = await editAskContent(repo, { id: ask.id, question: "edited" });
      expect(edited.state).toBe(state);
      expect(edited.question).toBe("edited");
    }
  });
});

// ---------------------------------------------------------------------------
// editAskContent — rejections
// ---------------------------------------------------------------------------

describe("editAskContent rejections", () => {
  test.each(["closed", "cancelled", "expired"] as const)(
    "rejects a %s ask with a clear terminal-state error",
    async (state) => {
      const repo = new FakeAskRepository();
      const terminal = await seedAskAtState(repo, state);

      await expect(editAskContent(repo, { id: terminal.id, question: "nope" })).rejects.toThrow(
        `terminal state "${state}"`
      );

      // Content untouched.
      const persisted = await repo.getById(terminal.id);
      expect(persisted?.question).toBe("Original question");
    }
  );

  test("rejects an unknown ask id", async () => {
    const repo = new FakeAskRepository();
    await expect(editAskContent(repo, { id: "no-such-ask", question: "q" })).rejects.toThrow(
      "Ask not found: no-such-ask"
    );
  });

  test("rejects an empty id", async () => {
    const repo = new FakeAskRepository();
    await expect(editAskContent(repo, { id: "  ", question: "q" })).rejects.toThrow(
      "id is required"
    );
  });

  test("rejects when no editable field is provided", async () => {
    const repo = new FakeAskRepository();
    const suspended = await seedAskAtState(repo, "suspended");
    await expect(editAskContent(repo, { id: suspended.id })).rejects.toThrow(
      "at least one editable field"
    );
  });
});
