#!/usr/bin/env bun
/**
 * Live verification of the outbound principal channel (mt#3228).
 *
 * Exercises the REAL path an agent takes — `notifyPrincipal`, credential
 * resolution and all — rather than a hand-assembled Bot API call, so a PASS
 * here means the agent-invocable surface works, not merely that Telegram is
 * reachable. PASS requires a real message id back from Telegram.
 *
 * Run from a checkout whose `infra/` holds the stack config (the main
 * workspace — `Pulumi.<stack>.yaml` is gitignored and does not exist in a
 * session clone):
 *
 *   bun scripts/principal-channel/verify-send.ts ["message text"]
 *
 * The token is read in-process and never printed; the result line carries only
 * the chat id, the message id, and which source the credentials came from.
 *
 * Exit codes: 0 = delivered, 1 = not delivered (reason printed).
 */

import {
  notifyPrincipal,
  createRealPrincipalChannelDeps,
} from "@minsky/domain/notify/principal-channel";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

const DEFAULT_MESSAGE =
  "Minsky principal channel is live. Reply to this message to exercise the inbound half.";

async function main(): Promise<void> {
  const message = process.argv.slice(2).join(" ").trim() || DEFAULT_MESSAGE;

  const result = await notifyPrincipal({ message, deps: createRealPrincipalChannelDeps() });

  if (!result.delivered) {
    console.error(`FAIL (${result.reason}): ${result.detail}`);
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        status: "PASS",
        chatId: result.chatId,
        messageId: result.messageId,
        credentialSource: result.source,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  // `notifyPrincipal` does not throw, so reaching here means a resolution-layer
  // fault. Its message can carry a Pulumi/CLI error but never the token, which
  // only ever exists inside the resolver.
  console.error(`FAIL: ${getLoggableErrorSummary(err)}`);
  process.exit(1);
});
