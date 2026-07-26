/**
 * Shared Principal Commands (mt#3228)
 *
 * `principal.notify` — reach the principal on their phone.
 *
 * Before this command the Telegram capability existed but nothing could invoke
 * it: it fired only on the reviewer's circuit-breaker seam. This is the
 * outbound half of the bidirectional principal channel — the surface an agent
 * calls when something crosses the threshold of "the principal should know this
 * now, wherever they are".
 *
 * ## What belongs here, and what belongs in Asks
 *
 * This is a NOTIFICATION, not a decision request. Anything that needs an answer
 * goes through `asks.create` — which owns routing, attention accounting, and
 * the wake-bridge that resumes the waiting agent on a response. Sending a
 * question here instead would strand it outside the attention substrate, with
 * no record that a decision is pending.
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
} from "../command-registry";
import { CommonParameters } from "../common-parameters";
import { log } from "@minsky/shared/logger";
import { notifyPrincipal } from "@minsky/domain/notify/principal-channel";

const principalNotifyParams = {
  message: {
    schema: z.string().min(1),
    description: "Message body to deliver to the principal. Plain text.",
    required: true,
  },
  title: {
    schema: z.string().optional(),
    description: "Optional leading line rendered above the body (e.g. a task id).",
    required: false,
  },
  json: CommonParameters.json,
} satisfies CommandParameterMap;

export function registerPrincipalCommands(): void {
  sharedCommandRegistry.registerCommand({
    id: "principal.notify",
    name: "notify",
    description:
      "Send the principal a message on their configured channel (Telegram). For notifications " +
      "only — anything needing an answer belongs in asks.create.",
    category: CommandCategory.PRINCIPAL,
    parameters: principalNotifyParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      const result = await notifyPrincipal({
        message: params.message,
        ...(params.title === undefined ? {} : { title: params.title }),
      });

      const human = !params.json && ctx?.format !== "json";

      if (result.delivered) {
        if (human) log.cli(`Delivered to the principal (chat ${result.chatId}).`);
        return {
          success: true,
          delivered: true,
          messageId: result.messageId,
          chatId: result.chatId,
          configSource: result.source,
        };
      }

      // An unconfigured channel is a benign absence, not a failure: an agent
      // running on a machine with no channel set up should report "there is no
      // channel" and carry on. A send that was attempted and failed IS a
      // failure — the channel exists and is broken, which the principal needs
      // to hear about from whoever notices first.
      const succeeded = result.reason === "not-configured";
      if (human) log.cli(`Not delivered (${result.reason}): ${result.detail}`);
      return {
        success: succeeded,
        delivered: false,
        reason: result.reason,
        detail: result.detail,
        ...(succeeded ? {} : { error: result.detail }),
      };
    },
  });
}
