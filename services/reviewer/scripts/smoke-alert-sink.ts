#!/usr/bin/env bun
/**
 * Live verification artifact for mt#2364 / mt#1596 Phase 2.
 *
 * Builds the configured AlertSink from the reviewer's env exactly as
 * `startSweeper` does (`loadAlertSinkConfig` → `buildAlertSink`) and sends one
 * real test message through it.
 *
 * ## Why this inspects the HTTP outcome (reviewer R1, PR #1654)
 *
 * `AlertSink.notify` is intentionally fail-open — it never throws, even on a
 * non-2xx response or a network error. So "notify resolved" is NOT proof of
 * delivery. To avoid a misleading PASS, this script injects an INSTRUMENTED
 * fetch into the production sink, captures the real HTTP status, and reports:
 *   - PASS only when the channel accepted the message with a 2xx,
 *   - FAIL on a non-2xx (with a bounded response-body snippet) or a network
 *     error or if the sink never attempted a request.
 * Production sweeps remain fail-open; only this verification path is strict.
 *
 * ## Env gating
 *
 * Opt-in via `ALERT_SINK_TYPE` (`telegram` requires `TELEGRAM_BOT_TOKEN` +
 * `TELEGRAM_CHAT_ID`; `webhook` requires `ALERT_SINK_URL`). When unset / off /
 * incompletely configured, the script SKIPS gracefully (exit 0).
 *
 * Usage:
 *   ALERT_SINK_TYPE=telegram TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... \
 *     bun services/reviewer/scripts/smoke-alert-sink.ts
 *
 * Exit codes: 0 = pass or skip, 1 = fail.
 */

import { loadAlertSinkConfig, buildAlertSink, type FetchFn } from "../src/alert-sink";
import { safeTruncate } from "@minsky/shared/safe-truncate";

function skip(reason: string): never {
  console.log(JSON.stringify({ result: "SKIP", reason }, null, 2));
  process.exit(0);
}

function fail(reason: string, detail?: unknown): never {
  console.error(JSON.stringify({ result: "FAIL", reason, detail }, null, 2));
  process.exit(1);
}

interface SendOutcome {
  attempted: boolean;
  ok?: boolean;
  status?: number;
  bodySnippet?: string;
  error?: string;
}

async function main(): Promise<void> {
  const config = loadAlertSinkConfig();
  if (config.type === "off") {
    skip("ALERT_SINK_TYPE is unset/off — no external sink configured");
  }

  // Instrumented fetch: delegates to the real fetch, but records the HTTP
  // outcome so we can distinguish real delivery from a fail-open swallow.
  const outcome: SendOutcome = { attempted: false };
  const instrumentedFetch: FetchFn = async (input, init) => {
    outcome.attempted = true;
    try {
      const res = await fetch(input, init);
      outcome.ok = res.ok;
      outcome.status = res.status;
      if (!res.ok) {
        try {
          outcome.bodySnippet = safeTruncate(await res.clone().text(), 1000, "head");
        } catch {
          // ignore — body read is best-effort
        }
      }
      return res;
    } catch (err) {
      outcome.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  };

  const sink = buildAlertSink(config, instrumentedFetch);
  if (!sink) {
    skip(`ALERT_SINK_TYPE=${config.type} but the sink is incompletely configured (see warnings)`);
  }

  const ts = new Date().toISOString();
  await sink.notify(
    "info",
    "Minsky reviewer alert-sink smoke",
    `Test message from smoke-alert-sink.ts at ${ts}. If you received this, the ${config.type} alert sink is wired correctly.`
  );

  if (!outcome.attempted) {
    fail("sink did not attempt any outbound request", { type: config.type });
  }
  if (outcome.error !== undefined) {
    fail("outbound request errored (network/DNS)", { type: config.type, error: outcome.error });
  }
  if (outcome.ok !== true) {
    fail("channel rejected the message (non-2xx)", {
      type: config.type,
      status: outcome.status,
      responseBody: outcome.bodySnippet,
    });
  }

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        type: config.type,
        httpStatus: outcome.status,
        note: "channel accepted the message with a 2xx — confirm receipt on the channel too.",
        sentAt: ts,
      },
      null,
      2
    )
  );
  process.exit(0);
}

main().catch((err) => {
  fail("unexpected error", err instanceof Error ? err.message : String(err));
});
