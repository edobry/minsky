#!/usr/bin/env bun
/**
 * Probe whether `disable_notification` actually silences a SEND (mt#3711).
 *
 * The whole of mt#3711 rests on one premise: a turn can render as successive
 * chat messages instead of one message edited ever-longer, and still buzz the
 * principal's phone exactly once, because every message after the first is
 * sent with `disable_notification`. If that field does not do what it claims,
 * the design degrades into precisely the notification spam that
 * `principal-channel-reply-stream.ts` was built to avoid.
 *
 * The docs cannot settle this, which is why the probe exists. Two gaps, both
 * checked 2026-08-04:
 *
 *  - `core.telegram.org/bots/api` truncates before the `sendMessage` parameter
 *    table on fetch, so the field's own description was never read from the
 *    primary source.
 *  - The Bots FAQ documents rate limits but says NOTHING about whether an EDIT
 *    notifies. The claim that it does not — the load-bearing premise of the
 *    CURRENT design, at `principal-channel-reply-stream.ts:11` — is likewise
 *    undocumented.
 *
 * A stubbed `fetch` cannot answer either question: a fake accepts any field and
 * reports success. Only a live send to a real phone can, and the observation is
 * a human one — hence the operator-reported outcome below rather than an exit
 * code that claims to know.
 *
 * Sibling of `verify-streaming.ts`, which probes the same API for the same
 * reason (a cadence the reference does not document).
 *
 * Usage:
 *
 *   bun scripts/principal-channel/verify-silent-send.ts
 *
 * Sends THREE throwaway messages to the configured chat, spaced so the phone
 * has time to react to each. Nothing else is touched.
 *
 * Exit codes: 0 = all three delivered (or unconfigured → SKIP), 1 = a send
 * failed. Exit 0 means the PROBE ran, NOT that the notifications behaved —
 * that half is the operator's to report.
 */

import { resolvePrincipalChannel } from "@minsky/domain/notify/principal-channel";
import { sendTelegramMessage } from "@minsky/domain/notify/telegram-transport";

/** Gap between sends, so three buzzes (or one) are distinguishable by feel. */
const SPACING_MS = 6_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const resolution = await resolvePrincipalChannel();
  if (!resolution.configured) {
    console.log(`SKIP: principal channel not configured (${resolution.reason})`);
    return;
  }
  const { token, chatId } = resolution.config;

  // Ordered so the expected outcome is unambiguous by FEEL, not by reading:
  // two silent sends, then one loud one. The principal should register exactly
  // one buzz, and it should arrive with the LAST message.
  const cases: { label: string; text: string; disableNotification?: boolean }[] = [
    {
      label: "silent-1",
      text: "mt#3711 probe 1 of 3 — sent with disable_notification. This should NOT buzz.",
      disableNotification: true,
    },
    {
      label: "silent-2",
      text: "mt#3711 probe 2 of 3 — also disable_notification. This should NOT buzz either.",
      disableNotification: true,
    },
    {
      label: "loud-3",
      text: "mt#3711 probe 3 of 3 — sent normally. This one SHOULD buzz. Safe to ignore all three.",
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    const result = await sendTelegramMessage({
      token,
      chatId,
      text: testCase.text,
      ...(testCase.disableNotification === undefined
        ? {}
        : { disableNotification: testCase.disableNotification }),
    });
    if (!result.ok) {
      console.error(`FAIL: ${testCase.label} did not send: ${result.detail}`);
      process.exit(1);
    }
    console.log(`sent ${testCase.label} (message_id=${result.messageId})`);
    if (index < cases.length - 1) await sleep(SPACING_MS);
  }

  console.log("");
  console.log("PROBE SENT — the verdict is the operator's, not this script's.");
  console.log("Expected: exactly ONE notification, arriving with probe 3.");
  console.log("  1 buzz on probe 3 only  -> disable_notification works; mt#3711's design holds.");
  console.log("  3 buzzes                -> the field is ignored here; the design does NOT hold.");
}

await main();
