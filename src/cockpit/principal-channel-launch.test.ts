/**
 * Tests for the principal channel's composition root (mt#3228).
 *
 * The opt-in and permission-mode cases are the ones with teeth: both decide how
 * much authority an inbound Telegram message carries on this machine.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  _setPrincipalChannelStatusForTest,
  bindTelegramChannelTopicToTask,
  CREDENTIAL_RETRY_DELAYS_MS,
  CREDENTIAL_RETRY_MIN_DELAY_MS,
  createEventLogCursor,
  createTopicDriverResolver,
  ensureTelegramChannelTopic,
  getPrincipalChannelStatus,
  loadPrincipalChannelLaunchConfig,
  logTopicModeCapability,
  resetPrincipalChannelStatus,
  resolveAllowedUserIds,
  resolveWithRetry,
  startPrincipalChannel,
  telegramTopicLocalId,
  type DbLike,
  type PrincipalChannelStatus,
} from "./principal-channel-launch";
import type { ChannelDriver } from "./principal-channel-poller";
import type { SweepLivenessSnapshot } from "./sweepers";
import type { TelegramGetMeResult } from "@minsky/domain/notify/telegram-transport";
// The checked-in golden fixture both the bun and Rust sides pin (mt#2629).
// Imported (not read from disk) for the same reason health-contract.test.ts
// imports it: the contract IS the file's content, so no fs access is needed
// and `custom/no-real-fs-in-tests` stays satisfied without an exception.
import healthShapeFixture from "../../contract/cockpit-health-shape.json";

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
 * Telegram topic mapping + per-topic session driver wiring (mt#3505, parent
 * mt#3500). These are the composition-root pieces the poller's
 * `resolveTopicDriver` dep is built from.
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

describe("createTopicDriverResolver (mt#3505)", () => {
  function stubSessionDriver(): ChannelDriver {
    return {
      converse: async (text) => text,
      interrupt: async () => "stopped",
      reset: async () => "fresh",
      answerAsk: async () => "answered",
    };
  }

  test("resolves to the SAME session driver for the same thread id across calls", async () => {
    let buildCalls = 0;
    const resolve = createTopicDriverResolver({
      chatId: "167346572",
      getDb: async () => null,
      buildSessionDriver: () => {
        buildCalls += 1;
        return stubSessionDriver();
      },
    });

    const first = await resolve(749667);
    const second = await resolve(749667);

    expect(second).toBe(first);
    expect(buildCalls).toBe(1);
  });

  test("resolves to DIFFERENT session drivers for different thread ids", async () => {
    const resolve = createTopicDriverResolver({
      chatId: "167346572",
      getDb: async () => null,
      buildSessionDriver: stubSessionDriver,
    });

    const a = await resolve(100);
    const b = await resolve(200);
    expect(a).not.toBe(b);
  });

  test("builds the session driver with the topic's deterministic localId", async () => {
    const seenLocalIds: string[] = [];
    const resolve = createTopicDriverResolver({
      chatId: SAMPLE_CHAT_ID,
      getDb: async () => null,
      buildSessionDriver: (localId) => {
        seenLocalIds.push(localId);
        return stubSessionDriver();
      },
    });

    await resolve(SAMPLE_THREAD_ID);
    expect(seenLocalIds).toEqual([SAMPLE_LOCAL_ID]);
  });
});

/**
 * Credential-read retry and channel-status surfacing (mt#3608).
 *
 * The defect these pin: a transient failure reading the bot token — a DNS blip
 * against the Pulumi backend — used to be reported as "not configured", and the
 * launch path gives up permanently on that verdict. The channel then stayed off
 * for the life of the daemon with one `warn` as its only trace. Five times on
 * 2026-08-03.
 */
