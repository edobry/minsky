/**
 * Tests for the principal channel's composition root (mt#3228).
 *
 * The opt-in and permission-mode cases are the ones with teeth: both decide how
 * much authority an inbound Telegram message carries on this machine.
 */

import { describe, expect, test } from "bun:test";
import {
  bindTelegramChannelTopicToTask,
  createEventLogCursor,
  createTopicActuatorResolver,
  ensureTelegramChannelTopic,
  loadPrincipalChannelLaunchConfig,
  logTopicModeCapability,
  resolveAllowedUserIds,
  startPrincipalChannel,
  telegramTopicLocalId,
  type DbLike,
} from "./principal-channel-launch";
import type { ChannelActuator } from "./principal-channel-poller";
import type { TelegramGetMeResult } from "@minsky/domain/notify/telegram-transport";

describe("loadPrincipalChannelLaunchConfig (mt#3230 — config, not env)", () => {
  test("an absent section leaves the channel off", () => {
    expect(loadPrincipalChannelLaunchConfig({}).enabled).toBe(false);
  });

  test("only a literal true enables it", () => {
    // Guards against a truthy-but-not-true value quietly turning on an
    // RCE-adjacent surface. The env path coerces "true"/"1"/"yes" to a boolean
    // in the config layer; anything reaching here is already typed.
    expect(loadPrincipalChannelLaunchConfig({ enabled: true }).enabled).toBe(true);
    expect(loadPrincipalChannelLaunchConfig({ enabled: false }).enabled).toBe(false);
  });

  test("defaults the working directory to a non-empty path when unset", () => {
    // Asserted structurally rather than against process.cwd(): the point is
    // that the conversation always has somewhere to run, not which directory
    // this particular test process happens to sit in.
    expect(loadPrincipalChannelLaunchConfig({}).cwd.length).toBeGreaterThan(0);
  });

  test("honours an explicit working directory", () => {
    expect(loadPrincipalChannelLaunchConfig({ cwd: "/srv/work" }).cwd).toBe("/srv/work");
  });

  test("an empty working directory falls back rather than running in nowhere", () => {
    expect(loadPrincipalChannelLaunchConfig({ cwd: "" }).cwd.length).toBeGreaterThan(0);
  });

  test("permission mode matches other driven sessions by default", () => {
    expect(loadPrincipalChannelLaunchConfig({}).permissionMode).toBe("bypassPermissions");
  });

  test("'default' tightens it", () => {
    expect(loadPrincipalChannelLaunchConfig({ permissionMode: "default" }).permissionMode).toBe(
      "default"
    );
  });

  test("carries the sender allowlist through, dropping blanks", () => {
    expect(
      loadPrincipalChannelLaunchConfig({ allowedUserIds: ["777", "  ", "888"] }).allowedUserIds
    ).toEqual(["777", "888"]);
  });
});

describe("resolveAllowedUserIds (PR #2324 R1)", () => {
  test("derives the sender from a private chat id", () => {
    // Telegram gives a private chat the same id as the user on the other end,
    // so pinning the sender to it is exact — and it hardens against a spoofed
    // `from` on an update that otherwise matches the chat.
    expect(resolveAllowedUserIds("167346572", [])).toEqual(["167346572"]);
  });

  test("derives nothing from a group chat id", () => {
    // Group ids are negative and distinct from any member's user id; there is
    // nothing to derive, so this must stay chat-only until configured.
    expect(resolveAllowedUserIds("-100123456", [])).toEqual([]);
  });

  test("an explicit list wins over the derived one", () => {
    expect(resolveAllowedUserIds("167346572", ["777", "888"])).toEqual(["777", "888"]);
  });
});

