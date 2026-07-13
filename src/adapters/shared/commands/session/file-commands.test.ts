/**
 * Regression test for the session_edit-file sessionId-resolution fix (mt#2742).
 *
 * The bug (Detector B): `resolveSessionId` read `params.session`, but the command
 * declares `sessionId` (session-parameters.ts) — so an explicitly-passed session id
 * arrived under `sessionId`, `params.session` was always undefined, and the command
 * silently fell through to `getCurrentSession(cwd)` auto-detection, ignoring the id.
 * The fix resolves `params.sessionId ?? params.session`.
 *
 * These assert the resolver via injected deps (no filesystem/session I/O), mirroring
 * apply-post-merge-state-sync-command.test.ts's resolver-test pattern.
 */

import { describe, test, expect } from "bun:test";
import { resolveSessionId } from "./file-commands";
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
    });
    expect(id).toBe("explicit-1");
    // The bug: this used to be ignored → getCurrentSession consulted anyway.
    expect(calls).toEqual([]);
  });

  test("falls back to the legacy `session` key when sessionId is absent", async () => {
    const id = await resolveSessionId(depsWithCurrent("auto-detected"), { session: "legacy-1" });
    expect(id).toBe("legacy-1");
  });

  test("prefers sessionId over the legacy `session` key", async () => {
    const id = await resolveSessionId(depsWithCurrent("auto"), {
      sessionId: "win",
      session: "lose",
    });
    expect(id).toBe("win");
  });

  test("auto-detects from cwd only when neither id is provided", async () => {
    const calls: string[] = [];
    const id = await resolveSessionId(depsWithCurrent("current-session", calls), {});
    expect(id).toBe("current-session");
    expect(calls).toHaveLength(1);
  });

  test("throws when neither is provided and no current session is detectable", async () => {
    await expect(resolveSessionId(depsWithCurrent(null), {})).rejects.toBeInstanceOf(MinskyError);
  });
});
