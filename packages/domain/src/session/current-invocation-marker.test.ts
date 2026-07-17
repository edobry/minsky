/* eslint-disable custom/no-real-fs-in-tests -- this module IS a thin fs wrapper; testing it
   requires real file I/O against a scratch tmp dir (mirrors the pattern already used for
   dispatch-recovery-probe's sibling handoff.md convention). */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync as fsExistsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCurrentInvocationMarkerPath,
  writeCurrentInvocationMarker,
  readCurrentInvocationMarker,
} from "./current-invocation-marker";

describe("current-invocation-marker", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs = [];
  });

  function makeSessionDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mt2831-marker-"));
    dirs.push(dir);
    return dir;
  }

  test("getCurrentInvocationMarkerPath follows the handoff.md sibling convention", () => {
    const path = getCurrentInvocationMarkerPath("/sessions/abc", "abc");
    expect(path).toBe("/sessions/abc/.minsky/sessions/abc/current-invocation-id");
  });

  test("read returns null when the marker does not exist", async () => {
    const sessionDir = makeSessionDir();
    const result = await readCurrentInvocationMarker(sessionDir, "sess-1");
    expect(result).toBeNull();
  });

  test("write then read round-trips the invocation id", async () => {
    const sessionDir = makeSessionDir();
    const ok = await writeCurrentInvocationMarker(sessionDir, "sess-1", "invocation-abc");
    expect(ok).toBe(true);

    const result = await readCurrentInvocationMarker(sessionDir, "sess-1");
    expect(result).toBe("invocation-abc");
  });

  test("a later write overwrites the marker (recovery reassigns the current invocation)", async () => {
    const sessionDir = makeSessionDir();
    await writeCurrentInvocationMarker(sessionDir, "sess-1", "original-id");
    await writeCurrentInvocationMarker(sessionDir, "sess-1", "resumed-id");

    const result = await readCurrentInvocationMarker(sessionDir, "sess-1");
    expect(result).toBe("resumed-id");
  });

  test("read returns null for a whitespace-only marker", async () => {
    const sessionDir = makeSessionDir();
    const path = getCurrentInvocationMarkerPath(sessionDir, "sess-1");
    await Bun.write(path, "   \n");

    const result = await readCurrentInvocationMarker(sessionDir, "sess-1");
    expect(result).toBeNull();
  });

  test("read fails open (returns null, does not throw) for an unreadable path", async () => {
    // A path under a directory that doesn't exist and won't be created by read.
    const result = await readCurrentInvocationMarker("/nonexistent-mt2831-dir", "sess-1");
    expect(result).toBeNull();
  });

  test("write creates the missing parent directory tree (mt#2831 R3 BLOCKING #1 — fresh session dir)", async () => {
    // Deliberately does NOT mkdtempSync a real directory first — mirrors a fresh
    // session workspace that has never had `.minsky/sessions/<id>/` created (no
    // handoff.md, no prior marker write). Only the TOP-level scratch dir is
    // guaranteed to exist (created once, below); the `.minsky/sessions/<id>/`
    // subtree under it must be created BY the write itself.
    const parentDir = mkdtempSync(join(tmpdir(), "mt2831-marker-freshsession-"));
    dirs.push(parentDir);
    const sessionDir = join(parentDir, "brand-new-session-workspace");
    // Confirm the precondition: sessionDir itself does not exist yet.
    expect(fsExistsSync(sessionDir)).toBe(false);

    const ok = await writeCurrentInvocationMarker(sessionDir, "sess-fresh", "invocation-xyz");
    expect(ok).toBe(true);

    const result = await readCurrentInvocationMarker(sessionDir, "sess-fresh");
    expect(result).toBe("invocation-xyz");
  });
});
