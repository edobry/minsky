/**
 * Tests for the `principal.notify` shared command (mt#3228, `taskId` mt#3507).
 *
 * Registers into an ISOLATED `createSharedCommandRegistry()` instance (the
 * `registerAuthorshipCommands` pattern this mirrors) rather than the
 * module-level singleton every other command test file also touches, so
 * this file's `beforeEach` re-registration can never collide with another
 * test file's registration of the same command id.
 *
 * Credential injection (mt#3557, made mandatory by mt#3609).
 * `registerPrincipalCommands` takes a REQUIRED `channelDeps` parameter. It
 * exists because a test asserting the "not configured" branch must be able to
 * GUARANTEE that branch, and once could not: `resolvePrincipalChannel` read
 * the real environment, and when that was empty it fell through to spawning
 * the `pulumi` CLI. On any machine with Pulumi config the resolution therefore
 * SUCCEEDED and the command sent over the real global `fetch` — three tests in
 * the outer describe below were delivering live Telegram messages to the
 * principal on every full-suite run, and the two that assert
 * `delivered: false` failed with `delivered: true`. In CI, with no route to
 * Telegram, the same tests instead hung to the 15s timeout, which is why they
 * were first misfiled as a load-dependent flake (mt#3557).
 *
 * The outer describe registers with `FORCE_NOT_CONFIGURED` so that branch is
 * reachable deterministically and no test can reach the network. The inner
 * "credentials resolvable" describe registers its own deps instead — a
 * `readEnv` over the `process.env` it populates, explicitly-stubbed Pulumi
 * readers, and a `fetchFn` delegating to the `globalThis.fetch` it stubs per
 * test. Before mt#3609 that block passed NO deps and relied on the real
 * readers, avoiding `pulumi` only by the accident that env wins when set.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSharedCommandRegistry, type SharedCommandRegistry } from "../command-registry";
import type { CommandExecutionContext } from "../command-registry";
import { registerPrincipalCommands } from "./principal";
import {
  clearPrincipalChannelCache,
  type PrincipalChannelDeps,
} from "@minsky/domain/notify/principal-channel";

const NOTIFY_ID = "principal.notify";
const TOKEN_ENV_KEY = "TELEGRAM_BOT_TOKEN";
const CHAT_ENV_KEY = "TELEGRAM_CHAT_ID";

function getNotifyCommand(registry: SharedCommandRegistry) {
  const cmd = registry.getCommand(NOTIFY_ID);
  if (!cmd) throw new Error(`${NOTIFY_ID} not registered`);
  return cmd;
}

/** A container whose `get("persistence")` resolves to a fake SQL provider. */
function containerWithDb(
  execute: (query: unknown) => Promise<unknown>
): CommandExecutionContext["container"] {
  const provider = { getDatabaseConnection: async () => ({ execute }) };
  return {
    get: (key: string) => (key === "persistence" ? provider : undefined),
  } as unknown as CommandExecutionContext["container"];
}

// The real interface requires a context object; a bare CLI/MCP invocation
// with nothing set up still supplies an empty one — this is what "no
// container available" looks like at the type level.
const NO_CONTAINER = {} as CommandExecutionContext;

/**
 * Deps that make the "not configured" branch REACHABLE (mt#3557).
 *
 * Both credential sources are stubbed to empty — the env reader AND the two
 * Pulumi readers. Stubbing only the env is not enough: an empty env is exactly
 * what falls through to the `pulumi` CLI, which is how these tests were
 * resolving real credentials.
 *
 * `fetchFn` is a TRIPWIRE, not a stub. Nothing should reach it, because the
 * resolution above should never report configured. If a future change makes
 * resolution succeed anyway, this throws and the test fails loudly — rather
 * than silently sending a live Telegram message, which is the exact failure
 * being fixed here.
 */
const FORCE_NOT_CONFIGURED: PrincipalChannelDeps = {
  readEnv: () => undefined,
  readPulumiToken: async () => null,
  readPulumiPlain: async () => null,
  now: Date.now,
  // `async`, so this rejects rather than throwing synchronously — same reason
  // as the sibling tripwire in principal-channel.test.ts (PR #3168 R1). The
  // `as unknown as typeof fetch` cast is also gone: `fetchFn` is typed
  // `FetchFn`, which this satisfies directly.
  fetchFn: async () => {
    throw new Error(
      "principal.test.ts: fetch reached under FORCE_NOT_CONFIGURED — credential resolution " +
        "succeeded when it should not have. Do NOT relax this into a no-op stub; it is the " +
        "guard against re-introducing live Telegram sends from the test suite (mt#3557)."
    );
  },
};

