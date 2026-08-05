/**
 * Tests for PostgresChannelListener (mt#1852).
 *
 * Strategy: the production class is tested against a stub `Sql` that
 * implements just the `.listen()` method we depend on. The stub captures
 * the dispatch callback so tests can manually invoke it (simulating NOTIFY
 * delivery from Postgres). Failure modes (listen throws, unlisten throws)
 * are tested by configuring the stub to throw.
 *
 * The recording and no-op variants are tested directly via their public
 * surfaces.
 */

import { describe, test, expect } from "bun:test";
import {
  HEARTBEAT_CHANNEL,
  PostgresChannelListener,
  createNoopChannelListener,
  createRecordingChannelListener,
  type ChannelListener,
} from "./postgres-channel-listener";

// ---------------------------------------------------------------------------
// Stub `Sql` for testing the production class
// ---------------------------------------------------------------------------

type ListenCallback = (payload: string) => void;

interface ListenHandle {
  unlisten: () => Promise<void>;
}

interface StubListenRecord {
  channel: string;
  callback: ListenCallback;
  handle: ListenHandle;
  unlistened: boolean;
}

interface StubSql {
  listen(channel: string, callback: ListenCallback): Promise<ListenHandle>;
  /** postgres-js teardown; `reconnect()` calls this on the wedged connection. */
  end(opts?: { timeout?: number }): Promise<void>;
  /** Internal: how many times end() was called. */
  __endCalls: number;
  /** Internal: make the NEXT end() call throw (a wedged conn may not close). */
  __failNextEnd(err: Error): void;
  /** Internal: trigger a NOTIFY delivery to the channel's current callback. */
  __deliver(channel: string, raw: string): void;
  /** Internal: record of every listen() invocation in order. */
  __listens: StubListenRecord[];
  /** Internal: configure the NEXT N listen() calls to throw. */
  __failNextListens(n: number, err: Error): void;
  /** Internal: configure the NEXT N unlisten() calls to throw. */
  __failNextUnlistens(n: number, err: Error): void;
}

function createStubSql(): StubSql {
  const listens: StubListenRecord[] = [];
  let listensToFail = 0;
  let listenFailError: Error | null = null;
  let unlistensToFail = 0;
  let unlistenFailError: Error | null = null;
  let endToFail = false;
  let endFailError: Error | null = null;

  const stub: StubSql = {
    async listen(channel: string, callback: ListenCallback): Promise<ListenHandle> {
      if (listensToFail > 0) {
        listensToFail--;
        const err = listenFailError ?? new Error("stub: simulated listen failure");
        throw err;
      }

      const record: StubListenRecord = {
        channel,
        callback,
        handle: null as unknown as ListenHandle,
        unlistened: false,
      };
      record.handle = {
        async unlisten(): Promise<void> {
          if (unlistensToFail > 0) {
            unlistensToFail--;
            const err = unlistenFailError ?? new Error("stub: simulated unlisten failure");
            throw err;
          }
          record.unlistened = true;
        },
      };
      listens.push(record);
      return record.handle;
    },

    __endCalls: 0,

    async end(): Promise<void> {
      stub.__endCalls++;
      if (endToFail) {
        endToFail = false;
        throw endFailError ?? new Error("stub: simulated end failure");
      }
    },

    __failNextEnd(err: Error): void {
      endToFail = true;
      endFailError = err;
    },

    __deliver(channel: string, raw: string): void {
      // Deliver to the MOST RECENT non-unlistened record for the channel.
      // This mirrors postgres-js: one LISTEN per channel; old handles are dead.
      for (let i = listens.length - 1; i >= 0; i--) {
        const r = listens[i];
        if (r && r.channel === channel && !r.unlistened) {
          r.callback(raw);
          return;
        }
      }
    },

    __listens: listens,

    __failNextListens(n: number, err: Error): void {
      listensToFail = n;
      listenFailError = err;
    },

    __failNextUnlistens(n: number, err: Error): void {
      unlistensToFail = n;
      unlistenFailError = err;
    },
  };

  return stub;
}

