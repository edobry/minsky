/**
 * Tests for the principal channel's credential resolution and send (mt#3228).
 *
 * Every case injects both readers, so no test spawns `pulumi`, touches the
 * network, or depends on ambient environment.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearPrincipalChannelCache,
  notifyPrincipal,
  resolvePrincipalChannel,
  TELEGRAM_CHAT_ID_PULUMI_KEY,
  type PrincipalChannelDeps,
} from "./principal-channel";

const NOTHING_IN_ENV = () => undefined;
const NO_PULUMI_TOKEN = async () => null;
const NO_PULUMI_PLAIN = async () => null;

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
      message: "soak test is green",
      deps: configured(async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }));
      }),
    });

    expect(result).toEqual({ delivered: true, messageId: 55, chatId: "999", source: "pulumi" });
    expect(sent["chat_id"]).toBe("999");
    expect(sent["text"]).toBe("soak test is green");
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
});
