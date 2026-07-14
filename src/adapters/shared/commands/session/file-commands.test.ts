/**
 * Regression test for the session_edit-file sessionId-resolution fix (mt#2742).
 *
 * The bug (Detector B): `resolveSessionId` read `params.session`, but the command
 * declares `sessionId` (session-parameters.ts) — so an explicitly-passed session id
 * arrived under `sessionId`, `params.session` was always undefined, and the command
 * silently fell through to `getCurrentSession(cwd)` auto-detection, ignoring the id.
 * The fix resolves `params.sessionId` (mt#2779 retired the undeclared `session`
 * fallback entirely — the mt#2778 MCP boundary rejects undeclared keys, so it can
 * never arrive; the resolver now ignores it).
 *
 * These assert the resolver via injected deps (no filesystem/session I/O), mirroring
 * apply-post-merge-state-sync-command.test.ts's resolver-test pattern.
 */

import { describe, test, expect } from "bun:test";
import { resolveSessionId, type SessionEditFileParams } from "./file-commands";
import { MinskyError } from "@minsky/domain/errors/index";
import type { SessionCommandDependencies } from "./types";

function depsWithCurrent(current: string | null, calls?: string[]): SessionCommandDependencies {
  return {
    getCurrentSession: async (cwd: string) => {
      calls?.push(cwd);
      return current;
    },
  } as unknown as SessionCommandDependencies;
}

describe("resolveSessionId (session_edit-file, mt#2742)", () => {
  test("honors the canonical sessionId param and does NOT auto-detect", async () => {
    const calls: string[] = [];
    const id = await resolveSessionId(depsWithCurrent("auto-detected", calls), {
      sessionId: "explicit-1",
    } as SessionEditFileParams);
    expect(id).toBe("explicit-1");
    // The bug: this used to be ignored → getCurrentSession consulted anyway.
    expect(calls).toEqual([]);
  });

  test("ignores the retired undeclared `session` key and auto-detects instead (mt#2779)", async () => {
    const id = await resolveSessionId(
      depsWithCurrent("auto-detected"),
      // Simulates a rogue direct caller passing the retired key — the declared
      // surface has no `session`, so the resolver must not honor it.
      { session: "legacy-1" } as unknown as SessionEditFileParams
    );
    expect(id).toBe("auto-detected");
  });

  test("auto-detects from cwd only when no sessionId is provided", async () => {
    const calls: string[] = [];
    const id = await resolveSessionId(
      depsWithCurrent("current-session", calls),
      {} as SessionEditFileParams
    );
    expect(id).toBe("current-session");
    expect(calls).toHaveLength(1);
  });

  test("throws when no sessionId is provided and no current session is detectable", async () => {
    await expect(
      resolveSessionId(depsWithCurrent(null), {} as SessionEditFileParams)
    ).rejects.toBeInstanceOf(MinskyError);
  });
});