// Type assertion helper: cast our StubSql to the Sql shape the listener accepts.
// The listener only touches `.listen()`, so the stub-as-Sql assertion is safe.
function asSql(stub: StubSql): ConstructorParameters<typeof PostgresChannelListener>[0] {
  return stub as unknown as ConstructorParameters<typeof PostgresChannelListener>[0];
}

// Test helper: get the Nth listen record, throwing a clear error if missing.
// Used instead of `!` non-null assertions to satisfy the
// `@typescript-eslint/no-non-null-assertion` rule.
function getListenAt(stub: StubSql, index: number): StubListenRecord {
  const record = stub.__listens[index];
  if (!record) {
    throw new Error(`expected stub.__listens[${index}] to be defined`);
  }
  return record;
}

// ---------------------------------------------------------------------------
// PostgresChannelListener — subscribe/unsubscribe/dispatch
// ---------------------------------------------------------------------------

describe("PostgresChannelListener — subscribe / dispatch / unsubscribe", () => {
  test("subscribe registers a single LISTEN per channel; dispatch delivers parsed payload", async () => {
    const sql = createStubSql();
    const listener = new PostgresChannelListener(asSql(sql));
    const received: Array<{ channel: string; payload: unknown }> = [];

    await listener.subscribe("test.channel", (channel, payload) => {
      received.push({ channel, payload });
    });

    expect(sql.__listens.length).toBe(1);
    expect(getListenAt(sql, 0).channel).toBe("test.channel");

    sql.__deliver("test.channel", JSON.stringify({ hello: "world" }));

    expect(received).toEqual([{ channel: "test.channel", payload: { hello: "world" } }]);

    await listener.close();
  });

  test("two subscribers on different channels each receive only their own payloads", async () => {
    const sql = createStubSql();
    const listener = new PostgresChannelListener(asSql(sql));
    const aReceived: unknown[] = [];
    const bReceived: unknown[] = [];

    await listener.subscribe("channel.a", (_c, p) => {
      aReceived.push(p);
    });
    await listener.subscribe("channel.b", (_c, p) => {
      bReceived.push(p);
    });

    expect(sql.__listens.length).toBe(2);

    sql.__deliver("channel.a", JSON.stringify({ id: 1 }));
    sql.__deliver("channel.b", JSON.stringify({ id: 2 }));
    sql.__deliver("channel.a", JSON.stringify({ id: 3 }));

    expect(aReceived).toEqual([{ id: 1 }, { id: 3 }]);
    expect(bReceived).toEqual([{ id: 2 }]);

    await listener.close();
  });

  test("concurrent subscribe() calls on the same channel issue only ONE postgres-js LISTEN (PR #1135 R1 BLOCKING)", async () => {
    // Race regression: previously both concurrent subscribe() calls would pass
    // the `if (state.unlisten)` check and both call listenWithRetry(),
    // resulting in two LISTEN registrations and a leaked handle. The
    // in-flight-promise guard added in PR #1135 fixes this.
    const sql = createStubSql();
    const listener = new PostgresChannelListener(asSql(sql));
    const recvA: unknown[] = [];
    const recvB: unknown[] = [];

    // Issue both subscribes WITHOUT awaiting individually — concurrent dispatch.
    const [resA, resB] = await Promise.all([
      listener.subscribe("racy", (_c, p) => {
        recvA.push(p);
      }),
      listener.subscribe("racy", (_c, p) => {
        recvB.push(p);
      }),
    ]);

    expect(resA).toBeUndefined();
    expect(resB).toBeUndefined();
    // Critical invariant: exactly ONE LISTEN registration despite two
    // concurrent subscribers.
    expect(sql.__listens.length).toBe(1);

    // Both subscribers receive the payload through the multiplexed dispatch.
    sql.__deliver("racy", JSON.stringify({ v: 99 }));
    expect(recvA).toEqual([{ v: 99 }]);
    expect(recvB).toEqual([{ v: 99 }]);

    await listener.close();
  });

  test("multi-listener multiplexing on one channel — only ONE postgres-js LISTEN, both fire", async () => {
    const sql = createStubSql();
    const listener = new PostgresChannelListener(asSql(sql));
    const recvA: unknown[] = [];
    const recvB: unknown[] = [];

    await listener.subscribe("shared", (_c, p) => {
      recvA.push(p);
    });
    await listener.subscribe("shared", (_c, p) => {
      recvB.push(p);
    });

    // Only one LISTEN registered with Postgres despite two subscribers.
    expect(sql.__listens.length).toBe(1);

    sql.__deliver("shared", JSON.stringify({ v: 42 }));

    expect(recvA).toEqual([{ v: 42 }]);
    expect(recvB).toEqual([{ v: 42 }]);

    await listener.close();
  });

  test("unsubscribe removes one listener but leaves channel LISTEN active for siblings", async () => {
    const sql = createStubSql();
    const listener = new PostgresChannelListener(asSql(sql));
    const recvA: unknown[] = [];
    const recvB: unknown[] = [];
    const fnA = (_c: string, p: unknown) => {
      recvA.push(p);
    };
    const fnB = (_c: string, p: unknown) => {
      recvB.push(p);
    };

    await listener.subscribe("shared", fnA);
    await listener.subscribe("shared", fnB);
    await listener.unsubscribe("shared", fnA);

    expect(getListenAt(sql, 0).unlistened).toBe(false); // LISTEN still active for B

    sql.__deliver("shared", JSON.stringify({ v: 1 }));
    expect(recvA).toEqual([]);
    expect(recvB).toEqual([{ v: 1 }]);

    await listener.close();
  });

  test("unsubscribing the LAST listener tears down the LISTEN", async () => {
    const sql = createStubSql();
    const listener = new PostgresChannelListener(asSql(sql));
    const fn = (_c: string, _p: unknown) => {};

    await listener.subscribe("solo", fn);
    expect(getListenAt(sql, 0).unlistened).toBe(false);

    await listener.unsubscribe("solo", fn);
    expect(getListenAt(sql, 0).unlistened).toBe(true);

    await listener.close();
  });

  test("unsubscribe is a no-op for unknown channel/listener", async () => {
    const sql = createStubSql();
    const listener = new PostgresChannelListener(asSql(sql));
    const fn = (_c: string, _p: unknown) => {};

    await listener.unsubscribe("nonexistent", fn); // should not throw

    await listener.subscribe("real", fn);
    const otherFn = (_c: string, _p: unknown) => {};
    await listener.unsubscribe("real", otherFn); // not registered — no-op

    // Original listener still registered.
    const recv: unknown[] = [];
    await listener.subscribe("real", (_c, p) => {
      recv.push(p);
    });
    sql.__deliver("real", JSON.stringify({ ok: true }));
    expect(recv).toEqual([{ ok: true }]);

    await listener.close();
  });
});

