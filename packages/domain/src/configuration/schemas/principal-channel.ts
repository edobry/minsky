/**
 * Principal-channel configuration (mt#3230).
 *
 * The channel (mt#3228) shipped opt-in via `MINSKY_PRINCIPAL_CHANNEL_ENABLED`,
 * read straight from `process.env` at daemon startup. That worked for a daemon
 * started from a terminal and silently did nothing for the deployment that
 * actually runs: the cockpit-tray app spawns the daemon inheriting the macOS
 * GUI session environment (`cockpit-tray/src-tauri/src/supervisor.rs`
 * `spawn_daemon` overrides only `PATH`), which a user's shell is not part of.
 * The mechanism existed with no supported way to turn it on.
 *
 * Config is the fix because it is independent of how the process was launched.
 * The env vars still work and still win — they are registered in
 * `sources/environment.ts` `environmentMappings` as explicit paths into this
 * slot, and the environment source is merged LAST — so a deployed service can
 * keep setting them.
 *
 * `strictObject` so a typo inside the slot fails loud at load time rather than
 * leaving the channel mysteriously off.
 */

import { z } from "zod";

/**
 * Permission mode for the standing channel conversation.
 *
 * Defaults to `bypassPermissions`, matching every other driven session the
 * cockpit spawns: in headless `-p` mode a permission prompt has nowhere to go,
 * so `default` leaves the session able to answer questions but not act. This
 * is a real security decision — see `docs/principal-channel.md §Security`.
 */
export const principalChannelPermissionModeSchema = z
  .enum(["bypassPermissions", "default"])
  .default("bypassPermissions");

export const principalChannelConfigSchema = z.strictObject({
  /**
   * Starts the inbound Telegram poller. Off unless explicitly set: an
   * inbound message becomes a user turn in a local `claude` process, and the
   * Telegram credentials that resolve on this deployment were provisioned
   * for reviewer alerts, so enabling off their mere presence would be a
   * silent capability escalation.
   */
  enabled: z.boolean().default(false),

  /** Working directory for the standing conversation. Defaults to the daemon's own. */
  cwd: z.string().min(1).optional(),

  permissionMode: principalChannelPermissionModeSchema,

  /**
   * Telegram sender ids permitted to drive the channel.
   *
   * Required for a GROUP chat, where chat and sender are different things and
   * an empty list means any member can drive the swarm. For a PRIVATE chat it
   * is derived from the chat id (Telegram gives a private chat the same id as
   * the user on the other end), so leaving it empty is correct there.
   */
  allowedUserIds: z.array(z.string().min(1)).default([]),
});

export type PrincipalChannelConfig = z.infer<typeof principalChannelConfigSchema>;
