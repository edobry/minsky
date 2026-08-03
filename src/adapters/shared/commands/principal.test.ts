/**
 * Tests for the `principal.notify` shared command (mt#3228, `taskId` mt#3507).
 *
 * Registers into an ISOLATED `createSharedCommandRegistry()` instance (the
 * `registerAuthorshipCommands` pattern this mirrors) rather than the
 * module-level singleton every other command test file also touches, so
 * this file's `beforeEach` re-registration can never collide with another
 * test file's registration of the same command id.
 *
 * The command's `execute()` has no `fetchFn`/env-reader injection seam of
 * its own (unlike `notifyPrincipal`, whose own test file injects both) — it
 * resolves credentials from real env/Pulumi and sends over the real global
 * `fetch`. The one test here that needs a "credentials configured" path
 * therefore sets `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` directly and stubs
 * `globalThis.fetch` for its duration, restoring both in `afterEach` — the
 * only lever available at this layer without touching production code to
 * add a seam this task's scope does not call for.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSharedCommandRegistry, type SharedCommandRegistry } from "../command-registry";
import type { CommandExecutionContext } from "../command-registry";
import { registerPrincipalCommands } from "./principal";
import { clearPrincipalChannelCache } from "@minsky/domain/notify/principal-channel";

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

describe("principal.notify (mt#3228 base + mt#3507 taskId)", () => {
  let registry: SharedCommandRegistry;

  beforeEach(() => {
    registry = createSharedCommandRegistry();
    registerPrincipalCommands(registry);
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