describe("resolveWithRetry (mt#3608)", () => {
  const CONFIGURED = {
    configured: true as const,
    config: { token: "t", chatId: "c", source: "pulumi" as const },
  };
  const TRANSIENT = {
    configured: false as const,
    transient: true,
    reason: "credentials could not be READ: getaddrinfo ENOTFOUND",
  };
  const UNCONFIGURED = {
    configured: false as const,
    transient: false,
    reason: "not configured: no token, no chat id",
  };

  /** Delays are injected as zeros so a retry sequence costs no wall-clock. */
  const NO_WAIT = [0, 0, 0];
  const sleep = async (): Promise<void> => {};

  test("AT1 — a read that fails once and then succeeds ends up CONFIGURED", async () => {
    let calls = 0;
    const resolve = async () => {
      calls += 1;
      return calls === 1 ? TRANSIENT : CONFIGURED;
    };

    const result = await resolveWithRetry({ resolve, sleep, delaysMs: NO_WAIT });

    expect(result.configured).toBe(true);
    expect(calls).toBe(2);
    // The retry is OVER, so the status must not still say "retrying" (PR #2582
    // R1). The first version of this test asserted `"retrying"` here — encoding
    // a stale status as the expected outcome, which is exactly the shape
    // mem#729 warns about: a test that pins the defect as an invariant.
    expect(getPrincipalChannelStatus().state).not.toBe("retrying");
    expect(getPrincipalChannelStatus().state).toBe("starting");
  });

  test("mt#3683 — a read failing WELL past the old 6-entry ceiling keeps RETRYING, never `failed` (negative control: this test fails against the pre-mt#3683 code, which gives up as `failed` after exactly 4 calls)", async () => {
    // Beyond NO_WAIT.length (3) — the old code gave up here. The new code
    // must not: it should still be asking, and eventually succeed, which is
    // this task's AT1 and SC5 ("a test drives the arc: credential read fails
    // past the current 6-attempt window, then succeeds, and the channel
    // reaches `running` with no process restart" — exercised here at the
    // resolveWithRetry level, the same unit `startPrincipalChannel` awaits).
    let calls = 0;
    const FAIL_COUNT = 9;
    const resolve = async () => {
      calls += 1;
      return calls <= FAIL_COUNT ? TRANSIENT : CONFIGURED;
    };
    const statusesObservedDuringRetry: string[] = [];
    const recordingSleep = async (): Promise<void> => {
      statusesObservedDuringRetry.push(getPrincipalChannelStatus().state);
    };

    const result = await resolveWithRetry({ resolve, sleep: recordingSleep, delaysMs: NO_WAIT });

    expect(result.configured).toBe(true);
    expect(calls).toBe(FAIL_COUNT + 1);
    // No restart happened — this is one continuous resolveWithRetry call.
    // Every observed intermediate status was "retrying", never "failed",
    // even well past the point the old schedule would have given up.
    expect(statusesObservedDuringRetry).toHaveLength(FAIL_COUNT);
    expect(statusesObservedDuringRetry.every((s) => s === "retrying")).toBe(true);
  });

  test("mt#3683 SC3 — a retrying status carries `lastAttemptAt` and a `nextAttemptAt` strictly later, distinguishing 'still retrying' from 'gave up'", async () => {
    let calls = 0;
    const resolve = async () => {
      calls += 1;
      return calls === 1 ? TRANSIENT : CONFIGURED;
    };
    let clockMs = 1_700_000_000_000;
    const now = () => clockMs;
    // A `const` array pushed-to from the injected `sleep`, not a reassigned
    // `let` — reassigning a captured `let` from a nested closure defeats
    // TypeScript's discriminant narrowing on that variable at the read site.
    const capturedDuringRetry: PrincipalChannelStatus[] = [];
    const capturingSleep = async (ms: number): Promise<void> => {
      capturedDuringRetry.push(getPrincipalChannelStatus());
      clockMs += ms;
    };

    await resolveWithRetry({
      resolve,
      sleep: capturingSleep,
      delaysMs: CREDENTIAL_RETRY_DELAYS_MS,
      now,
    });

    const status = capturedDuringRetry[0];
    expect(status?.state).toBe("retrying");
    if (status !== undefined && status.state === "retrying") {
      expect(status.lastAttemptAt).toBe(new Date(1_700_000_000_000).toISOString());
      expect(new Date(status.nextAttemptAt).getTime()).toBeGreaterThan(
        new Date(status.lastAttemptAt).getTime()
      );
    }
  });

  test("mt#3683 SC1 — past the seeded schedule, backoff keeps widening but is CAPPED, not uncapped exponential", async () => {
    const delaysSeen: number[] = [];
    let calls = 0;
    const FAIL_COUNT = 5;
    const resolve = async () => {
      calls += 1;
      return calls <= FAIL_COUNT ? TRANSIENT : CONFIGURED;
    };
    const recordingSleep = async (ms: number): Promise<void> => {
      delaysSeen.push(ms);
    };

    await resolveWithRetry({
      resolve,
      sleep: recordingSleep,
      delaysMs: [1_000],
      maxDelayMs: 4_000,
    });

    // Seeded once at 1s, then doubles (2s, 4s), then holds at the 4s cap —
    // never uncapped growth (8s, 16s, ...).
    expect(delaysSeen).toEqual([1_000, 2_000, 4_000, 4_000, 4_000]);
    expect(Math.max(...delaysSeen)).toBeLessThanOrEqual(4_000);
  });

  // -------------------------------------------------------------------------
  // mt#3689 — the backoff must not degenerate, and `attempts` must mean one
  // thing. The tests above all seed the schedule with positive values, so the
  // non-positive-seed path was never exercised.
  // -------------------------------------------------------------------------

  test("mt#3689 AT1 — a `[0]` seed produces POSITIVE, WIDENING waits instead of a busy loop", async () => {
    // The defect: past the seeded schedule the delay is the previous delay
    // DOUBLED, and 0 doubles to 0 forever — so `[0]` yielded an unbroken run of
    // zero-length waits, a spin inside the mechanism built to stop hammering.
    // Reachable today only through this very seam (`retryDelaysMs`) or a future
    // edit to the shipped constant, because the invariant was held by the
    // literal, not by the code.
    const waits: number[] = [];
    let calls = 0;
    const FAIL_COUNT = 6;
    const resolve = async () => {
      calls += 1;
      return calls <= FAIL_COUNT ? TRANSIENT : CONFIGURED;
    };

    const result = await resolveWithRetry({
      resolve,
      sleep: async (ms: number): Promise<void> => {
        waits.push(ms);
      },
      delaysMs: [0],
    });

    expect(result.configured).toBe(true);
    expect(waits).toHaveLength(FAIL_COUNT);
    // Positive is the floor requirement; widening is what makes it a BACKOFF
    // rather than a fixed-rate poll. Asserting the exact sequence pins both at
    // once — a clamp applied only to the output would give [1000] * 6 here,
    // which passes "every wait positive" and is still not a backoff.
    expect(waits.every((w) => w >= CREDENTIAL_RETRY_MIN_DELAY_MS)).toBe(true);
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000]);
  });

  test("mt#3689 — a NEGATIVE seed is floored too, and still respects the cap", async () => {
    // Stronger than the spec's `[0]` case: a negative delay would reach
    // `sleep()` as a negative argument. Same clamp covers it.
    const waits: number[] = [];
    let calls = 0;
    const FAIL_COUNT = 4;
    const resolve = async () => {
      calls += 1;
      return calls <= FAIL_COUNT ? TRANSIENT : CONFIGURED;
    };

    await resolveWithRetry({
      resolve,
      sleep: async (ms: number): Promise<void> => {
        waits.push(ms);
      },
      delaysMs: [-5_000],
      maxDelayMs: 3_000,
    });

    expect(waits.every((w) => w > 0)).toBe(true);
    expect(Math.max(...waits)).toBeLessThanOrEqual(3_000);
    expect(waits).toEqual([1_000, 2_000, 3_000, 3_000]);
  });

  test("mt#3689 PR #2662 R1 — a cap BELOW the floor still never yields a sub-floor wait", async () => {
    // The two bounds can be set to ask for incompatible things. Applying the
    // cap last returned `maxDelayMs` — below the floor — which made the clamp's
    // own contract false and reopened the spin it exists to close. The floor
    // wins: it is a correctness property, the cap is a rate preference.
    const waits: number[] = [];
    let calls = 0;
    const FAIL_COUNT = 3;
    const resolve = async () => {
      calls += 1;
      return calls <= FAIL_COUNT ? TRANSIENT : CONFIGURED;
    };

    await resolveWithRetry({
      resolve,
      sleep: async (ms: number): Promise<void> => {
        waits.push(ms);
      },
      delaysMs: [0],
      maxDelayMs: 10,
    });

    expect(waits).toHaveLength(FAIL_COUNT);
    expect(waits.every((w) => w >= CREDENTIAL_RETRY_MIN_DELAY_MS)).toBe(true);
  });

  test("mt#3689 — the clamp is INERT for the shipped schedule (no production behavior change)", async () => {
    // The floor is below every entry in CREDENTIAL_RETRY_DELAYS_MS, so this
    // change must be invisible in production. Asserting that explicitly keeps a
    // future floor increase from silently altering the real backoff.
    const waits: number[] = [];
    let calls = 0;
    const FAIL_COUNT = CREDENTIAL_RETRY_DELAYS_MS.length;
    const resolve = async () => {
      calls += 1;
      return calls <= FAIL_COUNT ? TRANSIENT : CONFIGURED;
    };

    await resolveWithRetry({
      resolve,
      sleep: async (ms: number): Promise<void> => {
        waits.push(ms);
      },
      delaysMs: CREDENTIAL_RETRY_DELAYS_MS,
    });

    expect(waits).toEqual([...CREDENTIAL_RETRY_DELAYS_MS]);
    expect(Math.min(...CREDENTIAL_RETRY_DELAYS_MS)).toBeGreaterThan(CREDENTIAL_RETRY_MIN_DELAY_MS);
  });

  test("mt#3689 AT3 — the two fault classes stay distinguishable, and `attempts` no longer straddles them", async () => {
    // `attempts` used to appear on BOTH `retrying` (a real count of credential
    // reads) and `failed` (always the literal 1, counting nothing — the failure
    // happened once, AFTER credentials resolved). One field, two meanings,
    // across the two classes an operator most needs to tell apart. mt#3683's
    // own root cause was established by reading `attempts: 7` against a
    // six-entry schedule, so this counter carries diagnostic weight exactly
    // when someone is under pressure.
    let calls = 0;
    const resolve = async () => {
      calls += 1;
      return calls === 1 ? TRANSIENT : CONFIGURED;
    };
    const capturedDuringRetry: PrincipalChannelStatus[] = [];

    await resolveWithRetry({
      resolve,
      sleep: async (): Promise<void> => {
        capturedDuringRetry.push(getPrincipalChannelStatus());
      },
      delaysMs: NO_WAIT,
    });

    // The credential-exhaustion class keeps its counter — it means something there.
    const retrying = capturedDuringRetry[0];
    expect(retrying?.state).toBe("retrying");
    if (retrying !== undefined && retrying.state === "retrying") {
      expect(typeof retrying.attempts).toBe("number");
    }

    // The post-credential class no longer carries one. Asserted against the
    // CHECKED-IN golden fixture rather than a locally-built literal: that file
    // is the shape both the bun and Rust sides pin, and — unlike the top-level
    // field set — this sub-object is not type-asserted by either contract test,
    // so nothing else would catch `attempts` being reinstated here.
    const failedVariant = (
      healthShapeFixture as {
        $principalChannelFieldVariants: { failedNonCredential: Record<string, unknown> };
      }
    ).$principalChannelFieldVariants.failedNonCredential;
    expect(failedVariant.state).toBe("failed");
    expect(typeof failedVariant.reason).toBe("string");
    expect("attempts" in failedVariant).toBe(false);
  });

  test("AT3 — a genuinely-unconfigured channel does NOT retry", async () => {
    let calls = 0;
    const resolve = async () => {
      calls += 1;
      return UNCONFIGURED;
    };

    const result = await resolveWithRetry({ resolve, sleep, delaysMs: NO_WAIT });

    expect(result.configured).toBe(false);
    // Exactly one attempt: retrying an absent credential only delays a message
    // the operator needs to see, and burns the Pulumi backend for nothing.
    expect(calls).toBe(1);
  });

  test("an unconfigured verdict mid-retry clears the stale `retrying`", async () => {
    // Transient first, then a definite absence — the status must follow the
    // LATEST verdict rather than stick on the retry that preceded it.
    let calls = 0;
    await resolveWithRetry({
      resolve: async () => {
        calls += 1;
        return calls === 1 ? TRANSIENT : UNCONFIGURED;
      },
      sleep,
      delaysMs: NO_WAIT,
    });

    expect(getPrincipalChannelStatus().state).not.toBe("retrying");
  });

  test("a success on the first attempt never sleeps", async () => {
    let slept = 0;
    const result = await resolveWithRetry({
      resolve: async () => CONFIGURED,
      sleep: async () => {
        slept += 1;
      },
      delaysMs: NO_WAIT,
    });

    expect(result.configured).toBe(true);
    expect(slept).toBe(0);
  });
});

