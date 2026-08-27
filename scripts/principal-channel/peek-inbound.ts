#!/usr/bin/env bun
/**
 * Read-only inbound peek for the principal channel (mt#3228).
 *
 * Shows what the poller WOULD do with whatever Telegram is currently holding —
 * without acting on any of it: no `claude` session is spawned, no event is
 * recorded, no ask is answered.
 *
 * Deliberately passes NO offset, so nothing is acknowledged and the real poller
 * still receives every update afterwards. Safe to run against a live channel.
 *
 * Message text is NOT printed: this output lands in a persisted, DB-ingested
 * transcript, and the principal's messages are theirs. Only the routing
 * decision, the ids, and the text LENGTH are shown — enough to verify the path
 * works, nothing more.
 *
 * Run from a checkout whose infra/ holds the stack config (the main workspace):
 *
 *   bun scripts/principal-channel/peek-inbound.ts
 *
 * Exit codes: 0 = the poll succeeded (with or without messages), 1 = it failed.
 */

import {
  resolvePrincipalChannel,
  createRealPrincipalChannelDeps,
} from "@minsky/domain/notify/principal-channel";
import { getTelegramUpdates } from "@minsky/domain/notify/telegram-transport";
import { routeInboundMessage } from "@minsky/domain/notify/principal-inbound";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

async function main(): Promise<void> {
  const resolution = await resolvePrincipalChannel(createRealPrincipalChannelDeps());
  if (!resolution.configured) {
    console.error(`FAIL (not configured): ${resolution.reason}`);
    process.exit(1);
  }

  const { token, chatId } = resolution.config;
  const result = await getTelegramUpdates({ token, timeoutSec: 0 });
  if (!result.ok) {
    console.error(`FAIL: ${result.detail}`);
    process.exit(1);
  }

  const auth = { allowedChatId: chatId };
  console.log(
    JSON.stringify(
      {
        status: "PASS",
        pendingMessages: result.messages.length,
        highestUpdateId: result.highestUpdateId ?? null,
        wouldRoute: result.messages.map((message) => {
          const route = routeInboundMessage(message, auth);
          return {
            updateId: message.updateId,
            fromAllowedChat: message.chatId === chatId,
            textLength: message.text.length,
            route: route.kind,
            ...(route.kind === "rejected" ? { reason: route.reason } : {}),
          };
        }),
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(`FAIL: ${getLoggableErrorSummary(err)}`);
  process.exit(1);
});
