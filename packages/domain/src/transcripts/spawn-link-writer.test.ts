/**
 * Tests for spawn-link-writer (mt#2756 — `minsky_session_links`
 * `subagent_spawn` writer + idempotent backfill).
 *
 * Uses in-memory fakes for the DB — no real Postgres access.
 *
 * @see ./spawn-link-writer.ts
 * @see mt#2756
 */

import { describe, test, expect } from "bun:test";

import {
  extractMinskySessionIdFromPrompt,
  writeSpawnLink,
  backfillSpawnLinks,
  SUBAGENT_SPAWN_LINK_TYPE,
  SUBAGENT_SPAWN_CONFIDENCE,
} from "./spawn-link-writer";

const SESSIONS_DIR = "/state/minsky/sessions";
const SESSION_A = "aaaaaaaa-0000-0000-0000-000000000001";
const SESSION_B = "bbbbbbbb-0000-0000-0000-000000000002";
const CHILD = "cccccccc-0000-0000-0000-000000000003";

function promptWithSessionDir(sessionId: string, sessionsDir = SESSIONS_DIR): string {
  return (
    `You are working in Minsky session at ${sessionsDir}/${sessionId}. ` +
    `All file paths MUST be absolute paths under this directory.\n\n` +
    `Task mt#123: Implementation work\n\nDo the thing.`
  );
}

// ── extractMinskySessionIdFromPrompt (pure) ─────────────────────────────────

describe("extractMinskySessionIdFromPrompt", () => {
  test("returns null for a null/undefined prompt", () => {
    expect(extractMinskySessionIdFromPrompt(null, SESSIONS_DIR)).toBeNull();
    expect(extractMinskySessionIdFromPrompt(undefined, SESSIONS_DIR)).toBeNull();
  });

  test("returns null for an empty string prompt", () => {
    expect(extractMinskySessionIdFromPrompt("", SESSIONS_DIR)).toBeNull();
  });

  test("extracts the session id from the session_generate_prompt header", () => {
    const prompt = promptWithSessionDir(SESSION_A);
    expect(extractMinskySessionIdFromPrompt(prompt, SESSIONS_DIR)).toBe(SESSION_A);
  });

  test("extracts the session id when the path appears mid-prompt, not just at the start", () => {
    const prompt =
      `Some preamble text.\n\n` +
      `You are working in Minsky session at ${SESSIONS_DIR}/${SESSION_A}. ` +
      `All file paths MUST be absolute paths under this directory.`;
    expect(extractMinskySessionIdFromPrompt(prompt, SESSIONS_DIR)).toBe(SESSION_A);
  });

  test("returns null when the prompt does not embed the sessionsDir prefix", () => {
    expect(
      extractMinskySessionIdFromPrompt("Just do the task, no session info here.", SESSIONS_DIR)
    ).toBeNull();
  });

  test("does not false-positive-match a sibling directory sharing the sessions-dir prefix", () => {
    const prompt = `Working at ${SESSIONS_DIR}-archive/${SESSION_A}.`;
    expect(extractMinskySessionIdFromPrompt(prompt, SESSIONS_DIR)).toBeNull();
  });

  test("normalizes a sessionsDir passed with a trailing slash", () => {
    const prompt = promptWithSessionDir(SESSION_A);
    expect(extractMinskySessionIdFromPrompt(prompt, `${SESSIONS_DIR}/`)).toBe(SESSION_A);
  });

  test("stops the id capture at the trailing period, not mid-path characters", () => {
    // ".local" style path segments contain a dot but are not followed by
    // whitespace, so the capture group (which allows only [A-Za-z0-9-])
    // must stop cleanly at the session-id segment itself.
    const prompt = `You are working in Minsky session at /Users/x/.local/state/minsky/sessions/${SESSION_A}. All good.`;
    expect(extractMinskySessionIdFromPrompt(prompt, "/Users/x/.local/state/minsky/sessions")).toBe(
      SESSION_A
    );
  });

  test("escapes regex special characters in a custom sessionsDir", () => {
    const weirdDir = "/state (staging)/sessions";
    const prompt = `Working at ${weirdDir}/${SESSION_A}.`;
    expect(extractMinskySessionIdFromPrompt(prompt, weirdDir)).toBe(SESSION_A);
  });

  // mt#2756 R1 (reviewer finding): explicit `[`/`]` coverage — square brackets
  // are regex metacharacters (character-class delimiters) that a naive escape
  // could miss. escapeRegExpLiteral's character class explicitly includes
  // both `[` and `\]`, matching the canonical MDN escapeRegExp form.
  test("escapes a literal '[' in a custom sessionsDir", () => {
    const weirdDir = "/state[env=staging]/sessions";
    const prompt = `Working at ${weirdDir}/${SESSION_A}.`;
    expect(extractMinskySessionIdFromPrompt(prompt, weirdDir)).toBe(SESSION_A);
  });

  test("escapes a literal ']' in a custom sessionsDir", () => {
    const weirdDir = "/state/env]/sessions";
    const prompt = `Working at ${weirdDir}/${SESSION_A}.`;
    expect(extractMinskySessionIdFromPrompt(prompt, weirdDir)).toBe(SESSION_A);
  });

  test("escapes both '[' and ']' together in a custom sessionsDir", () => {
    const weirdDir = "/state/[env]/sessions";
    const prompt = `Working at ${weirdDir}/${SESSION_A}.`;
    expect(extractMinskySessionIdFromPrompt(prompt, weirdDir)).toBe(SESSION_A);
  });

  test("does not false-positive-match when '[' or ']' appear in surrounding prompt text but not the sessionsDir itself", () => {
    const prompt = `Config [env=prod] loaded. You are working in Minsky session at ${SESSIONS_DIR}/${SESSION_A}. All good.`;
    expect(extractMinskySessionIdFromPrompt(prompt, SESSIONS_DIR)).toBe(SESSION_A);
  });

  test("uses the live getSessionsDir() when sessionsDir is not passed", () => {
    expect(extractMinskySessionIdFromPrompt("no session info here")).toBeNull();
  });
});