describe("createEventLogCursor (PR #2324 R3)", () => {
  test("reads through to the event log", async () => {
    const cursor = createEventLogCursor(
      async () => 77,
      async () => {}
    );
    expect(await cursor.read()).toBe(77);
  });

  test("writes an advancement row when the message rows fall short", async () => {
    // The regression: an update that produces no message row (edited_message,
    // an unparsed future type) is never covered by a message-derived cursor, so
    // Telegram re-serves it forever and the channel wedges behind it.
    const advances: number[] = [];
    const cursor = createEventLogCursor(
      async () => 77,
      async (id) => {
        advances.push(id);
      }
    );

    await cursor.write(99);
    expect(advances).toEqual([99]);
  });

  test("writes nothing when the message rows already cover the position", async () => {
    // The common case — every update became a message. No redundant row.
    const advances: number[] = [];
    const cursor = createEventLogCursor(
      async () => 99,
      async (id) => {
        advances.push(id);
      }
    );

    await cursor.write(99);
    expect(advances).toEqual([]);
  });

  test("writes an advancement row on a cold log", async () => {
    const advances: number[] = [];
    const cursor = createEventLogCursor(
      async () => undefined,
      async (id) => {
        advances.push(id);
      }
    );

    await cursor.write(5);
    expect(advances).toEqual([5]);
  });
});

describe("startPrincipalChannel", () => {
  const unusedDeps = {
    respondToAsk: async () => "",
    recordEvent: async () => "recorded" as const,
    readHighestUpdateId: async () => undefined,
  };

  test("does not start when disabled, without touching credentials", async () => {
    const handle = await startPrincipalChannel({
      config: { enabled: false, cwd: "/tmp", permissionMode: "default", allowedUserIds: [] },
      ...unusedDeps,
    });
    expect(handle).toBeNull();
  });
});

/**
 * Telegram topic mapping + per-topic actuator wiring (mt#3505, parent
 * mt#3500). These are the composition-root pieces the poller's
 * `resolveTopicActuator` dep is built from.
 */
// mt#3505 — shared fixture so the expected localId string lives in one place.
const SAMPLE_CHAT_ID = "167346572";
const SAMPLE_THREAD_ID = 749667;
const SAMPLE_LOCAL_ID = `telegram-topic:${SAMPLE_CHAT_ID}:${SAMPLE_THREAD_ID}`;

describe("telegramTopicLocalId (mt#3505)", () => {
  test("is deterministic and readable, in the driven_sessions.local_id keyspace", () => {
    // Per the spec: "readable, not hashed, deterministic where possible" —
    // the same keyspace entityThreadLocalId already uses.
    expect(telegramTopicLocalId(SAMPLE_CHAT_ID, SAMPLE_THREAD_ID)).toBe(SAMPLE_LOCAL_ID);
  });

  test("different threads in the same chat produce different ids", () => {
    expect(telegramTopicLocalId("1", 100)).not.toBe(telegramTopicLocalId("1", 200));
  });

  test("the same (chat, thread) pair always produces the same id", () => {
    expect(telegramTopicLocalId("1", 100)).toBe(telegramTopicLocalId("1", 100));
  });
});

describe("ensureTelegramChannelTopic (mt#3505)", () => {
  function fakeDb(): { db: DbLike; queries: unknown[] } {
    const queries: unknown[] = [];
    return {
      queries,
      db: {
        execute: async (query: unknown) => {
          queries.push(query);
          return [];
        },
      } as unknown as DbLike,
    };
  }

  test("returns the deterministic localId and issues an idempotent insert", async () => {
    const { db, queries } = fakeDb();
    const localId = await ensureTelegramChannelTopic(SAMPLE_CHAT_ID, SAMPLE_THREAD_ID, {
      getDb: async () => db,
    });

    expect(localId).toBe(SAMPLE_LOCAL_ID);
    expect(queries).toHaveLength(1);
  });

  test("still returns the localId when persistence is unavailable, without throwing", async () => {
    const localId = await ensureTelegramChannelTopic(SAMPLE_CHAT_ID, SAMPLE_THREAD_ID, {
      getDb: async () => null,
    });
    expect(localId).toBe(SAMPLE_LOCAL_ID);
  });

  test("still returns the localId when the insert itself throws", async () => {
    const localId = await ensureTelegramChannelTopic(SAMPLE_CHAT_ID, SAMPLE_THREAD_ID, {
      getDb: async () =>
        ({
          execute: async () => {
            throw new Error("db down");
          },
        }) as unknown as DbLike,
    });
    expect(localId).toBe(SAMPLE_LOCAL_ID);
  });
});

