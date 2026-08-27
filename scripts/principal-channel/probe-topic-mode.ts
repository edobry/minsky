#!/usr/bin/env bun
/**
 * Live capability probe for Telegram DM forum-topic mode (mt#3505, parent
 * mt#3500).
 *
 * Calls the REAL `getMe` endpoint through `resolvePrincipalChannel` (the same
 * credential-resolution path the running channel uses) and reports whether
 * this bot has topic mode on, and whether the principal is allowed to create
 * topics themselves. This is the "keepable" successor to the ad-hoc probe the
 * mt#3500 spec's Phase 0 ran by hand — landing it alongside `verify-send.ts` /
 * `verify-resume.ts` so re-checking the toggle state after flipping something
 * in @BotFather never again requires improvising a curl command.
 *
 * Run from a checkout whose `infra/` holds the stack config (see
 * `verify-send.ts`'s own docblock for the session-clone caveat this shares —
 * credential resolution falls back to Pulumi stack config when
 * TELEGRAM_BOT_TOKEN is not in the environment):
 *
 *   bun scripts/principal-channel/probe-topic-mode.ts
 *
 * The token is read in-process and never printed. Exit codes: 0 = probe
 * succeeded (regardless of whether topic mode is ON or OFF — both are valid
 * states), 1 = the probe itself could not run (not configured, or Telegram
 * unreachable).
 */

import {
  resolvePrincipalChannel,
  createRealPrincipalChannelDeps,
} from "@minsky/domain/notify/principal-channel";
import { getTelegramMe } from "@minsky/domain/notify/telegram-transport";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

async function main(): Promise<void> {
  const resolution = await resolvePrincipalChannel(createRealPrincipalChannelDeps());
  if (!resolution.configured) {
    console.error(`FAIL (not-configured): ${resolution.reason}`);
    process.exit(1);
  }

  const { token, chatId, source } = resolution.config;
  const result = await getTelegramMe({ token });

  if (!result.ok) {
    console.error(`FAIL: ${result.detail}`);
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        status: "PASS",
        chatId,
        credentialSource: source,
        hasTopicsEnabled: result.hasTopicsEnabled,
        allowsUsersToCreateTopics: result.allowsUsersToCreateTopics,
      },
      null,
      2
    )
  );

  if (!result.hasTopicsEnabled) {
    console.log(
      "\nTopic mode is OFF for this bot. Enable it in @BotFather to use threaded mode " +
        "(mt#3505); until then the channel behaves as a single standing conversation."
    );
  } else if (!result.allowsUsersToCreateTopics) {
    console.log(
      "\nTopic mode is on, but the principal cannot create topics themselves — the " +
        "@BotFather 'allow users to create topics' toggle is off. Principal-initiated " +
        "topics (mt#3505) require it."
    );
  }
}

main().catch((err) => {
  // getTelegramMe/resolvePrincipalChannel do not throw on ordinary failure —
  // reaching here means a resolution-layer fault. The error can carry a
  // Pulumi/CLI error but never the token, which only ever exists inside the
  // resolver.
  console.error(`FAIL: ${getLoggableErrorSummary(err)}`);
  process.exit(1);
});
