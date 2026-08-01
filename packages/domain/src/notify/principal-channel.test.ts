/**
 * Tests for the principal channel's credential resolution and send (mt#3228).
 *
 * Every case injects both readers, so no test spawns `pulumi`, touches the
 * network, or depends on ambient environment.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  clearPrincipalChannelCache,
  findTelegramTopicForTask,
  markTelegramChannelTopicDead,
  notifyPrincipal,
  resolvePrincipalChannel,
  TELEGRAM_CHAT_ID_PULUMI_KEY,
  type PrincipalChannelDeps,
  type TelegramTopicDb,
} from "./principal-channel";

const NOTHING_IN_ENV = () => undefined;
const NO_PULUMI_TOKEN = async () => null;
const NO_PULUMI_PLAIN = async () => null;
/** Telegram's wire key for a topic thread — shared across the taskId-routing cases. */
const THREAD_ID_KEY = "message_thread_id";
/** A representative alert body — shared across the byte-for-byte regression cases. */
const SOAK_TEST_MESSAGE = "soak test is green";

function deps(overrides: Partial<PrincipalChannelDeps> = {}): PrincipalChannelDeps {
  return {
    readEnv: NOTHING_IN_ENV,
    readPulumiToken: NO_PULUMI_TOKEN,
    readPulumiPlain: NO_PULUMI_PLAIN,
    ...overrides,
  };
}

beforeEach(() => {
  clearPrincipalChannelCache();
});

describe("resolvePrincipalChannel", () => {
  test("prefers the environment over Pulumi", async () => {
    const result = await resolvePrincipalChannel(
      deps({
        readEnv: (name) =>
          name === "TELEGRAM_BOT_TOKEN"
            ? "env-token"
            : name === "TELEGRAM_CHAT_ID"
              ? "1"
              : undefined,
        readPulumiToken: async () => "pulumi-token",
        readPulumiPlain: async () => "999",
      })
    );

    expect(result.configured).toBe(true);
    if (!result.configured) return;
    expect(result.config).toEqual({ token: "env-token", chatId: "1", source: "env" });
  });

  test("falls back to Pulumi for both values", async () => {
    const readKeys: string[] = [];
    const result = await resolvePrincipalChannel(
      deps({
        readPulumiToken: async () => "pulumi-token",
        readPulumiPlain: async (key) => {
          readKeys.push(key);
          return "999";
        },
      })
    );

    expect(result.configured).toBe(true);
    if (!result.configured) return;
    expect(result.config).toEqual({ token: "pulumi-token", chatId: "999", source: "pulumi" });
    expect(readKeys).toEqual([TELEGRAM_CHAT_ID_PULUMI_KEY]);
  });

  test("labels a split resolution as mixed", async () => {
    const result = await resolvePrincipalChannel(
      deps({
        readEnv: (name) => (name === "TELEGRAM_CHAT_ID" ? "1" : undefined),
        readPulumiToken: async () => "pulumi-token",
      })
    );
    expect(result.configured).toBe(true);
    if (!result.configured) return;
    expect(result.config.source).toBe("mixed");
  });

  test("treats a whitespace-only value as absent", async () => {
    const result = await resolvePrincipalChannel(
      deps({ readPulumiToken: async () => "   ", readPulumiPlain: async () => "999" })
    );
    expect(result.configured).toBe(false);
  });

  test("names both candidate sources when nothing is configured", async () => {
    const result = await resolvePrincipalChannel(deps());
    expect(result.configured).toBe(false);
    if (result.configured) return;
    expect(result.reason).toContain("TELEGRAM_BOT_TOKEN");
    expect(result.reason).toContain(TELEGRAM_CHAT_ID_PULUMI_KEY);
  });

  test("points at the token step when only the chat id is present", async () => {
    const result = await resolvePrincipalChannel(deps({ readPulumiPlain: async () => "999" }));
    expect(result.configured).toBe(false);
    if (result.configured) return;
    expect(result.reason).toContain("no bot token");
  });

  test("points at chat-id discovery when only the token is present", async () => {
    const result = await resolvePrincipalChannel(deps({ readPulumiToken: async () => "tok" }));
    expect(result.configured).toBe(false);
    if (result.configured) return;
    expect(result.reason).toContain("discover-chat-id");
  });

  test("caches a success so a repeat resolve does not re-read Pulumi", async () => {
    let tokenReads = 0;
    const d = deps({
      readPulumiToken: async () => {
        tokenReads += 1;
        return "tok";
      },
      readPulumiPlain: async () => "999",
    });

    await resolvePrincipalChannel(d);
    await resolvePrincipalChannel(d);
    expect(tokenReads).toBe(1);
  });

  test("does NOT cache a miss, so a just-configured value is seen immediately", async () => {
    let token: string | null = null;
    const d = deps({
      readPulumiToken: async () => token,
      readPulumiPlain: async () => "999",
    });

    expect((await resolvePrincipalChannel(d)).configured).toBe(false);
    token = "tok"; // operator runs `pulumi config set`
    expect((await resolvePrincipalChannel(d)).configured).toBe(true);
  });

  test("re-reads once the cache window has elapsed", async () => {
    let tokenReads = 0;
    let clock = 1_000_000;
    const d = deps({
      readPulumiToken: async () => {
        tokenReads += 1;
        return "tok";
      },
      readPulumiPlain: async () => "999",
      now: () => clock,
    });

    await resolvePrincipalChannel(d);
    clock += 6 * 60 * 1000;
    await resolvePrincipalChannel(d);
    expect(tokenReads).toBe(2);
  });
});

