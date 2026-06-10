/**
 * Tests for the external alert sink (mt#2364 / mt#1596 Phase 2).
 *
 * Hermetic: `fetch` is injected, and `loadAlertSinkConfig` env reads are
 * save/restored around each case. No network, no DB.
 */

import { describe, test, expect, mock } from "bun:test";
import { captureConsoleLogs, findLogEvent } from "./test-helpers/log-capture";
import {
  loadAlertSinkConfig,
  buildAlertSink,
  TelegramAlertSink,
  WebhookAlertSink,
  type FetchFn,
} from "./alert-sink";

// A fetch double that records calls and returns a configurable Response-like.
// The returned object may include a `text()` method to exercise the non-2xx
// response-body diagnostics path.
function fakeFetch(
  impl: (
    url: string,
    init?: RequestInit
  ) => { ok: boolean; status: number; text?: () => Promise<string> } | Promise<never>
): { fetchFn: FetchFn; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = mock((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = impl(url, init);
    return Promise.resolve(r as unknown as Response);
  }) as unknown as FetchFn;
  return { fetchFn, calls };
}

const ENV_KEYS = [
  "ALERT_SINK_TYPE",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "ALERT_SINK_URL",
  "ALERT_SINK_SECRET",
];

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) {
      if (v !== undefined) process.env[k] = v;
    }
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("loadAlertSinkConfig (mt#2364)", () => {
  test("type=off when ALERT_SINK_TYPE unset", () => {
    withEnv({}, () => {
      expect(loadAlertSinkConfig().type).toBe("off");
    });
  });

  test("telegram type reads bot token + chat id", () => {
    withEnv(
      { ALERT_SINK_TYPE: "telegram", TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "123" },
      () => {
        const c = loadAlertSinkConfig();
        expect(c.type).toBe("telegram");
        expect(c.telegramBotToken).toBe("tok");
        expect(c.telegramChatId).toBe("123");
      }
    );
  });

  test("webhook type reads url + secret", () => {
    withEnv(
      { ALERT_SINK_TYPE: "webhook", ALERT_SINK_URL: "https://x/y", ALERT_SINK_SECRET: "s3cret" },
      () => {
        const c = loadAlertSinkConfig();
        expect(c.type).toBe("webhook");
        expect(c.webhookUrl).toBe("https://x/y");
        expect(c.webhookSecret).toBe("s3cret");
      }
    );
  });

  test("unknown type falls back to off", () => {
    withEnv({ ALERT_SINK_TYPE: "carrier-pigeon" }, () => {
      expect(loadAlertSinkConfig().type).toBe("off");
    });
  });
});

describe("buildAlertSink (mt#2364)", () => {
  test("off → null", () => {
    expect(buildAlertSink({ type: "off" })).toBeNull();
  });

  test("telegram with missing token → null + warn", () => {
    const { logs, restore } = captureConsoleLogs();
    let sink;
    try {
      sink = buildAlertSink({ type: "telegram", telegramChatId: "123" });
    } finally {
      restore();
    }
    expect(sink).toBeNull();
    expect(findLogEvent(logs, "sweeper.alert_sink_telegram_misconfigured")).not.toBeNull();
  });

  test("telegram fully configured → TelegramAlertSink", () => {
    const sink = buildAlertSink({
      type: "telegram",
      telegramBotToken: "tok",
      telegramChatId: "123",
    });
    expect(sink).toBeInstanceOf(TelegramAlertSink);
  });

  test("webhook with missing url → null + warn", () => {
    const { logs, restore } = captureConsoleLogs();
    let sink;
    try {
      sink = buildAlertSink({ type: "webhook" });
    } finally {
      restore();
    }
    expect(sink).toBeNull();
    expect(findLogEvent(logs, "sweeper.alert_sink_webhook_misconfigured")).not.toBeNull();
  });

  test("webhook fully configured → WebhookAlertSink", () => {
    const sink = buildAlertSink({ type: "webhook", webhookUrl: "https://x/y" });
    expect(sink).toBeInstanceOf(WebhookAlertSink);
  });
});

