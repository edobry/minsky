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
  type SharedCommandRegistry,
} from "../command-registry";
import { CommonParameters } from "../common-parameters";
import { log } from "@minsky/shared/logger";
import {
  findTelegramTopicForTask,
  markTelegramChannelTopicDead,
  notifyPrincipal,
  type PrincipalChannelDeps,
  type TelegramTopicDb,
} from "@minsky/domain/notify/principal-channel";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";

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
  taskId: {
    schema: z.string().optional(),
    description:
      "Post into the Telegram topic bound to this task, if one exists (mt#3507); otherwise " +
      "the standing conversation. Never creates a topic.",
    required: false,
  },
  json: CommonParameters.json,
} satisfies CommandParameterMap;

/**
 * Resolve a SQL connection through the command's DI container, for the
 * `taskId` topic lookup/drift-reconciliation (mt#3507).
 *
 * Mirrors `asks.ts`'s own `container.get("persistence")` pattern rather than
 * reaching into the cockpit daemon's `db-providers.ts`: this command can run
 * in a bare MCP-server process with no cockpit daemon at all, and importing
 * from `src/cockpit/` here would invert the Domain -> Adapters ->
 * Infrastructure layering (cockpit already depends on this adapter layer).
 * Returns undefined (never throws) when no persistence is reachable — the
 * caller then simply omits `taskId` routing and posts to the standing
 * conversation, which is the correct degrade for an unbound/unreachable case.
 */
function getDbFromContainer(
  ctx?: CommandExecutionContext
): (() => Promise<TelegramTopicDb | null>) | undefined {
  const persistenceProvider = ctx?.container?.get("persistence") as
    | SqlCapablePersistenceProvider
    | undefined;
  if (!persistenceProvider?.getDatabaseConnection) return undefined;
  return async () => (await persistenceProvider.getDatabaseConnection?.()) ?? null;
}

/**
 * Registry parameter mirrors the `registerAuthorshipCommands` pattern
 * (`./authorship.ts`): optional, defaulting to the module-level singleton,
 * so a test can register into an isolated `createSharedCommandRegistry()`
 * instance instead of the shared one every other test file also touches.
 *
 * `channelDeps` is REQUIRED (mt#3609). It arrived as an optional seam in
 * mt#3557, when a test asserting the "not configured" branch could not
 * guarantee that branch: `resolvePrincipalChannel` read the real environment,
 * and when that was empty it fell through to spawning the `pulumi` CLI, so on
 * any machine with Pulumi config the resolution SUCCEEDED and
 * `notifyPrincipal` sent over the real global `fetch`. That was not
 * hypothetical — it is what this file's own tests were doing: every
 * full-suite run on the principal's machine delivered two live Telegram
 * messages, and the two tests asserting `delivered: false` failed with
 * `delivered: true`.
 *
 * mt#3609 removed the fallbacks that made it possible, so the seam is no
 * longer an affordance a caller may decline — every caller states its
 * dependencies, production included. `./index.ts` passes
 * `createRealPrincipalChannelDeps()`; tests pass fakes. Because the parameter
 * is required it comes FIRST, ahead of the optional registry.
 *
 * The deps are MERGED under the taskId-derived `lookupTaskTopic` /
 * `markTopicDead` rather than replacing them, so injecting credential readers
 * does not silently disable topic routing.
 */
export function registerPrincipalCommands(
  channelDeps: PrincipalChannelDeps,
  registry?: SharedCommandRegistry
): void {
  const targetRegistry = registry ?? sharedCommandRegistry;
  targetRegistry.registerCommand({
    id: "principal.notify",
    name: "notify",
    description:
      "Send the principal a message on their configured channel (Telegram). For notifications " +
      "only — anything needing an answer belongs in asks.create.",
    category: CommandCategory.PRINCIPAL,
    parameters: principalNotifyParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      // Only build the DB-backed deps when a taskId was actually supplied —
      // a call with no taskId (every caller before this parameter existed,
      // and any caller with nothing to name) needs none of this and reaches
      // notifyPrincipal exactly as it always did.
      let deps: PrincipalChannelDeps = channelDeps;
      if (params.taskId !== undefined) {
        const getDb = getDbFromContainer(ctx);
        if (getDb) {
          deps = {
            // `channelDeps` is REQUIRED as of mt#3609, so this spread no longer
            // needs the `?? {}` guard PR #2566 R1 asked about — there is no
            // `undefined` case left to spread. The topic hooks are ADDED to the
            // caller's deps rather than replacing them, so injecting credential
            // readers does not silently disable topic routing.
            ...channelDeps,
            lookupTaskTopic: (taskId, chatId) =>
              findTelegramTopicForTask(taskId, chatId, { getDb }),
            markTopicDead: (chatId, messageThreadId) =>
              markTelegramChannelTopicDead(chatId, messageThreadId, { getDb }),
          };
        }
      }

      const result = await notifyPrincipal({
        message: params.message,
        ...(params.title === undefined ? {} : { title: params.title }),
        ...(params.taskId === undefined ? {} : { taskId: params.taskId }),
        deps,
      });

      const human = !params.json && ctx?.format !== "json";

      if (result.delivered) {
        if (human) {
          log.cli(
            result.fellBackFromDeadTopic
              ? `Delivered to the principal (chat ${result.chatId}) — the task's topic was gone, so this fell back to the standing conversation.`
              : `Delivered to the principal (chat ${result.chatId}).`
          );
        }
        return {
          // In human mode the line above already reported delivery (chat id
          // included), so `printed` stops the CLI formatter appending a bare
          // "✅ Success" under it (mt#3961). Gated on the same condition that
          // decides whether anything was printed at all — flagging the json
          // path would suppress output nobody produced.
          ...(human ? { printed: true } : {}),
          success: true,
          delivered: true,
          messageId: result.messageId,
          chatId: result.chatId,
          configSource: result.source,
          ...(result.fellBackFromDeadTopic ? { fellBackFromDeadTopic: true } : {}),
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
        // Same gate as the delivered branch: the line above carries the reason
        // and the detail, so the formatter has nothing to add (mt#3961).
        ...(human ? { printed: true } : {}),
        success: succeeded,
        delivered: false,
        reason: result.reason,
        detail: result.detail,
        ...(succeeded ? {} : { error: result.detail }),
      };
    },
  });
}
