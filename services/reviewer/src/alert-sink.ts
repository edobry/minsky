/**
 * External off-cockpit alert sink for the reviewer service
 * (mt#2364 / mt#1596 Phase 2).
 *
 * Phase 1 (mt#2363) surfaces a tripped reviewer circuit breaker on the cockpit
 * `AsksPage` — but that only reaches an OPEN browser tab. This module adds a
 * pluggable, cloud-native alert sink that pushes the same failure to an
 * external channel directly from the Railway container, so the principal is
 * reached after-hours / off-cockpit (asleep, weekend, mobile). It is
 * belt-and-suspenders redundancy alongside the Phase-1 Ask — NOT a
 * prerequisite, and it does NOT affect the circuit-breaker dedup (the
 * `alerted` mark stays gated on the Ask outcome per mt#2363 R1).
 *
 * ## Channel: Telegram (decided 2026-06-10)
 *
 * Telegram was chosen as the pragmatic "simplest thing that reaches the
 * principal's phone": free, reliable, already in daily use. The impl uses the
 * Telegram Bot API `sendMessage` endpoint via a raw `fetch` POST — **zero new
 * package dependency** (no grammY/SDK). A generic `WebhookAlertSink` (POST JSON
 * to a URL) is the second impl.
 *
 * ## Matrix-readiness
 *
 * The `AlertSink` interface is deliberately generic so a future
 * `MatrixAlertSink` can drop in behind the same seam once mt#1454
 * (Matrix-as-mesh-substrate evaluation) lands. This task is a transport
 * *binding under Ask*, not a substrate decision (per the OpenClaw/HiClaw
 * position paper: "transport as a binding, not channel as an architectural
 * tier"). See mt#1454 / mt#1409 / the ambient-cockpit RFC.
 *
 * All sinks are fail-open: `notify` catches internally and never throws, so a
 * sink failure can never crash the sweep cycle.
 */

import { log } from "./logger";

/** Alert severity. The circuit-breaker path emits `error`. */
export type AlertSeverity = "info" | "warn" | "error";

/**
 * A pluggable external alert channel. Implementations MUST be fail-open:
 * `notify` catches all errors internally and resolves — it never throws.
 */
export interface AlertSink {
  notify(severity: AlertSeverity, title: string, body: string): Promise<void>;
}

/** Injectable fetch for tests. */
export type FetchFn = typeof fetch;

export type AlertSinkType = "telegram" | "webhook" | "off";

/** Resolved alert-sink configuration (read from the reviewer's env). */
export interface AlertSinkConfig {
  type: AlertSinkType;
  /** Telegram bot token (`ALERT_SINK_TYPE=telegram`). */
  telegramBotToken?: string;
  /** Telegram chat id to deliver to (`ALERT_SINK_TYPE=telegram`). */
  telegramChatId?: string;
  /** Generic webhook URL (`ALERT_SINK_TYPE=webhook`). */
  webhookUrl?: string;
  /** Optional shared secret sent as the `x-alert-secret` header (webhook). */
  webhookSecret?: string;
}

/**
 * Load alert-sink config from the reviewer's environment. Opt-in: when
 * `ALERT_SINK_TYPE` is unset (or `off`), the sink is disabled and nothing is
 * sent. Follows the per-module loader convention (`loadSweeperConfig`,
 * `loadAsksReconcileSchedulerConfig`); these env vars live in the reviewer's
 * own config surface and are excluded from the main dot-path env parser (the
 * `custom/no-unregistered-minsky-env-var` rule scopes out `services/*`).
 */
export function loadAlertSinkConfig(): AlertSinkConfig {
  const rawType = (process.env["ALERT_SINK_TYPE"] ?? "off").toLowerCase();
  const type: AlertSinkType =
    rawType === "telegram" ? "telegram" : rawType === "webhook" ? "webhook" : "off";
  return {
    type,
    telegramBotToken: process.env["TELEGRAM_BOT_TOKEN"] || undefined,
    telegramChatId: process.env["TELEGRAM_CHAT_ID"] || undefined,
    webhookUrl: process.env["ALERT_SINK_URL"] || undefined,
    webhookSecret: process.env["ALERT_SINK_SECRET"] || undefined,
  };
}

