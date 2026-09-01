import { describe, test, expect } from "bun:test";
import { upstreamTargetOf, proxyConnectionString, startFreezeProxy } from "./freeze-proxy";

const REF = "yvkkrpyjhoiilmizlnac";
const POOLER_HOST = "aws-0-us-west-2.pooler.supabase.com";

describe("upstreamTargetOf", () => {
  test("reads host and port from a transaction-pooler URL", () => {
    expect(upstreamTargetOf(`postgres://postgres.${REF}:pw@${POOLER_HOST}:6543/postgres`)).toEqual({
      host: POOLER_HOST,
      port: 6543,
    });
  });

  test("reads the session-pooler port rather than assuming transaction mode", () => {
    expect(upstreamTargetOf(`postgres://postgres.${REF}:pw@${POOLER_HOST}:5432/postgres`)).toEqual({
      host: POOLER_HOST,
      port: 5432,
    });
  });

  test("defaults to 6543 when the URL carries no port", () => {
    expect(upstreamTargetOf(`postgres://postgres.${REF}:pw@${POOLER_HOST}/postgres`).port).toBe(
      6543
    );
  });

  test("accepts the postgresql:// spelling", () => {
    expect(
      upstreamTargetOf(`postgresql://postgres.${REF}:pw@${POOLER_HOST}:6543/postgres`).host
    ).toBe(POOLER_HOST);
  });
});

describe("proxyConnectionString", () => {
  test("redirects to loopback while preserving credentials and database", () => {
    const rewritten = new URL(
      proxyConnectionString(`postgres://postgres.${REF}:secret@${POOLER_HOST}:6543/postgres`, 51234)
    );
    expect(rewritten.hostname).toBe("127.0.0.1");
    expect(rewritten.port).toBe("51234");
    expect(rewritten.username).toBe(`postgres.${REF}`);
    expect(rewritten.pathname).toBe("/postgres");
    // The password has to survive the rewrite or the proxied client cannot
    // authenticate — asserted by presence, never by value.
    expect(rewritten.password.length).toBeGreaterThan(0);
  });
});

describe("startFreezeProxy", () => {
  // Binds an ephemeral loopback port and makes NO upstream connection: the
  // upstream socket is only dialled when a client connects, and no client does
  // here. So these run offline.
  test("listens on an ephemeral port and starts unfrozen and empty", async () => {
    const proxy = await startFreezeProxy({ host: "127.0.0.1", port: 1 });
    try {
      expect(proxy.port).toBeGreaterThan(0);
      expect(proxy.frozen()).toBe(false);
      expect(proxy.clientSocketCount()).toBe(0);
      expect(proxy.upstreamSocketCount()).toBe(0);
    } finally {
      await proxy.close();
    }
  });

  test("freeze/unfreeze toggle the flag the close-propagation logic reads", async () => {
    const proxy = await startFreezeProxy({ host: "127.0.0.1", port: 1 });
    try {
      proxy.freeze();
      expect(proxy.frozen()).toBe(true);
      proxy.unfreeze();
      expect(proxy.frozen()).toBe(false);
    } finally {
      await proxy.close();
    }
  });

  test("close() is idempotent — repeat calls resolve instead of erroring", async () => {
    // PR #3413 R1 (BLOCKING). Callers legitimately close twice: a mid-run
    // teardown plus the `finally` that must run whatever happened.
    //
    // HONEST SCOPE — this is a CONTRACT test, not a regression detector, and
    // that was established by running the control rather than assumed. Removing
    // the `closed` guard and re-running leaves all of these PASSING, because
    // `server.close(cb)` reports "already closed" by passing an error to its
    // callback, and this module tolerates ERR_SERVER_NOT_RUNNING by design. So
    // the guard's observable effect today is nil; it prevents redundant
    // teardown work and pins the contract for a future close() that is less
    // forgiving. Recording that here so the next reader does not mistake a
    // green run for proof the guard is load-bearing (mem#704).
    const proxy = await startFreezeProxy({ host: "127.0.0.1", port: 1 });
    await proxy.close();
    await expect(proxy.close()).resolves.toBeUndefined();
    await expect(proxy.close()).resolves.toBeUndefined();
  });

  test("close() leaves the proxy unfrozen so a repeat call cannot strand sockets", async () => {
    const proxy = await startFreezeProxy({ host: "127.0.0.1", port: 1 });
    proxy.freeze();
    await proxy.close();
    expect(proxy.frozen()).toBe(false);
  });
});