/**
 * `/bind` write path (mt#3507) — validated, all-or-nothing, never creates
 * the task.
 */
describe("bindTelegramChannelTopicToTask (mt#3507)", () => {
  function fakeDb(): { db: DbLike; queries: unknown[] } {
    const queries: unknown[] = [];
    return {
      queries,
      db: {
        execute: async (query: unknown) => {
          queries.push(query);
          return [];
        },
      } as unknown as DbLike,
    };
  }

  test("refuses a malformed task id, writing nothing", async () => {
    const { db, queries } = fakeDb();
    const result = await bindTelegramChannelTopicToTask(
      SAMPLE_CHAT_ID,
      SAMPLE_THREAD_ID,
      "not-a-task-id",
      {
        getDb: async () => db,
        getTask: async () => ({ id: "should never be reached" }),
      }
    );

    expect(result).toEqual({
      kind: "invalid-task",
      detail: '"not-a-task-id" isn\'t a task id I recognize (expected e.g. mt#123).',
    });
    expect(queries).toHaveLength(0);
  });

  test("refuses a nonexistent task id, writing nothing — never creates the task", async () => {
    const { db, queries } = fakeDb();
    let getTaskCalledWith: string | undefined;
    const result = await bindTelegramChannelTopicToTask(
      SAMPLE_CHAT_ID,
      SAMPLE_THREAD_ID,
      "mt#99999999",
      {
        getDb: async () => db,
        getTask: async (taskId) => {
          getTaskCalledWith = taskId;
          return null; // does not exist
        },
      }
    );

    expect(result).toEqual({ kind: "invalid-task", detail: "mt#99999999 does not exist." });
    expect(getTaskCalledWith).toBe("mt#99999999");
    expect(queries).toHaveLength(0);
  });

  test("binds an existing task, issuing exactly one upsert", async () => {
    const { db, queries } = fakeDb();
    const result = await bindTelegramChannelTopicToTask(
      SAMPLE_CHAT_ID,
      SAMPLE_THREAD_ID,
      "mt#3507",
      {
        getDb: async () => db,
        getTask: async () => ({ id: "mt#3507" }),
      }
    );

    expect(result).toEqual({ kind: "bound", taskId: "mt#3507" });
    expect(queries).toHaveLength(1);
  });

  test("AT1: never touches driven_sessions, and writes the SAME deterministic localId ensureTelegramChannelTopic would — the conversation identity is untouched by a bind", async () => {
    // The spec's own requirement: "driven_sessions.local_id must be
    // IDENTICAL before and after". This function never references that
    // table at all, and the local_id it writes into the mapping row is the
    // SAME value telegramTopicLocalId (and therefore ensureTelegramChannelTopic)
    // would produce for this exact (chatId, messageThreadId) — asserted by
    // rendering the actual query text and parameters, not by inspecting the
    // implementation's source.
    const { db, queries } = fakeDb();
    await bindTelegramChannelTopicToTask(SAMPLE_CHAT_ID, SAMPLE_THREAD_ID, "mt#3507", {
      getDb: async () => db,
      getTask: async () => ({ id: "mt#3507" }),
    });

    const query = queries[0] as { queryChunks: unknown[] };
    const rendered = query.queryChunks
      .map((chunk) =>
        chunk && typeof chunk === "object" && "value" in chunk
          ? (chunk as { value: string[] }).value.join("")
          : String(chunk)
      )
      .join("");

    expect(rendered).toContain("telegram_channel_topics");
    expect(rendered).not.toContain("driven_sessions");
    expect(rendered).toContain(SAMPLE_LOCAL_ID);
  });

  test("refuses (does not crash) when persistence is unavailable, after confirming the task exists", async () => {
    const result = await bindTelegramChannelTopicToTask(
      SAMPLE_CHAT_ID,
      SAMPLE_THREAD_ID,
      "mt#3507",
      {
        getDb: async () => null,
        getTask: async () => ({ id: "mt#3507" }),
      }
    );
    expect(result.kind).toBe("invalid-task");
  });

  test("refuses (does not throw) when the write itself fails", async () => {
    const result = await bindTelegramChannelTopicToTask(
      SAMPLE_CHAT_ID,
      SAMPLE_THREAD_ID,
      "mt#3507",
      {
        getDb: async () =>
          ({
            execute: async () => {
              throw new Error("db down");
            },
          }) as unknown as DbLike,
        getTask: async () => ({ id: "mt#3507" }),
      }
    );
    expect(result.kind).toBe("invalid-task");
  });

  test("checks task existence BEFORE writing — a task check that throws still writes nothing", async () => {
    const { db, queries } = fakeDb();
    // A thrown existence check propagates rather than silently writing a
    // half-confirmed binding — the spec's "never leave a half-written row"
    // requirement extends to a check that couldn't complete, not just one
    // that completed negatively.
    await expect(
      bindTelegramChannelTopicToTask(SAMPLE_CHAT_ID, SAMPLE_THREAD_ID, "mt#3507", {
        getDb: async () => db,
        getTask: async () => {
          throw new Error("task service unavailable");
        },
      })
    ).rejects.toThrow("task service unavailable");
    expect(queries).toHaveLength(0);
  });
});