// ---------------------------------------------------------------------------
// PostgresChannelListener — parse + error containment
// ---------------------------------------------------------------------------

describe("PostgresChannelListener — parse and error containment", () => {
  test("custom `parse` override is applied to received payloads", async () => {
    const sql = createStubSql();
    const listener = new PostgresChannelListener(asSql(sql));
    const received: unknown[] = [];

    await listener.subscribe<string>(
      "raw.channel",
      (_c, p) => {
        received.push(p);
      },
      { parse: (raw) => raw.toUpperCase() }
    );

    sql.__deliver("raw.channel", "hello");

    expect(received).toEqual(["HELLO"]);

    await listener.close();
  });

  test("parse error skips one listener but does not break dispatch to others", async () => {
    const sql = createStubSql();
    const listener = new PostgresChannelListener(asSql(sql));
    const goodReceived: unknown[] = [];
    const badReceived: unknown[] = [];

    await listener.subscribe(
      "mixed",
      (_c, p) => {
        badReceived.push(p);
      },
      {
        parse: () => {
          throw new Error("custom parser fails");
        },
      }
    );
    await listener.subscribe("mixed", (_c, p) => {
      goodReceived.push(p);
    });

    sql.__deliver("mixed", JSON.stringify({ id: 1 }));

    expect(badReceived).toEqual([]);
    expect(goodReceived).toEqual([{ id: 1 }]);

    await listener.close();
  });

  test("sync listener error does not interrupt dispatch to siblings", async () => {
    const sql = createStubSql();
    const listener = new PostgresChannelListener(asSql(sql));
    const recv: unknown[] = [];

    await listener.subscribe("multi", () => {
      throw new Error("listener A throws");
    });
    await listener.subscribe("multi", (_c, p) => {
      recv.push(p);
    });

    sql.__deliver("multi", JSON.stringify({ v: 1 }));

    expect(recv).toEqual([{ v: 1 }]);

    await listener.close();
  });

  test("async listener rejection does not interrupt dispatch to siblings", async () => {
    const sql = createStubSql();
    const listener = new PostgresChannelListener(asSql(sql));
    const recv: unknown[] = [];

    await listener.subscribe("multi", async () => {
      throw new Error("async listener A rejects");
    });
    await listener.subscribe("multi", (_c, p) => {
      recv.push(p);
    });

    sql.__deliver("multi", JSON.stringify({ v: 1 }));

    expect(recv).toEqual([{ v: 1 }]);

    // Let microtasks settle so the async rejection's catch handler runs;
    // we don't assert on the log, just that the test doesn't trip an
    // unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 0));

    await listener.close();
  });
});

