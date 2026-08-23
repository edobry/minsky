#!/usr/bin/env bun
/**
 * Probe how Telegram actually treats a stream of `editMessageText` calls
 * (mt#3542).
 *
 * This exists because the cadence cannot be settled from the docs. Telegram's
 * Bot FAQ gives limits for MESSAGES — *"In a single chat, avoid sending more
 * than one message per second"* — but the `editMessageText` reference carries
 * no rate-limit language at all, so whether an EDIT counts against that budget
 * is undocumented. A stubbed `fetch` cannot answer it: a fake accepts every
 * edit at any rate. Only the live API can.
 *
 * The failure this guards against is the quiet one. If edits do count and the
 * throttle is too aggressive, streaming draws 429s under ordinary use — and a
 * 429 mid-stream degrades the placeholder rather than raising anything, so the
 * symptom is "replies sometimes stop updating," with nothing in the logs
 * pointing at the cause.
 *
 * Usage:
 *
 *   bun scripts/principal-channel/verify-streaming.ts [--edits N] [--interval MS]
 *
 * Defaults to 12 edits at the production cadence. Sends ONE throwaway message
 * to the configured chat and edits it in place; nothing else is touched.
 *
 * Exit codes: 0 = no 429s at the tested cadence (or unconfigured → SKIP),
 * 1 = at least one 429, meaning the cadence is too fast for this chat.
 */

import {
  resolvePrincipalChannel,
  createRealPrincipalChannelDeps,
} from "@minsky/domain/notify/principal-channel";
import { editTelegramMessage, sendTelegramMessage } from "@minsky/domain/notify/telegram-transport";
import { EDIT_THROTTLE_MS } from "../../src/cockpit/principal-channel-reply-stream";

function numericArg(flag: string, fallback: number): number {
  const at = process.argv.indexOf(flag);
  if (at === -1) return fallback;
  const parsed = Number(process.argv[at + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const edits = numericArg("--edits", 12);
  const intervalMs = numericArg("--interval", EDIT_THROTTLE_MS);

  const resolution = await resolvePrincipalChannel(createRealPrincipalChannelDeps());
  if (!resolution.configured) {
    console.log(`SKIP: principal channel not configured (${resolution.reason})`);
    return;
  }
  const { token, chatId } = resolution.config;

  const sent = await sendTelegramMessage({
    token,
    chatId,
    text: "Streaming cadence check (mt#3542) — safe to ignore.",
  });
  if (!sent.ok) {
    console.error(`FAIL: could not send the placeholder: ${sent.detail}`);
    process.exit(1);
  }

  const rejected: Array<{ attempt: number; status?: number; detail: string }> = [];
  let notModified = 0;
  const startedAt = Date.now();

  for (let i = 1; i <= edits; i += 1) {
    // Distinct text every time: an identical edit answers "not modified"
    // without exercising the rate limit at all, which would make this probe
    // pass for the wrong reason.
    const result = await editTelegramMessage({
      token,
      chatId,
      messageId: sent.messageId,
      text: `Streaming cadence check (mt#3542) — edit ${i} of ${edits}.`,
    });

    if (result.ok) {
      if (result.notModified) notModified += 1;
    } else {
      rejected.push({
        attempt: i,
        ...(result.status === undefined ? {} : { status: result.status }),
        detail: result.detail,
      });
    }

    if (i < edits) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const elapsedMs = Date.now() - startedAt;
  const rateLimited = rejected.filter((r) => r.status === 429);

  console.log(
    JSON.stringify(
      {
        edits,
        intervalMs,
        elapsedMs,
        editsPerSecond: Number((edits / (elapsedMs / 1000)).toFixed(2)),
        accepted: edits - rejected.length,
        notModified,
        rateLimited: rateLimited.length,
        rejected,
      },
      null,
      2
    )
  );

  await editTelegramMessage({
    token,
    chatId,
    messageId: sent.messageId,
    text: `Streaming cadence check (mt#3542) — done. ${edits - rejected.length}/${edits} edits accepted, ${rateLimited.length} rate-limited.`,
  });

  if (rateLimited.length > 0) {
    console.error(
      `FAIL: ${rateLimited.length} of ${edits} edits drew a 429 at ${intervalMs}ms spacing — the cadence is too fast for this chat.`
    );
    process.exit(1);
  }
  if (rejected.length > 0) {
    console.error(`FAIL: ${rejected.length} of ${edits} edits were rejected (not rate-limiting).`);
    process.exit(1);
  }
}

await main();