describe("createTopicActuatorResolver (mt#3505)", () => {
  function stubActuator(): ChannelActuator {
    return {
      converse: async (text) => text,
      interrupt: async () => "stopped",
      reset: async () => "fresh",
      answerAsk: async () => "answered",
    };
  }

  test("resolves to the SAME actuator for the same thread id across calls", async () => {
    let buildCalls = 0;
    const resolve = createTopicActuatorResolver({
      chatId: "167346572",
      getDb: async () => null,
      buildActuator: () => {
        buildCalls += 1;
        return stubActuator();
      },
    });

    const first = await resolve(749667);
    const second = await resolve(749667);

    expect(second).toBe(first);
    expect(buildCalls).toBe(1);
  });

  test("resolves to DIFFERENT actuators for different thread ids", async () => {
    const resolve = createTopicActuatorResolver({
      chatId: "167346572",
      getDb: async () => null,
      buildActuator: stubActuator,
    });

    const a = await resolve(100);
    const b = await resolve(200);
    expect(a).not.toBe(b);
  });

  test("builds the actuator with the topic's deterministic localId", async () => {
    const seenLocalIds: string[] = [];
    const resolve = createTopicActuatorResolver({
      chatId: SAMPLE_CHAT_ID,
      getDb: async () => null,
      buildActuator: (localId) => {
        seenLocalIds.push(localId);
        return stubActuator();
      },
    });

    await resolve(SAMPLE_THREAD_ID);
    expect(seenLocalIds).toEqual([SAMPLE_LOCAL_ID]);
  });
});

describe("logTopicModeCapability (mt#3505)", () => {
  test("does not throw when topic mode is enabled", async () => {
    const getMe = async (): Promise<TelegramGetMeResult> => ({
      ok: true,
      hasTopicsEnabled: true,
      allowsUsersToCreateTopics: true,
    });
    await expect(logTopicModeCapability("tok", getMe)).resolves.toBeUndefined();
  });

  test("does not throw and does not block startup when topic mode is off", async () => {
    // AT: "when false, the channel behaves exactly as today with an
    // operator-legible log line rather than failing."
    const getMe = async (): Promise<TelegramGetMeResult> => ({
      ok: true,
      hasTopicsEnabled: false,
      allowsUsersToCreateTopics: false,
    });
    await expect(logTopicModeCapability("tok", getMe)).resolves.toBeUndefined();
  });

  test("does not throw when the probe itself fails", async () => {
    const getMe = async (): Promise<TelegramGetMeResult> => ({
      ok: false,
      detail: "network error",
    });
    await expect(logTopicModeCapability("tok", getMe)).resolves.toBeUndefined();
  });
});