// ---------------------------------------------------------------------------
// PostgresChannelListener — reconnect / retry
// ---------------------------------------------------------------------------

// Tiny retry config for fast unit tests; defaults are tuned for production-startup
// scenarios where the database may take seconds to come online.
const FAST_RETRY = { initialBackoffMs: 1, maxBackoffMs: 5, backoffMultiplier: 2, maxAttempts: 5 };

describe("PostgresChannelListener — retry on initial listen failure", () => {
  test("initial listen failure retries with backoff and succeeds on subsequent attempt", async () => {
    const sql = createStubSql();
    sql.__failNextListens(2, new Error("connection refused"));
    const listener = new PostgresChannelListener(asSql(sql), FAST_RETRY);
    const recv: unknown[] = [];

    await listener.subscribe("retry.channel", (_c, p) => {
      recv.push(p);
    });

    // After 2 failures + 1 success, the LISTEN is active.
    expect(sql.__listens.length).toBe(1);
    expect(getListenAt(sql, 0).channel).toBe("retry.channel");

    sql.__deliver("retry.channel", JSON.stringify({ ok: true }));
    expect(recv).toEqual([{ ok: true }]);

    await listener.close();
  });

  test("listen failure after exhausting all retries throws and leaves no zombie subscription", async () => {
    const sql = createStubSql();
    // Fail all 5 fast-retry attempts.
    sql.__failNextListens(5, new Error("permanent failure"));
    const listener = new PostgresChannelListener(asSql(sql), FAST_RETRY);

    let threw = false;
    try {
      await listener.subscribe("doomed", () => {});
    } catch (err) {
      threw = true;
      expect(err instanceof Error).toBe(true);
      expect((err as Error).message).toContain("doomed");
    }
    expect(threw).toBe(true);

    // No zombie state — re-subscribing on the channel should work normally
    // once listens succeed.
    const recv: unknown[] = [];
    await listener.subscribe("doomed", (_c, p) => {
      recv.push(p);
    });
    sql.__deliver("doomed", JSON.stringify({ v: 1 }));
    expect(recv).toEqual([{ v: 1 }]);

    await listener.close();
  });
});

// ---------------------------------------------------------------------------
// PostgresChannelListener — close()
// ---------------------------------------------------------------------------

describe("PostgresChannelListener — close()", () => {
  test("close() tears down all LISTEN registrations", async () => {
    const sql = createStubSql();
    const listener = new PostgresChannelListener(asSql(sql));

    await listener.subscribe("a", () => {});
    await listener.subscribe("b", () => {});
    await listener.subscribe("c", () => {});

    expect(sql.__listens.length).toBe(3);
    expect(sql.__listens.every((r) => !r.unlistened)).toBe(true);

    await listener.close();

    expect(sql.__listens.every((r) => r.unlistened)).toBe(true);
  });

  test("close() prevents further subscribes", async () => {
    const sql = createStubSql();
    const listener = new PostgresChannelListener(asSql(sql));

    await listener.close();

    let threw = false;
    try {
      await listener.subscribe("post-close", () => {});
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("after close()");
    }
    expect(threw).toBe(true);
  });

  test("close() tolerates unlisten failures (logs but does not throw)", async () => {
    const sql = createStubSql();
    const listener = new PostgresChannelListener(asSql(sql));

    await listener.subscribe("flaky", () => {});
    sql.__failNextUnlistens(1, new Error("flaky unlisten"));

    // close() must not throw despite unlisten failure.
    await listener.close();
  });
});