describe("TelegramAlertSink.notify (mt#2364)", () => {
  test("POSTs to the Bot API sendMessage endpoint with chat id + text", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ ok: true, status: 200 }));
    const sink = new TelegramAlertSink("BOTTOKEN", "999", fetchFn);
    await sink.notify("error", "Reviewer down — PR #42", "details here");

    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (!call?.init) throw new Error("expected a recorded fetch call with init");
    expect(call.url).toBe("https://api.telegram.org/botBOTTOKEN/sendMessage");
    const payload = JSON.parse(String(call.init.body));
    expect(payload.chat_id).toBe("999");
    expect(payload.text).toContain("[ERROR]");
    expect(payload.text).toContain("Reviewer down — PR #42");
    expect(payload.text).toContain("details here");
  });

  test("fail-open: non-2xx response does not throw, logs status + response body", async () => {
    const { fetchFn } = fakeFetch(() => ({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"ok":false,"description":"Bad Request: chat not found"}'),
    }));
    const sink = new TelegramAlertSink("tok", "1", fetchFn);
    const { logs, restore } = captureConsoleLogs();
    let threw = false;
    try {
      await sink.notify("error", "t", "b");
    } catch {
      threw = true;
    } finally {
      restore();
    }
    expect(threw).toBe(false);
    const ev = findLogEvent(logs, "sweeper.alert_sink_telegram_non_ok");
    expect(ev).not.toBeNull();
    expect(ev?.status).toBe(400);
    expect(String(ev?.responseBody)).toContain("chat not found");
  });

  test("fail-open: fetch throwing does not throw (logs)", async () => {
    const { fetchFn } = fakeFetch(() => Promise.reject(new Error("network down")));
    const sink = new TelegramAlertSink("tok", "1", fetchFn);
    const { logs, restore } = captureConsoleLogs();
    let threw = false;
    try {
      await sink.notify("error", "t", "b");
    } catch {
      threw = true;
    } finally {
      restore();
    }
    expect(threw).toBe(false);
    expect(findLogEvent(logs, "sweeper.alert_sink_telegram_failed")).not.toBeNull();
  });
});

describe("WebhookAlertSink.notify (mt#2364)", () => {
  test("POSTs {severity,title,body} JSON with the secret header", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ ok: true, status: 200 }));
    const sink = new WebhookAlertSink("https://hook/x", "s3cret", fetchFn);
    await sink.notify("warn", "title", "body");

    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (!call?.init) throw new Error("expected a recorded fetch call with init");
    expect(call.url).toBe("https://hook/x");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["x-alert-secret"]).toBe("s3cret");
    const payload = JSON.parse(String(call.init.body));
    expect(payload).toEqual({ severity: "warn", title: "title", body: "body" });
  });

  test("no secret → no x-alert-secret header", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ ok: true, status: 200 }));
    const sink = new WebhookAlertSink("https://hook/x", undefined, fetchFn);
    await sink.notify("info", "t", "b");
    const [call] = calls;
    if (!call?.init) throw new Error("expected a recorded fetch call with init");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["x-alert-secret"]).toBeUndefined();
  });

  test("fail-open: fetch throwing does not throw (logs)", async () => {
    const { fetchFn } = fakeFetch(() => Promise.reject(new Error("boom")));
    const sink = new WebhookAlertSink("https://hook/x", undefined, fetchFn);
    const { logs, restore } = captureConsoleLogs();
    let threw = false;
    try {
      await sink.notify("error", "t", "b");
    } catch {
      threw = true;
    } finally {
      restore();
    }
    expect(threw).toBe(false);
    expect(findLogEvent(logs, "sweeper.alert_sink_webhook_failed")).not.toBeNull();
  });
});