describe("principal.notify (mt#3228 base + mt#3507 taskId)", () => {
  let registry: SharedCommandRegistry;

  beforeEach(() => {
    registry = createSharedCommandRegistry();
    registerPrincipalCommands(FORCE_NOT_CONFIGURED, registry);
    clearPrincipalChannelCache();
  });

  test("registers with message, title, taskId, and json parameters", () => {
    const cmd = getNotifyCommand(registry);
    expect(Object.keys(cmd.parameters)).toEqual(
      expect.arrayContaining(["message", "title", "taskId", "json"])
    );
  });

  test("reports not-configured on a bare machine, without crashing on a missing container", async () => {
    const cmd = getNotifyCommand(registry);
    const result = (await cmd.execute({ message: "hi", json: true }, NO_CONTAINER)) as Record<
      string,
      unknown
    >;
    // Not configured is a benign absence (per this command's own contract),
    // not a thrown error — asserted here because the taskId wiring added a
    // new code path (reading the DI container) that runs before
    // notifyPrincipal, and it must degrade the same way with no container.
    expect(result["delivered"]).toBe(false);
    expect(result["reason"]).toBe("not-configured");
  });

  test("regression: a call with no taskId never touches the container", async () => {
    const cmd = getNotifyCommand(registry);
    let containerTouched = false;
    const ctx = {
      json: true,
      container: {
        get: () => {
          containerTouched = true;
          return undefined;
        },
      } as unknown as CommandExecutionContext["container"],
    } as CommandExecutionContext;

    await cmd.execute({ message: "hi", json: true }, ctx);
    expect(containerTouched).toBe(false);
  });

  test("a taskId with a persistence-less container degrades to standing (no crash)", async () => {
    const cmd = getNotifyCommand(registry);
    const ctx = {
      json: true,
      container: { get: () => undefined } as unknown as CommandExecutionContext["container"],
    } as CommandExecutionContext;

    const result = (await cmd.execute(
      { message: "hi", taskId: "mt#3507", json: true },
      ctx
    )) as Record<string, unknown>;
    expect(result["delivered"]).toBe(false);
    expect(result["reason"]).toBe("not-configured");
  });

  describe("with credentials resolvable (env) and the network stubbed", () => {
    const ORIGINAL_TOKEN = process.env[TOKEN_ENV_KEY];
    const ORIGINAL_CHAT = process.env[CHAT_ENV_KEY];
    const ORIGINAL_FETCH = globalThis.fetch;

    beforeEach(() => {
      // This block needs env-based resolution to SUCCEED, so it injects a
      // reader that reads the real `process.env` it populates below — rather
      // than passing no deps at all, which is what it used to do.
      //
      // That old form is the defect mt#3609 fixes: "no deps" meant "fall
      // through to the real readers", and the `pulumi` fallback was avoided
      // only by the happy accident that env wins when it is set. The Pulumi
      // readers are now stubbed EXPLICITLY, so this block cannot reach the
      // `pulumi` CLI even if the env setup below were to fail. `fetchFn`
      // delegates to `globalThis.fetch`, which each test in this block stubs.
      registry = createSharedCommandRegistry();
      registerPrincipalCommands(
        {
          readEnv: (name) => process.env[name],
          readPulumiToken: async () => null,
          readPulumiPlain: async () => null,
          now: Date.now,
          fetchFn: (url, init) => globalThis.fetch(url, init),
        },
        registry
      );
      clearPrincipalChannelCache();
      process.env[TOKEN_ENV_KEY] = "test-token";
      process.env[CHAT_ENV_KEY] = "999";
    });

    afterEach(() => {
      if (ORIGINAL_TOKEN === undefined) delete process.env[TOKEN_ENV_KEY];
      else process.env[TOKEN_ENV_KEY] = ORIGINAL_TOKEN;
      if (ORIGINAL_CHAT === undefined) delete process.env[CHAT_ENV_KEY];
      else process.env[CHAT_ENV_KEY] = ORIGINAL_CHAT;
      globalThis.fetch = ORIGINAL_FETCH;
    });

    test("a taskId with persistence available queries the topic store before sending", async () => {
      const cmd = getNotifyCommand(registry);
      const queries: unknown[] = [];
      let sentThreadId: unknown;

      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentThreadId = body["message_thread_id"];
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }) as typeof fetch;

      const ctx = {
        json: true,
        container: containerWithDb(async (query) => {
          queries.push(query);
          return []; // no bound topic
        }),
      } as CommandExecutionContext;

      const result = (await cmd.execute(
        { message: "hi", taskId: "mt#3507", json: true },
        ctx
      )) as Record<string, unknown>;

      expect(queries.length).toBeGreaterThan(0);
      expect(result["delivered"]).toBe(true);
      // No bound topic found -> falls back to the standing conversation.
      expect(sentThreadId).toBeUndefined();
    });

    test("regression: omitting taskId sends the exact same body as before this parameter existed", async () => {
      const cmd = getNotifyCommand(registry);
      let rawBody = "";
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        rawBody = String(init?.body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }) as typeof fetch;

      await cmd.execute({ message: "soak test is green", json: true }, NO_CONTAINER);

      expect(rawBody).toBe(
        JSON.stringify({
          chat_id: "999",
          text: "soak test is green",
          disable_web_page_preview: true,
        })
      );
    });
  });
});