// ---------------------------------------------------------------------------
// createNoopChannelListener
// ---------------------------------------------------------------------------

describe("createNoopChannelListener", () => {
  test("subscribe / unsubscribe / close all succeed silently", async () => {
    const listener: ChannelListener = createNoopChannelListener();

    await listener.subscribe("any", () => {});
    await listener.unsubscribe("any", () => {});
    await listener.close();
    await listener.subscribe("post-close", () => {}); // no-op even post-close
  });
});

// ---------------------------------------------------------------------------
// createRecordingChannelListener
// ---------------------------------------------------------------------------

describe("createRecordingChannelListener", () => {
  test("emit() delivers payloads to subscribers and records them", async () => {
    const listener = createRecordingChannelListener();
    const recv: unknown[] = [];

    await listener.subscribe("rec.channel", (_c, p) => {
      recv.push(p);
    });

    listener.emit("rec.channel", JSON.stringify({ a: 1 }));
    listener.emit("rec.channel", JSON.stringify({ a: 2 }));

    expect(recv).toEqual([{ a: 1 }, { a: 2 }]);
    expect(listener.capturedEvents).toEqual([
      { channel: "rec.channel", payload: { a: 1 } },
      { channel: "rec.channel", payload: { a: 2 } },
    ]);
  });

  test("emit() to unsubscribed channel is a no-op", () => {
    const listener = createRecordingChannelListener();
    listener.emit("ghost", JSON.stringify({ x: 1 }));
    expect(listener.capturedEvents).toEqual([]);
  });

  test("registeredChannels() reflects currently-subscribed channels", async () => {
    const listener = createRecordingChannelListener();
    expect(listener.registeredChannels()).toEqual([]);

    const fnA = () => {};
    await listener.subscribe("a", fnA);
    await listener.subscribe("b", () => {});
    expect(listener.registeredChannels().sort()).toEqual(["a", "b"]);

    await listener.unsubscribe("a", fnA);
    expect(listener.registeredChannels()).toEqual(["b"]);
  });

  test("close() prevents further subscribes", async () => {
    const listener = createRecordingChannelListener();
    await listener.close();
    let threw = false;
    try {
      await listener.subscribe("x", () => {});
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("after close()");
    }
    expect(threw).toBe(true);
  });

  test("custom `parse` override applies to emitted payloads", async () => {
    const listener = createRecordingChannelListener();
    const recv: unknown[] = [];
    await listener.subscribe<string>(
      "raw",
      (_c, p) => {
        recv.push(p);
      },
      {
        parse: (raw) => `parsed:${raw}`,
      }
    );
    listener.emit("raw", "input");
    expect(recv).toEqual(["parsed:input"]);
    expect(listener.capturedEvents).toEqual([{ channel: "raw", payload: "parsed:input" }]);
  });
});

// ---------------------------------------------------------------------------
// Heartbeat / self-reconnect (mt#3497)
// ---------------------------------------------------------------------------

/**
 * These drive `heartbeatTick()` directly rather than waiting on the interval —
 * the tick returns its decision, so no timer and no spying is needed to observe
 * the state machine.
 */