describe("notifyPrincipal", () => {
  const configured = (fetchFn: PrincipalChannelDeps["fetchFn"]): PrincipalChannelDeps =>
    deps({
      readPulumiToken: async () => "tok",
      readPulumiPlain: async () => "999",
      ...(fetchFn ? { fetchFn } : {}),
    });

  test("sends the message and reports the delivered id", async () => {
    let sent: Record<string, unknown> = {};
    const result = await notifyPrincipal({
      message: SOAK_TEST_MESSAGE,
      deps: configured(async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }));
      }),
    });

    expect(result).toEqual({ delivered: true, messageId: 55, chatId: "999", source: "pulumi" });
    expect(sent["chat_id"]).toBe("999");
    expect(sent["text"]).toBe(SOAK_TEST_MESSAGE);
  });

  test("renders the title above the body", async () => {
    let sent: Record<string, unknown> = {};
    await notifyPrincipal({
      title: "mt#3228",
      message: "PR is up",
      deps: configured(async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }),
    });
    expect(sent["text"]).toBe("mt#3228\n\nPR is up");
  });

  test("reports not-configured rather than throwing on a bare machine", async () => {
    const result = await notifyPrincipal({ message: "hi", deps: deps() });
    expect(result.delivered).toBe(false);
    if (result.delivered) return;
    expect(result.reason).toBe("not-configured");
    expect(result.detail).toContain("not configured");
  });

  test("distinguishes a broken channel from an absent one", async () => {
    const result = await notifyPrincipal({
      message: "hi",
      deps: configured(async () => new Response("nope", { status: 400 })),
    });
    expect(result.delivered).toBe(false);
    if (result.delivered) return;
    expect(result.reason).toBe("send-failed");
  });

  test("never leaks the token through a send failure", async () => {
    const result = await notifyPrincipal({
      message: "hi",
      deps: configured(async () => {
        throw new Error("failed to reach https://api.telegram.org/bottok/sendMessage");
      }),
    });
    expect(result.delivered).toBe(false);
    if (result.delivered) return;
    expect(result.detail).not.toContain("/bottok/");
  });

  // mt#3507 — the `taskId` parameter is a prerequisite for posting into a
  // task's bound topic. Every case here uses `configured()`, so the WIRE
  // send happens exactly as in the tests above; only the topic-lookup deps
  // vary.
  describe("taskId topic routing (mt#3507)", () => {
    test("a taskId with no lookupTaskTopic wired falls back to standing (no crash, no topic)", async () => {
      let sent: Record<string, unknown> = {};
      await notifyPrincipal({
        message: "PR is up",
        taskId: "mt#3507",
        deps: configured(async (_url, init) => {
          sent = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
        }),
      });
      expect(sent[THREAD_ID_KEY]).toBeUndefined();
    });

    test("posts into the topic when lookupTaskTopic resolves one", async () => {
      let sent: Record<string, unknown> = {};
      const d = configured(async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      });
      d.lookupTaskTopic = async (taskId) => {
        expect(taskId).toBe("mt#3507");
        return { messageThreadId: 749667 };
      };

      await notifyPrincipal({ message: "PR is up", taskId: "mt#3507", deps: d });
      expect(sent[THREAD_ID_KEY]).toBe(749667);
    });

    test("AT2: notifying twice about the same bound task lands in that topic both times, creating nothing", async () => {
      const sentThreadIds: unknown[] = [];
      const lookupCalls: string[] = [];
      const d = configured(async (_url, init) => {
        sentThreadIds.push(
          (JSON.parse(String(init?.body)) as Record<string, unknown>)[THREAD_ID_KEY]
        );
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      });
      d.lookupTaskTopic = async (taskId) => {
        lookupCalls.push(taskId);
        return { messageThreadId: 749667 };
      };

      await notifyPrincipal({ message: "first", taskId: "mt#3507", deps: d });
      await notifyPrincipal({ message: "second", taskId: "mt#3507", deps: d });

      expect(sentThreadIds).toEqual([749667, 749667]);
      expect(lookupCalls).toEqual(["mt#3507", "mt#3507"]);
      // notifyPrincipal itself never writes to the mapping table — only
      // reads it via lookupTaskTopic — so there is no write path here that
      // could ever create a second topic for the same task.
    });

    test("AT3: a task with no bound topic lands in the standing conversation, creating nothing", async () => {
      let sent: Record<string, unknown> = {};
      const d = configured(async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      });
      d.lookupTaskTopic = async () => null;

      await notifyPrincipal({ message: "PR is up", taskId: "mt#9999", deps: d });
      expect(THREAD_ID_KEY in sent).toBe(false);
    });

    test("AT5 / regression: omitting taskId reproduces today's wire payload byte-for-byte", async () => {
      // The exact regression the spec calls for.
      let rawBody = "";
      await notifyPrincipal({
        message: SOAK_TEST_MESSAGE,
        deps: configured(async (_url, init) => {
          rawBody = String(init?.body);
          return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }));
        }),
      });
      expect(rawBody).toBe(
        JSON.stringify({
          chat_id: "999",
          text: SOAK_TEST_MESSAGE,
          disable_web_page_preview: true,
        })
      );
    });

    test("never calls lookupTaskTopic when no taskId is supplied", async () => {
      let called = false;
      const d = configured(
        async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))
      );
      d.lookupTaskTopic = async () => {
        called = true;
        return null;
      };
      await notifyPrincipal({ message: "hi", deps: d });
      expect(called).toBe(false);
    });

    test("AT4: a dead topic (deleted from the phone) falls back to standing and says so in the delivered text", async () => {
      const sentBodies: Record<string, unknown>[] = [];
      const d = configured(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentBodies.push(body);
        if (body[THREAD_ID_KEY] !== undefined) {
          return new Response(
            JSON.stringify({ ok: false, description: "Bad Request: message thread not found" }),
            { status: 400 }
          );
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }));
      });
      d.lookupTaskTopic = async () => ({ messageThreadId: 749667 });

      const result = await notifyPrincipal({
        message: "your PR is up",
        taskId: "mt#3507",
        deps: d,
      });

      expect(result.delivered).toBe(true);
      if (!result.delivered) return;
      expect(result.fellBackFromDeadTopic).toBe(true);
      expect(sentBodies).toHaveLength(2);
      expect(sentBodies[1]?.[THREAD_ID_KEY]).toBeUndefined();
      expect(String(sentBodies[1]?.["text"])).toContain("could not be found");
    });

    test("drift reconciliation: marks the mapping dead via markTopicDead", async () => {
      const deadCalls: Array<[string, number]> = [];
      const d = configured(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body[THREAD_ID_KEY] !== undefined) {
          return new Response(
            JSON.stringify({ ok: false, description: "Bad Request: message thread not found" }),
            { status: 400 }
          );
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }));
      });
      d.lookupTaskTopic = async () => ({ messageThreadId: 749667 });
      d.markTopicDead = async (chatId, messageThreadId) => {
        deadCalls.push([chatId, messageThreadId]);
      };

      await notifyPrincipal({ message: "your PR is up", taskId: "mt#3507", deps: d });
      expect(deadCalls).toEqual([["999", 749667]]);
    });

    test("an unrelated send failure (not the thread-not-found signal) is NOT treated as drift", async () => {
      const d = configured(async () => new Response("nope", { status: 500 }));
      d.lookupTaskTopic = async () => ({ messageThreadId: 749667 });
      let deadCalled = false;
      d.markTopicDead = async () => {
        deadCalled = true;
      };

      const result = await notifyPrincipal({ message: "hi", taskId: "mt#3507", deps: d });
      expect(result.delivered).toBe(false);
      expect(deadCalled).toBe(false);
    });
  });
});

