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

const ENABLED = "MINSKY_PRINCIPAL_CHANNEL_ENABLED";
const CWD_VAR = "MINSKY_PRINCIPAL_CHANNEL_CWD";
const MODE_VAR = "MINSKY_PRINCIPAL_CHANNEL_PERMISSION_MODE";

describe("loadPrincipalChannelLaunchConfig", () => {
  test("is disabled unless explicitly enabled", () => {
    expect(loadPrincipalChannelLaunchConfig({}).enabled).toBe(false);
  });

  test("only the exact string enables it", () => {
    // Guards against "1"/"yes"/"TRUE" quietly turning on an RCE-adjacent surface.
    expect(loadPrincipalChannelLaunchConfig({ [ENABLED]: "1" }).enabled).toBe(false);
    expect(loadPrincipalChannelLaunchConfig({ [ENABLED]: "yes" }).enabled).toBe(false);
    expect(loadPrincipalChannelLaunchConfig({ [ENABLED]: "true" }).enabled).toBe(true);
  });

  test("defaults the working directory to a non-empty path when unset", () => {
    // Asserted structurally rather than against process.cwd(): the point is
    // that the conversation always has somewhere to run, not which directory
    // this particular test process happens to sit in.
    expect(loadPrincipalChannelLaunchConfig({}).cwd.length).toBeGreaterThan(0);
  });

  test("honours an explicit working directory", () => {
    expect(loadPrincipalChannelLaunchConfig({ [CWD_VAR]: "/srv/work" }).cwd).toBe("/srv/work");
  });

  test("permission mode matches other driven sessions by default", () => {
    expect(loadPrincipalChannelLaunchConfig({}).permissionMode).toBe("bypassPermissions");
  });

  test("'default' tightens it", () => {
    expect(loadPrincipalChannelLaunchConfig({ [MODE_VAR]: "default" }).permissionMode).toBe(
      "default"
    );
  });

  test("an unrecognized mode falls back to the permissive default, not the strict one", () => {
    // A typo must not silently produce a channel that answers but can never
    // act — that reads as an unhelpful agent, not as a misconfiguration.
    expect(loadPrincipalChannelLaunchConfig({ [MODE_VAR]: "deafult" }).permissionMode).toBe(
      "bypassPermissions"
    );
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

describe("createEventLogCursor", () => {
  test("reads through to the event log", async () => {
    const cursor = createEventLogCursor(async () => 77);
    expect(await cursor.read()).toBe(77);
  });

  test("write is a no-op — the audit row IS the cursor", async () => {
    // A second store would be a second source of truth able to disagree.
    const cursor = createEventLogCursor(async () => 77);
    await cursor.write(99);
    expect(await cursor.read()).toBe(77);
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