describe("PostgresChannelListener — heartbeat liveness", () => {
  /** Wire a listener whose heartbeat emit delivers (healthy) or drops (wedged). */
  function createHeartbeatHarness(opts?: {
    missesBeforeReconnect?: number;
    /** Make the reopened connection's first N listen() calls fail. */
    failListensAfterReopen?: number;
  }) {
    let sql = createStubSql();
    const reopened: StubSql[] = [];
    /** When false, emit() is accepted but no NOTIFY comes back — a wedged conn. */
    let delivering = true;
    let emitShouldThrow: Error | null = null;

    const listener = new PostgresChannelListener(
      asSql(sql),
      { initialBackoffMs: 1, maxBackoffMs: 2, maxAttempts: 3 },
      {
        emit: async (channel: string, payload: string) => {
          if (emitShouldThrow) {
            throw emitShouldThrow;
          }
          if (delivering) {
            sql.__deliver(channel, payload);
          }
        },
        reopen: async () => {
          const fresh = createStubSql();
          if (opts?.failListensAfterReopen) {
            fresh.__failNextListens(
              opts.failListensAfterReopen,
              new Error("stub: database still unreachable")
            );
          }
          reopened.push(fresh);
          sql = fresh;
          return asSql(fresh);
        },
        intervalMs: 60_000,
        missesBeforeReconnect: opts?.missesBeforeReconnect ?? 2,
      }
    );

    return {
      listener,
      reopened,
      currentSql: () => sql,
      wedge: () => {
        delivering = false;
      },
      unwedge: () => {
        delivering = true;
      },
      failEmitWith: (err: Error | null) => {
        emitShouldThrow = err;
      },
    };
  }

  test("a delivering connection reports alive and never reconnects", async () => {
    const h = createHeartbeatHarness();
    await h.listener.startHeartbeat();

    // First tick has no prior beat to judge — it only publishes.
    expect((await h.listener.heartbeatTick()).action).toBe("alive");
    // Subsequent ticks judge the previous beat, which was delivered.
    expect((await h.listener.heartbeatTick()).action).toBe("alive");
    expect((await h.listener.heartbeatTick()).action).toBe("alive");

    expect(h.reopened.length).toBe(0);
    await h.listener.close();
  });

  test("silence past the miss threshold reconnects and re-establishes every channel", async () => {
    const h = createHeartbeatHarness({ missesBeforeReconnect: 2 });
    await h.listener.startHeartbeat();
    await h.listener.subscribe("mesh.a", () => {});
    await h.listener.subscribe("mesh.b", () => {});

    await h.listener.heartbeatTick(); // publishes beat 1
    h.wedge(); // from here the connection accepts but delivers nothing

    expect((await h.listener.heartbeatTick()).action).toBe("alive"); // beat 1 landed
    expect(await h.listener.heartbeatTick()).toEqual({ action: "missed", missedBeats: 1 });

    const result = await h.listener.heartbeatTick();
    expect(result.action).toBe("reconnected");
    if (result.action !== "reconnected") throw new Error("expected reconnected");

    // Every channel is restored — including the heartbeat's own subscription.
    expect(result.channels.sort()).toEqual(["mesh.a", "mesh.b", HEARTBEAT_CHANNEL].sort());
    expect(h.reopened.length).toBe(1);

    // The re-established LISTENs are on the FRESH connection, not the dead one.
    const fresh = h.reopened[0];
    if (!fresh) throw new Error("expected a reopened connection");
    expect(fresh.__listens.map((r) => r.channel).sort()).toEqual(
      ["mesh.a", "mesh.b", HEARTBEAT_CHANNEL].sort()
    );

    await h.listener.close();
  });

  test("delivery resumes on the new connection after a reconnect — no restart needed", async () => {
    const h = createHeartbeatHarness({ missesBeforeReconnect: 1 });
    const received: unknown[] = [];
    await h.listener.startHeartbeat();
    await h.listener.subscribe("mesh.a", (_c, payload) => {
      received.push(payload);
    });

    await h.listener.heartbeatTick(); // beat 1
    h.wedge();
    await h.listener.heartbeatTick(); // beat 1 landed -> alive
    const result = await h.listener.heartbeatTick(); // miss -> threshold 1 -> reconnect
    expect(result.action).toBe("reconnected");

    // A NOTIFY on the NEW connection reaches the original subscriber.
    h.currentSql().__deliver("mesh.a", JSON.stringify({ v: 1 }));
    expect(received).toEqual([{ v: 1 }]);

    await h.listener.close();
  });

  test("the wedged connection is closed, and a close failure does not block reopening", async () => {
    const h = createHeartbeatHarness({ missesBeforeReconnect: 1 });
    await h.listener.startHeartbeat();
    const original = h.currentSql();
    original.__failNextEnd(new Error("connection already gone"));

    await h.listener.heartbeatTick();
    h.wedge();
    await h.listener.heartbeatTick();
    const result = await h.listener.heartbeatTick();

    expect(original.__endCalls).toBe(1);
    expect(result.action).toBe("reconnected");
    expect(h.reopened.length).toBe(1);

    await h.listener.close();
  });

  test("a failed emit is not counted as a missed beat", async () => {
    const h = createHeartbeatHarness({ missesBeforeReconnect: 1 });
    await h.listener.startHeartbeat();

    await h.listener.heartbeatTick(); // beat 1 delivered
    h.failEmitWith(new Error("pooled connection down"));

    // Several ticks where publishing itself fails must NOT trigger a reconnect:
    // we never managed to send a probe, so we cannot conclude the LISTEN side
    // is dead.
    for (let i = 0; i < 4; i++) {
      const r = await h.listener.heartbeatTick();
      expect(r.action).toBe("alive");
    }
    expect(h.reopened.length).toBe(0);

    await h.listener.close();
  });

  test("a reconnect whose reopen fails reports the failure instead of throwing", async () => {
    const sql = createStubSql();
    const listener = new PostgresChannelListener(
      asSql(sql),
      { initialBackoffMs: 1, maxAttempts: 2 },
      {
        emit: async () => {
          /* accepted, never delivered — permanently wedged */
        },
        reopen: async () => {
          throw new Error("pooler refused the connection");
        },
        intervalMs: 60_000,
        missesBeforeReconnect: 1,
      }
    );

    await listener.startHeartbeat();
    await listener.heartbeatTick(); // publishes
    await listener.heartbeatTick(); // miss 1 -> threshold -> reconnect attempt
    const result = await listener.heartbeatTick();

    expect(result.action).toBe("reconnect-failed");
    if (result.action !== "reconnect-failed") throw new Error("expected reconnect-failed");
    expect(result.error).toContain("pooler refused the connection");

    await listener.close();
  });

  test("without a heartbeat config the listener behaves exactly as before", async () => {
    const sql = createStubSql();
    const listener = new PostgresChannelListener(asSql(sql));

    await listener.subscribe("mesh.a", () => {});
    // startHeartbeat is a safe no-op, and no heartbeat channel is subscribed.
    await listener.startHeartbeat();

    expect(await listener.heartbeatTick()).toEqual({
      action: "skipped",
      reason: "not-configured",
    });
    expect(sql.__listens.map((r) => r.channel)).toEqual(["mesh.a"]);

    await listener.close();
  });

  test("channels are still restored when the re-listen fails across the reconnect window", async () => {
    // Spec AT2. This is the case postgres-js gets wrong: its own onclose deletes
    // each channel, re-listens, and SWALLOWS the rejection — so one unreachable
    // moment loses the subscription permanently. Ours retries and restores.
    const h = createHeartbeatHarness({ missesBeforeReconnect: 1, failListensAfterReopen: 2 });
    await h.listener.startHeartbeat();
    await h.listener.subscribe("mesh.a", () => {});

    await h.listener.heartbeatTick();
    h.wedge();
    await h.listener.heartbeatTick();
    const result = await h.listener.heartbeatTick();

    expect(result.action).toBe("reconnected");
    if (result.action !== "reconnected") throw new Error("expected reconnected");
    expect(result.channels.sort()).toEqual(["mesh.a", HEARTBEAT_CHANNEL]);

    // Both channels are live on the fresh connection despite the early failures.
    const fresh = h.reopened[0];
    if (!fresh) throw new Error("expected a reopened connection");
    const established = fresh.__listens.map((r) => r.channel).sort();
    expect(established).toEqual(["mesh.a", HEARTBEAT_CHANNEL]);

    await h.listener.close();
  });

  test("ticking after close is skipped rather than reconnecting a dead listener", async () => {
    const h = createHeartbeatHarness({ missesBeforeReconnect: 1 });
    await h.listener.startHeartbeat();
    await h.listener.close();

    expect(await h.listener.heartbeatTick()).toEqual({ action: "skipped", reason: "closed" });
    expect(h.reopened.length).toBe(0);
  });
});
