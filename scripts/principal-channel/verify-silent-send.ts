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

import {
  resolvePrincipalChannel,
  createRealPrincipalChannelDeps,
} from "@minsky/domain/notify/principal-channel";
import { sendTelegramMessage } from "@minsky/domain/notify/telegram-transport";

/**
 * Gap between sends.
 *
 * **This is the discriminating parameter, not a cosmetic one.** It was 6s, and
 * at 6s the probe cannot tell "the field was honoured" from "Telegram or the
 * OS coalesced the follow-ups into the first message's banner" — successive
 * messages in one chat within a short window routinely collapse into a single
 * notification. The 2026-08-16 run (marker `002117`) returned exactly the
 * pattern that ambiguity produces: a notification on probe 1, which carried
 * `disable_notification`, and none on probe 3, which did not. Read literally
 * that says the field INVERTS the behaviour, which nothing supports; read as
 * coalescing it says the field did nothing and the first banner swallowed the
 * rest.
 *
 * 70s is chosen to sit well clear of any such window while keeping the whole
 * run under two and a half minutes. At this spacing the run exceeds a 120s
 * command timeout — launch it detached and read the log.
 */
const SPACING_MS = 70_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const resolution = await resolvePrincipalChannel(createRealPrincipalChannelDeps());
  if (!resolution.configured) {
    console.log(`SKIP: principal channel not configured (${resolution.reason})`);
    return;
  }
  const { token, chatId } = resolution.config;

  // Every message this script sends is worded identically across runs, so a
  // second run leaves the chat holding two indistinguishable batches and the
  // operator cannot say which one a notification belonged to. That is not a
  // cosmetic problem: it makes the probe UNREADABLE, which is exactly what
  // happened on the 2026-08-13 run — the batch was still sitting in the chat
  // three days later when the next one arrived. The marker rides in the
  // message TEXT specifically because the notification banner shows the text,
  // so the banner itself identifies its run.
  const runMarker = new Date().toISOString().slice(11, 19).replace(/:/g, "");

  // SILENCED, PLAIN, SILENCED — the plain send is BRACKETED deliberately.
  //
  // The previous order (silent, silent, plain) put the only expected
  // notification last, so "no notification arrived" could equally mean the
  // field worked or that notifications had stopped reaching the phone at all
  // mid-run. Bracketing removes that: a middle notification with silence
  // either side is the field working AND the channel demonstrably live, which
  // no single ordering could show before.
  const cases: { label: string; text: string; disableNotification?: boolean }[] = [
    {
      label: "silent-1",
      text: `[run ${runMarker}] mt#3711 probe 1 of 3 — sent with disable_notification. This should NOT notify.`,
      disableNotification: true,
    },
    {
      label: "plain-2",
      text: `[run ${runMarker}] mt#3711 probe 2 of 3 — sent normally. This one SHOULD notify.`,
    },
    {
      label: "silent-3",
      text: `[run ${runMarker}] mt#3711 probe 3 of 3 — also disable_notification. This should NOT notify. Safe to ignore all three.`,
      disableNotification: true,
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
  console.log(`PROBE SENT — run marker [run ${runMarker}]. Ignore any earlier run's messages.`);
  console.log("The verdict is the operator's, not this script's.");
  console.log("Expected: exactly ONE notification, the MIDDLE one (probe 2).");
  console.log("  probe 2 only -> disable_notification works; mt#3711's design holds.");
  console.log("  all three    -> the field is ignored here; the design does NOT hold.");
  console.log("  none at all  -> notifications are not reaching the phone; the run says nothing.");
}

await main();