// ── writeSpawnLink (DB-backed, in-memory fake) ──────────────────────────────

interface FakeLinkRow {
  agentSessionId: string;
  minskySessionId: string;
  linkType: string;
  confidence: number | null;
}

function makeLinkDb(store: Map<string, FakeLinkRow>, opts?: { throwOnInsert?: boolean }) {
  return {
    insert(_table: unknown) {
      return {
        values(v: FakeLinkRow) {
          return {
            onConflictDoNothing(): Promise<void> {
              if (opts?.throwOnInsert) {
                return Promise.reject(new Error("simulated DB error"));
              }
              const key = `${v.agentSessionId}:${v.minskySessionId}`;
              if (!store.has(key)) store.set(key, { ...v });
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
}

type FakeLinkDb = ReturnType<typeof makeLinkDb>;
function asPg(db: FakeLinkDb) {
  return db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase;
}

describe("writeSpawnLink", () => {
  // mt#2756 R1: writeSpawnLink returns a discriminated WriteSpawnLinkOutcome
  // ("written" | "no-child" | "no-prompt-match" | "error") instead of a
  // collapsing boolean, so callers can distinguish WHY a link wasn't written.

  test("writes a link row when the prompt embeds a session dir and returns 'written'", async () => {
    const store = new Map<string, FakeLinkRow>();
    const db = makeLinkDb(store);

    const outcome = await writeSpawnLink(
      asPg(db),
      CHILD,
      promptWithSessionDir(SESSION_B),
      SESSIONS_DIR
    );

    expect(outcome).toBe("written");
    const row = store.get(`${CHILD}:${SESSION_B}`);
    expect(row).toEqual({
      agentSessionId: CHILD,
      minskySessionId: SESSION_B,
      linkType: SUBAGENT_SPAWN_LINK_TYPE,
      confidence: SUBAGENT_SPAWN_CONFIDENCE,
    });
  });

  test("no-ops (no DB call) and returns 'no-child' when childAgentSessionId is absent", async () => {
    const store = new Map<string, FakeLinkRow>();
    let insertCalled = false;
    const db = {
      insert(_table: unknown) {
        insertCalled = true;
        return { values: () => ({ onConflictDoNothing: () => Promise.resolve() }) };
      },
    };

    const outcome = await writeSpawnLink(
      asPg(db as unknown as FakeLinkDb),
      null,
      promptWithSessionDir(SESSION_B),
      SESSIONS_DIR
    );

    expect(outcome).toBe("no-child");
    expect(insertCalled).toBe(false);
    expect(store.size).toBe(0);
  });

  test("no-ops (no DB call) and returns 'no-child' when childAgentSessionId is undefined", async () => {
    const store = new Map<string, FakeLinkRow>();
    const db = makeLinkDb(store);

    const outcome = await writeSpawnLink(
      asPg(db),
      undefined,
      promptWithSessionDir(SESSION_B),
      SESSIONS_DIR
    );

    expect(outcome).toBe("no-child");
    expect(store.size).toBe(0);
  });

  test("no-ops and returns 'no-prompt-match' when the prompt does not embed a session dir", async () => {
    const store = new Map<string, FakeLinkRow>();
    let insertCalled = false;
    const db = {
      insert(_table: unknown) {
        insertCalled = true;
        return { values: () => ({ onConflictDoNothing: () => Promise.resolve() }) };
      },
    };

    const outcome = await writeSpawnLink(
      asPg(db as unknown as FakeLinkDb),
      CHILD,
      "Just do the task.",
      SESSIONS_DIR
    );

    expect(outcome).toBe("no-prompt-match");
    expect(insertCalled).toBe(false);
    expect(store.size).toBe(0);
  });

  test("returns 'no-prompt-match' when prompt is not a string (e.g. undefined input.prompt)", async () => {
    const store = new Map<string, FakeLinkRow>();
    const db = makeLinkDb(store);

    const outcome = await writeSpawnLink(asPg(db), CHILD, undefined, SESSIONS_DIR);

    expect(outcome).toBe("no-prompt-match");
    expect(store.size).toBe(0);
  });

  test("swallows a DB failure and returns 'error' rather than throwing", async () => {
    const store = new Map<string, FakeLinkRow>();
    const db = makeLinkDb(store, { throwOnInsert: true });

    const outcome = await writeSpawnLink(
      asPg(db),
      CHILD,
      promptWithSessionDir(SESSION_B),
      SESSIONS_DIR
    );

    expect(outcome).toBe("error");
    expect(store.size).toBe(0);
  });

  test("idempotent: writing the same link twice does not duplicate or error", async () => {
    const store = new Map<string, FakeLinkRow>();
    const db = makeLinkDb(store);
    const prompt = promptWithSessionDir(SESSION_B);

    await writeSpawnLink(asPg(db), CHILD, prompt, SESSIONS_DIR);
    const after1 = store.size;
    const outcome2 = await writeSpawnLink(asPg(db), CHILD, prompt, SESSIONS_DIR);

    expect(outcome2).toBe("written");
    expect(store.size).toBe(after1);
  });
});

// ── backfillSpawnLinks (DB-backed, in-memory fake) ──────────────────────────

interface FakeSpawnJoinRow {
  childAgentSessionId: string | null;
  toolCalls: unknown;
}

function makeAgentToolCall(prompt: string): Record<string, unknown> {
  return {
    type: "tool_use",
    id: "toolu_agent_1",
    name: "Agent",
    input: { prompt },
  };
}

function makeBackfillDb(
  joinRows: FakeSpawnJoinRow[],
  linkStore: Map<string, FakeLinkRow>,
  opts?: { throwOnSelect?: boolean; failLinkForChild?: string }
) {
  return {
    select(_fields?: Record<string, unknown>) {
      return {
        from: (_table: unknown) => ({
          innerJoin: (_joinTable: unknown, _condition: unknown): Promise<FakeSpawnJoinRow[]> => {
            if (opts?.throwOnSelect) {
              return Promise.reject(new Error("simulated select failure"));
            }
            return Promise.resolve(joinRows);
          },
        }),
      };
    },
    insert(_table: unknown) {
      return {
        values(v: FakeLinkRow) {
          return {
            onConflictDoNothing(): Promise<void> {
              if (opts?.failLinkForChild === v.agentSessionId) {
                return Promise.reject(new Error("simulated link-insert failure"));
              }
              const key = `${v.agentSessionId}:${v.minskySessionId}`;
              if (!linkStore.has(key)) linkStore.set(key, { ...v });
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
}

type FakeBackfillDb = ReturnType<typeof makeBackfillDb>;
function asBackfillPg(db: FakeBackfillDb) {
  return db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase;
}

describe("backfillSpawnLinks", () => {
  test("writes links for spawns whose prompt resolves, skips others", async () => {
    const rows: FakeSpawnJoinRow[] = [
      {
        childAgentSessionId: "child-1",
        toolCalls: [makeAgentToolCall(promptWithSessionDir(SESSION_A))],
      },
      { childAgentSessionId: "child-2", toolCalls: [makeAgentToolCall("no session dir here")] },
      {
        childAgentSessionId: null,
        toolCalls: [makeAgentToolCall(promptWithSessionDir(SESSION_B))],
      },
    ];
    const linkStore = new Map<string, FakeLinkRow>();
    const db = makeBackfillDb(rows, linkStore);

    const result = await backfillSpawnLinks(asBackfillPg(db), SESSIONS_DIR);

    expect(result.spawnsScanned).toBe(3);
    expect(result.linksWritten).toBe(1);
    expect(result.linksSkippedNoMatch).toBe(2);
    expect(result.linksErrored).toBe(0);
    expect(linkStore.get(`child-1:${SESSION_A}`)?.linkType).toBe(SUBAGENT_SPAWN_LINK_TYPE);
  });

  test("counts a per-row write failure as errored without aborting the sweep", async () => {
    const rows: FakeSpawnJoinRow[] = [
      {
        childAgentSessionId: "child-1",
        toolCalls: [makeAgentToolCall(promptWithSessionDir(SESSION_A))],
      },
      {
        childAgentSessionId: "child-2",
        toolCalls: [makeAgentToolCall(promptWithSessionDir(SESSION_B))],
      },
    ];
    const linkStore = new Map<string, FakeLinkRow>();
    const db = makeBackfillDb(rows, linkStore, { failLinkForChild: "child-1" });

    const result = await backfillSpawnLinks(asBackfillPg(db), SESSIONS_DIR);

    expect(result.spawnsScanned).toBe(2);
    expect(result.linksWritten).toBe(1);
    expect(result.linksErrored).toBe(1);
    expect(linkStore.has(`child-2:${SESSION_B}`)).toBe(true);
    expect(linkStore.has(`child-1:${SESSION_A}`)).toBe(false);
  });

  test("returns zero-value result (no throw) when the join query fails", async () => {
    const linkStore = new Map<string, FakeLinkRow>();
    const db = makeBackfillDb([], linkStore, { throwOnSelect: true });

    const result = await backfillSpawnLinks(asBackfillPg(db), SESSIONS_DIR);

    expect(result).toEqual({
      spawnsScanned: 0,
      linksWritten: 0,
      linksSkippedNoMatch: 0,
      linksErrored: 0,
    });
  });

  test("empty corpus -> zero counts", async () => {
    const linkStore = new Map<string, FakeLinkRow>();
    const db = makeBackfillDb([], linkStore);

    const result = await backfillSpawnLinks(asBackfillPg(db), SESSIONS_DIR);

    expect(result.spawnsScanned).toBe(0);
    expect(result.linksWritten).toBe(0);
    expect(result.linksSkippedNoMatch).toBe(0);
    expect(result.linksErrored).toBe(0);
  });

  test("idempotent: re-running the sweep over already-linked rows does not duplicate", async () => {
    const rows: FakeSpawnJoinRow[] = [
      {
        childAgentSessionId: "child-1",
        toolCalls: [makeAgentToolCall(promptWithSessionDir(SESSION_A))],
      },
    ];
    const linkStore = new Map<string, FakeLinkRow>();
    const db = makeBackfillDb(rows, linkStore);

    await backfillSpawnLinks(asBackfillPg(db), SESSIONS_DIR);
    expect(linkStore.size).toBe(1);

    const result2 = await backfillSpawnLinks(asBackfillPg(db), SESSIONS_DIR);
    expect(linkStore.size).toBe(1);
    expect(result2.linksWritten).toBe(1);
    expect(result2.linksErrored).toBe(0);
  });

  test("skips a row with no Agent tool call in tool_calls (malformed data)", async () => {
    const rows: FakeSpawnJoinRow[] = [
      {
        childAgentSessionId: "child-1",
        toolCalls: [{ type: "tool_use", name: "Read", input: {} }],
      },
    ];
    const linkStore = new Map<string, FakeLinkRow>();
    const db = makeBackfillDb(rows, linkStore);

    const result = await backfillSpawnLinks(asBackfillPg(db), SESSIONS_DIR);

    expect(result.linksSkippedNoMatch).toBe(1);
    expect(result.linksWritten).toBe(0);
  });
});
