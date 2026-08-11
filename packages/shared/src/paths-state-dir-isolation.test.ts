/**
 * mt#3965 — a test run must not be able to reach the operator's real state dir.
 *
 * `tests/setup.ts` (mt#2872) isolates every run by pointing `MINSKY_STATE_DIR`
 * at a per-run temp dir, and `bunfig.toml` preloads it for every `bun test`. But
 * `getMinskyStateDir()` read only `XDG_STATE_HOME`, so the backstop reached the
 * ~10 hand-rolled resolvers that read `MINSKY_STATE_DIR` inline and missed every
 * consumer of the shared function. The gap was not theoretical: a fixture
 * conversation id reached the production `conversation-by-pid/` map through
 * `conversation-pid-map.ts`, and the next real `/clear` turned it into a
 * fabricated predecessor edge in mt#3943's transition log.
 *
 * The first test is the canary the fix exists for; the rest pin the precedence
 * so a later edit cannot quietly reorder the tiers.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { homedir } from "os";
import { join } from "path";

import { getMinskyStateDir, getSessionsDir } from "./paths";

const ORIGINAL_MINSKY_STATE_DIR = process.env.MINSKY_STATE_DIR;
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME;

function restoreEnv(): void {
  if (ORIGINAL_MINSKY_STATE_DIR === undefined) delete process.env.MINSKY_STATE_DIR;
  else process.env.MINSKY_STATE_DIR = ORIGINAL_MINSKY_STATE_DIR;

  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME;
}

afterEach(restoreEnv);

describe("getMinskyStateDir isolation (mt#3965)", () => {
  test("under the standard preload, resolves away from the operator's real state dir", () => {
    // The property, not the mechanism. An earlier version asserted the exact
    // variable the backstop uses, which would have gone green on a fix that
    // isolated nothing — and red on a correct fix that isolated via the other
    // variable. What has to be true is that a test run cannot reach the
    // operator's own state directory, however the isolation is achieved.
    const resolved = getMinskyStateDir();
    expect(resolved).not.toBe(join(homedir(), ".local/state/minsky"));
    expect(resolved.startsWith(`${homedir()}/`)).toBe(false);

    // The consumers that carried the real pollution derive from this function,
    // so isolating the root only helps if the derived paths follow it.
    expect(getSessionsDir().startsWith(resolved)).toBe(true);
  });

  test("XDG_STATE_HOME decides the state dir, so a test's own override still wins", () => {
    // Seven test files (mt#3415 and siblings) isolate themselves this way. The
    // shared resolver must keep answering to the MORE SPECIFIC override rather
    // than to a process-wide one, which is why mt#3965 fixed the backstop
    // instead of adding a higher-precedence variable here.
    process.env.XDG_STATE_HOME = "/tmp/mt3965-xdg";
    expect(getMinskyStateDir()).toBe("/tmp/mt3965-xdg/minsky");
  });

  test("MINSKY_STATE_DIR does NOT override it — the two families stay separate", () => {
    // Pins the decision so a later 'unification' cannot silently reintroduce
    // the precedence that defeats the seven files above.
    process.env.XDG_STATE_HOME = "/tmp/mt3965-xdg";
    process.env.MINSKY_STATE_DIR = "/tmp/mt3965-explicit";
    expect(getMinskyStateDir()).toBe("/tmp/mt3965-xdg/minsky");
  });
});