describe("getPrincipalChannelStatus (mt#3608)", () => {
  test("a disabled channel reports disabled rather than looking broken", async () => {
    resetPrincipalChannelStatus();

    const handle = await startPrincipalChannel({
      config: { enabled: false, cwd: "/tmp", permissionMode: "default", allowedUserIds: [] },
      respondToAsk: async () => "unused",
      recordEvent: async () => "recorded" as const,
      readHighestUpdateId: async () => undefined,
    });

    expect(handle).toBeNull();
    // "off because you turned it off" must be distinguishable from "off because
    // something failed" — otherwise the health field cannot be alarmed on.
    expect(getPrincipalChannelStatus()).toEqual({ state: "disabled" });
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

describe("running-status projection over the liveness registry (mt#4183)", () => {
  const CHAT = "167346572";
  const SINCE = "2026-08-17T00:00:00.000Z";
  /** mt#4185 registers the poller under this name; the projection looks it up. */
  const SWEEP = "principal-channel poll";
  /** Budget 420s → the registry's stall threshold is 2x = 840s. */
  const BUDGET_MS = 420_000;

  afterEach(() => {
    resetPrincipalChannelStatus();
  });

  /** A registry snapshot carrying the poller entry with a chosen progress stamp. */
  function snapshotWith(lastAttemptAt: string | null): () => SweepLivenessSnapshot[] {
    return () => [
      {
        name: SWEEP,
        intervalMs: BUDGET_MS,
        lastAttemptAt,
        lastSuccessAt: lastAttemptAt,
        lastErrorAt: null,
        consecutiveFailures: 0,
        reinits: 0,
        metaRestarts: 0,
        lastDomainSuccessAt: null,
        lastDomainFailureAt: null,
        consecutiveDomainFailures: 0,
        reportsDomainOutcome: false,
        // mt#4412: the self-scheduling path DECLARES an outcome (its handle's
        // noteSuccess/noteFailure record one), even in a fixture that has not
        // reported one yet.
        declaresDomainOutcome: true,
        abandonedTicks: 0,
        abandonedTicksOutstanding: 0,
        abandonedTickHardReleases: 0,
        selfScheduled: true,
        registeredAt: SINCE,
      },
    ];
  }

  function seedRunning(): void {
    _setPrincipalChannelStatusForTest({
      state: "running",
      chatId: CHAT,
      since: SINCE,
      lastProgressAt: null,
    });
  }

  test("AT1: reports running right after a cycle, and stalled once progress goes stale", () => {
    seedRunning();
    const progressAt = "2026-08-17T01:00:00.000Z";
    const progressMs = Date.parse(progressAt);

    // Just after the cycle: inside the budget.
    const fresh = getPrincipalChannelStatus({
      now: () => progressMs + 1_000,
      snapshot: snapshotWith(progressAt),
    });
    expect(fresh.state).toBe("running");
    expect(fresh).toMatchObject({ lastProgressAt: progressAt });

    // Past 2x the budget: the state the 44-hour incident had no way to report.
    const stale = getPrincipalChannelStatus({
      now: () => progressMs + BUDGET_MS * 2 + 1_000,
      snapshot: snapshotWith(progressAt),
    });
    expect(stale.state).toBe("stalled");
    expect(stale).toMatchObject({
      chatId: CHAT,
      lastProgressAt: progressAt,
      thresholdMs: BUDGET_MS * 2,
    });
    // The staleness is carried, so "stalled 4 minutes" reads differently from
    // "stalled 4 days" without the reader doing arithmetic.
    if (stale.state === "stalled") {
      expect(stale.staleForMs).toBeGreaterThan(BUDGET_MS * 2);
    }
  });

  test("AT2: a loop reporting at the normal cadence never flaps to stalled", () => {
    seedRunning();
    const progressMs = Date.parse("2026-08-17T01:00:00.000Z");
    // A healthy long poll returns every ~25s against an 840s threshold. Sample
    // the whole span up to the boundary; none of it may report stalled.
    for (const elapsed of [0, 25_000, 60_000, 300_000, BUDGET_MS, BUDGET_MS * 2]) {
      const status = getPrincipalChannelStatus({
        now: () => progressMs + elapsed,
        snapshot: snapshotWith(new Date(progressMs).toISOString()),
      });
      expect(status.state).toBe("running");
    }
  });

  test("a park BEFORE the first progress call is stalled, measured from launch", () => {
    // The first-cycle case: `lastAttemptAt` is null forever, so anything keying
    // on it alone stays silent. Measuring against `since` is what makes it
    // visible here. (The registry-side half of the same gap is mt#4206.)
    seedRunning();
    const status = getPrincipalChannelStatus({
      now: () => Date.parse(SINCE) + BUDGET_MS * 2 + 1_000,
      snapshot: snapshotWith(null),
    });
    expect(status.state).toBe("stalled");
    expect(status).toMatchObject({ lastProgressAt: null });
  });

  test("a non-running state is returned untouched — only the latch needs projecting", () => {
    _setPrincipalChannelStatusForTest({ state: "unconfigured", reason: "no token" });
    const status = getPrincipalChannelStatus({
      now: () => Date.now(),
      snapshot: snapshotWith(null),
    });
    expect(status).toEqual({ state: "unconfigured", reason: "no token" });
  });

  test("no registrant in the snapshot leaves running alone rather than inventing a stall", () => {
    seedRunning();
    const status = getPrincipalChannelStatus({
      now: () => Date.parse(SINCE) + BUDGET_MS * 10,
      snapshot: () => [],
    });
    expect(status.state).toBe("running");
  });
});
