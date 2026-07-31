/**
 * Tests for the principal channel's composition root (mt#3228).
 *
 * The opt-in and permission-mode cases are the ones with teeth: both decide how
 * much authority an inbound Telegram message carries on this machine.
 */

import { describe, expect, test } from "bun:test";
import {
  createEventLogCursor,
  loadPrincipalChannelLaunchConfig,
  resolveAllowedUserIds,
  startPrincipalChannel,
} from "./principal-channel-launch";

describe("loadPrincipalChannelLaunchConfig (mt#3230 — config, not env)", () => {
  test("an absent section leaves the channel off", () => {
    expect(loadPrincipalChannelLaunchConfig({}).enabled).toBe(false);
  });

  test("only a literal true enables it", () => {
    // Guards against a truthy-but-not-true value quietly turning on an
    // RCE-adjacent surface. The env path coerces "true"/"1"/"yes" to a boolean
    // in the config layer; anything reaching here is already typed.
    expect(loadPrincipalChannelLaunchConfig({ enabled: true }).enabled).toBe(true);
    expect(loadPrincipalChannelLaunchConfig({ enabled: false }).enabled).toBe(false);
  });

  test("defaults the working directory to a non-empty path when unset", () => {
    // Asserted structurally rather than against process.cwd(): the point is
    // that the conversation always has somewhere to run, not which directory
    // this particular test process happens to sit in.
    expect(loadPrincipalChannelLaunchConfig({}).cwd.length).toBeGreaterThan(0);
  });

  test("honours an explicit working directory", () => {
    expect(loadPrincipalChannelLaunchConfig({ cwd: "/srv/work" }).cwd).toBe("/srv/work");
  });

  test("an empty working directory falls back rather than running in nowhere", () => {
    expect(loadPrincipalChannelLaunchConfig({ cwd: "" }).cwd.length).toBeGreaterThan(0);
  });

  test("permission mode matches other driven sessions by default", () => {
    expect(loadPrincipalChannelLaunchConfig({}).permissionMode).toBe("bypassPermissions");
  });

  test("'default' tightens it", () => {
    expect(loadPrincipalChannelLaunchConfig({ permissionMode: "default" }).permissionMode).toBe(
      "default"
    );
  });

  test("carries the sender allowlist through, dropping blanks", () => {
    expect(
      loadPrincipalChannelLaunchConfig({ allowedUserIds: ["777", "  ", "888"] }).allowedUserIds
    ).toEqual(["777", "888"]);
  });
});

describe("resolveAllowedUserIds (PR #2324 R1)", () => {
  test("derives the sender from a private chat id", () => {
    // Telegram gives a private chat the same id as the user on the other end,
    // so pinning the sender to it is exact — and it hardens against a spoofed
    // `from` on an update that otherwise matches the chat.
    expect(resolveAllowedUserIds("167346572", [])).toEqual(["167346572"]);
  });

  test("derives nothing from a group chat id", () => {
    // Group ids are negative and distinct from any member's user id; there is
    // nothing to derive, so this must stay chat-only until configured.
    expect(resolveAllowedUserIds("-100123456", [])).toEqual([]);
  });

  test("an explicit list wins over the derived one", () => {
    expect(resolveAllowedUserIds("167346572", ["777", "888"])).toEqual(["777", "888"]);
  });
});

describe("createEventLogCursor (PR #2324 R3)", () => {
  test("reads through to the event log", async () => {
    const cursor = createEventLogCursor(
      async () => 77,
      async () => {}
    );
    expect(await cursor.read()).toBe(77);
  });

  test("writes an advancement row when the message rows fall short", async () => {
    // The regression: an update that produces no message row (edited_message,
    // an unparsed future type) is never covered by a message-derived cursor, so
    // Telegram re-serves it forever and the channel wedges behind it.
    const advances: number[] = [];
    const cursor = createEventLogCursor(
      async () => 77,
      async (id) => {
        advances.push(id);
      }
    );

    await cursor.write(99);
    expect(advances).toEqual([99]);
  });

  test("writes nothing when the message rows already cover the position", async () => {
    // The common case — every update became a message. No redundant row.
    const advances: number[] = [];
    const cursor = createEventLogCursor(
      async () => 99,
      async (id) => {
        advances.push(id);
      }
    );

    await cursor.write(99);
    expect(advances).toEqual([]);
  });

  test("writes an advancement row on a cold log", async () => {
    const advances: number[] = [];
    const cursor = createEventLogCursor(
      async () => undefined,
      async (id) => {
        advances.push(id);
      }
    );

    await cursor.write(5);
    expect(advances).toEqual([5]);
  });
});

describe("startPrincipalChannel", () => {
  const unusedDeps = {
    respondToAsk: async () => "",
    recordEvent: async () => "recorded" as const,
    readHighestUpdateId: async () => undefined,
  };

  test("does not start when disabled, without touching credentials", async () => {
    const handle = await startPrincipalChannel({
      config: { enabled: false, cwd: "/tmp", permissionMode: "default", allowedUserIds: [] },
      ...unusedDeps,
    });
    expect(handle).toBeNull();
  });
});