/**
 * Telegram alert sink. Posts to the Bot API `sendMessage` endpoint via a raw
 * `fetch` POST — no SDK. Fail-open: any error (network, non-2xx, throw) is
 * caught and logged; the method resolves regardless.
 */
export class TelegramAlertSink implements AlertSink {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly fetchFn: FetchFn = fetch
  ) {}

  async notify(severity: AlertSeverity, title: string, body: string): Promise<void> {
    try {
      const text = `[${severity.toUpperCase()}] ${title}\n\n${body}`;
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // disable_web_page_preview keeps the message compact; plain text (no
        // parse_mode) avoids Markdown-escaping pitfalls on SHAs/error strings.
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        log.error("sweeper.alert_sink_telegram_non_ok", {
          event: "sweeper.alert_sink_telegram_non_ok",
          status: res.status,
          severity,
          title,
        });
      }
    } catch (err: unknown) {
      log.error("sweeper.alert_sink_telegram_failed", {
        event: "sweeper.alert_sink_telegram_failed",
        severity,
        title,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Generic webhook alert sink. POSTs `{ severity, title, body }` as JSON to a
 * configured URL, optionally with an `x-alert-secret` header. Fail-open.
 */
export class WebhookAlertSink implements AlertSink {
  constructor(
    private readonly url: string,
    private readonly secret: string | undefined,
    private readonly fetchFn: FetchFn = fetch
  ) {}

  async notify(severity: AlertSeverity, title: string, body: string): Promise<void> {
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.secret) headers["x-alert-secret"] = this.secret;
      const res = await this.fetchFn(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ severity, title, body }),
      });
      if (!res.ok) {
        log.error("sweeper.alert_sink_webhook_non_ok", {
          event: "sweeper.alert_sink_webhook_non_ok",
          status: res.status,
          severity,
          title,
        });
      }
    } catch (err: unknown) {
      log.error("sweeper.alert_sink_webhook_failed", {
        event: "sweeper.alert_sink_webhook_failed",
        severity,
        title,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Build the configured `AlertSink`, or `null` when disabled / misconfigured.
 *
 * - `off` (or unset) → `null` (no-op; the sweeper falls back to log-only +
 *   the Phase-1 cockpit Ask).
 * - `telegram` with a missing token/chat-id → `null` + a structured warning
 *   (opt-in but incompletely configured).
 * - `webhook` with a missing URL → `null` + a structured warning.
 */
export function buildAlertSink(
  config: AlertSinkConfig,
  fetchFn: FetchFn = fetch
): AlertSink | null {
  switch (config.type) {
    case "telegram": {
      if (!config.telegramBotToken || !config.telegramChatId) {
        log.warn("sweeper.alert_sink_telegram_misconfigured", {
          event: "sweeper.alert_sink_telegram_misconfigured",
          message:
            "ALERT_SINK_TYPE=telegram but TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID is unset; " +
            "external alerting is disabled.",
          hasToken: Boolean(config.telegramBotToken),
          hasChatId: Boolean(config.telegramChatId),
        });
        return null;
      }
      log.info("sweeper.alert_sink_enabled", {
        event: "sweeper.alert_sink_enabled",
        type: "telegram",
      });
      return new TelegramAlertSink(config.telegramBotToken, config.telegramChatId, fetchFn);
    }
    case "webhook": {
      if (!config.webhookUrl) {
        log.warn("sweeper.alert_sink_webhook_misconfigured", {
          event: "sweeper.alert_sink_webhook_misconfigured",
          message:
            "ALERT_SINK_TYPE=webhook but ALERT_SINK_URL is unset; external alerting is disabled.",
        });
        return null;
      }
      log.info("sweeper.alert_sink_enabled", {
        event: "sweeper.alert_sink_enabled",
        type: "webhook",
      });
      return new WebhookAlertSink(config.webhookUrl, config.webhookSecret, fetchFn);
    }
    case "off":
    default:
      return null;
  }
}
