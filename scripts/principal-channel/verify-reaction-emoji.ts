#!/usr/bin/env bun
/**
 * Verify that the reaction emoji this channel uses are still on Telegram's
 * allowlist (mt#3486).
 *
 * `ReactionTypeEmoji.emoji` is documented as "Currently, it can be one of
 * <list>" — a FIXED set that Telegram controls and can revise. An emoji
 * outside it is rejected with a 400, and because reactions are fire-and-forget
 * by contract (a failure must never affect the reply), that rejection is
 * SILENT: the ack simply never appears and nothing says why.
 *
 * That is not hypothetical. When this task was specced, the proposed set was
 * 👀 pickup / ✅ done / ⚠️❌ error. Probing the live API found ✅, ⚠️ and ❌ all
 * REJECTED — every emoji except the pickup one. Had it shipped unprobed, the
 * completion and error acks would have silently never appeared.
 *
 * So this script exists to answer the question empirically rather than from a
 * list anyone remembers. Run it after changing the emoji set, or when an ack
 * stops showing up.
 *
 * Usage:
 *
 *   bun scripts/principal-channel/verify-reaction-emoji.ts [emoji...]
 *
 * With no arguments it checks the set the channel actually uses. It sends ONE
 * throwaway message to the configured chat and clears its reactions afterward.
 *
 * Exit codes: 0 = every checked emoji is accepted (or unconfigured → SKIP),
 * 1 = at least one is rejected.
 */

import {
  resolvePrincipalChannel,
  createRealPrincipalChannelDeps,
} from "@minsky/domain/notify/principal-channel";
import {
  sendTelegramMessage,
  setTelegramMessageReaction,
} from "@minsky/domain/notify/telegram-transport";
import {
  REACTION_ERROR,
  REACTION_DONE,
  REACTION_RECEIVED,
} from "@minsky/domain/notify/principal-reactions";

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const emoji =
    requested.length > 0 ? requested : [REACTION_RECEIVED, REACTION_DONE, REACTION_ERROR];

  const resolution = await resolvePrincipalChannel(createRealPrincipalChannelDeps());
  if (!resolution.configured) {
    console.log(`SKIP: principal channel not configured (${resolution.reason})`);
    return;
  }
  const { token, chatId } = resolution.config;

  const sent = await sendTelegramMessage({
    token,
    chatId,
    text: "Reaction-allowlist check (mt#3486) — safe to ignore.",
  });
  if (!sent.ok) {
    console.error(`FAIL: could not send the probe message — ${sent.detail}`);
    process.exit(1);
  }

  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const candidate of emoji) {
    const ok = await setTelegramMessageReaction({
      token,
      chatId,
      messageId: sent.messageId,
      emoji: candidate,
    });
    (ok ? accepted : rejected).push(candidate);
  }

  // Leave the probe message unreacted rather than wearing the last candidate.
  await setTelegramMessageReaction({ token, chatId, messageId: sent.messageId, emoji: "" });

  console.log(JSON.stringify({ accepted, rejected }, null, 2));
  if (rejected.length > 0) {
    console.error(
      `FAIL: ${rejected.length} emoji rejected by Telegram — these acks would silently never appear.`
    );
    process.exit(1);
  }
}

await main();