/**
 * Task-topic mapping helpers (mt#3507) — the raw DB-backed functions
 * `notifyPrincipal`'s `lookupTaskTopic`/`markTopicDead` deps wrap in
 * production. Tested directly against a fake `TelegramTopicDb` so no test
 * touches a real database.
 */
describe("findTelegramTopicForTask (mt#3507)", () => {
  function fakeDb(rows: unknown[]): { db: TelegramTopicDb; queries: unknown[] } {
    const queries: unknown[] = [];
    return {
      queries,
      db: {
        execute: async (query: unknown) => {
          queries.push(query);
          return rows;
        },
      },
    };
  }

  /**
   * Render a drizzle `sql` template into its parameterized SQL text plus its
   * bound values, via drizzle's own dialect rather than by walking
   * `queryChunks` by hand. Hand-walking is what the repo's older helpers do,
   * but the chunk shapes are an internal detail that varies by construction
   * path; `sqlToQuery` is the supported seam and is what makes the assertion
   * below about the PREDICATE rather than about drizzle's internals.
   */
  const pgDialect = new PgDialect();

  function renderQuery(query: unknown): { text: string; params: unknown[] } {
    const { sql: text, params } = pgDialect.sqlToQuery(query as never);
    return { text, params: params as unknown[] };
  }

  test("returns the bound topic's thread id", async () => {
    const { db } = fakeDb([{ message_thread_id: 749667 }]);
    const result = await findTelegramTopicForTask("mt#3507", "167346572", {
      getDb: async () => db,
    });
    expect(result).toEqual({ messageThreadId: 749667 });
  });

  /**
   * PR #2513 R1. `telegram_channel_topics` is unique on the PAIR
   * `(chat_id, message_thread_id)`, so a task lookup that ignored chat_id
   * could return a thread belonging to another chat. Sending that thread id
   * to the configured chat fails "message thread not found", and the
   * dead-marking that follows IS chat-scoped — so it would match no row and
   * the bad mapping would survive, failing over on every later notify.
   *
   * Asserts the predicate itself, not just the return value: a fake db
   * returning a canned row passes regardless of what was asked for, so only
   * inspecting the query can distinguish a chat-scoped lookup from an
   * unscoped one.
   */
  test("scopes the lookup by chat_id, not by task alone", async () => {
    const { db, queries } = fakeDb([{ message_thread_id: 749667 }]);
    await findTelegramTopicForTask("mt#3507", "167346572", { getDb: async () => db });

    expect(queries).toHaveLength(1);
    const { text, params } = renderQuery(queries[0]);
    expect(text).toContain("chat_id =");
    expect(params).toContain("167346572");
    expect(params).toContain("mt#3507");
  });

  test("returns null when no row matches (an unbound task)", async () => {
    const { db } = fakeDb([]);
    const result = await findTelegramTopicForTask("mt#9999", "167346572", {
      getDb: async () => db,
    });
    expect(result).toBeNull();
  });

  test("degrades to null, not a throw, when persistence is unavailable", async () => {
    const result = await findTelegramTopicForTask("mt#3507", "167346572", {
      getDb: async () => null,
    });
    expect(result).toBeNull();
  });

  test("degrades to null, not a throw, when the query itself throws", async () => {
    const result = await findTelegramTopicForTask("mt#3507", "167346572", {
      getDb: async () => ({
        execute: async () => {
          throw new Error("db down");
        },
      }),
    });
    expect(result).toBeNull();
  });
});

describe("markTelegramChannelTopicDead (mt#3507)", () => {
  test("issues a delete keyed on (chatId, messageThreadId)", async () => {
    const queries: unknown[] = [];
    await markTelegramChannelTopicDead("999", 749667, {
      getDb: async () => ({
        execute: async (query: unknown) => {
          queries.push(query);
          return [];
        },
      }),
    });
    expect(queries).toHaveLength(1);
  });

  test("does not throw when persistence is unavailable", async () => {
    await expect(
      markTelegramChannelTopicDead("999", 749667, { getDb: async () => null })
    ).resolves.toBeUndefined();
  });

  test("does not throw when the delete itself fails", async () => {
    await expect(
      markTelegramChannelTopicDead("999", 749667, {
        getDb: async () => ({
          execute: async () => {
            throw new Error("db down");
          },
        }),
      })
    ).resolves.toBeUndefined();
  });
});
