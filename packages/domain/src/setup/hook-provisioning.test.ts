/**
 * Tests for observability-hook provisioning (mt#3499).
 *
 * Covers the spec's acceptance tests that do not require a live cockpit
 * daemon: merge-not-overwrite, idempotency, registration shape, and the
 * fail-loud source resolution. The end-to-end "a conversation in a scratch
 * project produces a run-state row" test is the live exercise, run separately
 * and recorded in the PR body.
 */

import { describe, test, expect } from "bun:test";
import * as path from "path";
import type { FsLike } from "../interfaces/fs-like";
import {
  BASELINE_INSTALL_FILES,
  BASELINE_HOOK_TIMEOUT_SECONDS,
  OBSERVABILITY_BASELINE_HOOKS,
  PROJECT_LOCAL_SETTINGS_FILENAME,
  buildBaselineRegistration,
  mergeHookRegistration,
  provisionObservabilityHooks,
  resolveHookInstallDir,
  resolveHookSourceDir,
} from "./hook-provisioning";
import { OBSERVED_HOOK_EVENTS } from "../conversation-run-state/event-mapping";

const SOURCE_DIR = "/fake/minsky/.claude/hooks";
const INSTALL_DIR = "/fake/state/minsky/hooks";
const REPO = "/fake/project";
const SETTINGS = path.join(REPO, ".claude", PROJECT_LOCAL_SETTINGS_FILENAME);

/** In-memory FsLike seeded with the baseline sources. Deliberately omits
 *  `chmod` — provisioning must tolerate a double that does not implement it. */
function makeFs(seed: Record<string, string> = {}): FsLike & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed));
  for (const name of BASELINE_INSTALL_FILES) {
    files.set(path.join(SOURCE_DIR, name), `// contents of ${name}\n`);
  }
  return {
    files,
    readFile: async (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: async (p, data) => {
      files.set(p, typeof data === "string" ? data : data.toString());
    },
    mkdir: async () => undefined,
    readdir: async () => [],
    stat: async () => ({ isFile: () => true, isDirectory: () => false }),
    access: async () => undefined,
    unlink: async () => undefined,
    copyFile: async () => undefined,
    exists: async (p) => files.has(p),
    rm: async () => undefined,
  };
}

async function provision(fs: FsLike) {
  return provisionObservabilityHooks(
    { repoPath: REPO, sourceDir: SOURCE_DIR, installDir: INSTALL_DIR },
    fs
  );
}

function readSettings(fs: { files: Map<string, string> }): Record<string, unknown> {
  const raw = fs.files.get(SETTINGS);
  if (raw === undefined) throw new Error("settings file was not written");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("baseline registration", () => {
  test("registers run-state on every OBSERVED_HOOK_EVENTS event", () => {
    const reg = buildBaselineRegistration(INSTALL_DIR);
    for (const event of OBSERVED_HOOK_EVENTS) {
      const groups = reg[event];
      expect(groups).toBeDefined();
      const commands = (groups ?? []).flatMap((g) => g.hooks.map((h) => h.command));
      expect(commands).toContain(path.join(INSTALL_DIR, "record-conversation-run-state.ts"));
    }
  });

  test("tool-scoped events carry a matcher; lifecycle events do not", () => {
    const reg = buildBaselineRegistration(INSTALL_DIR);
    // PreToolUse fires per tool call and needs a tool-name matcher.
    expect(reg["PreToolUse"]?.[0]?.matcher).toBe("*");
    // Stop is a lifecycle event — a matcher there would be meaningless.
    expect(reg["Stop"]?.[0]?.matcher).toBeUndefined();
  });

  test("SessionEnd carries BOTH run-state and transcript ingest", () => {
    const commands = (buildBaselineRegistration(INSTALL_DIR)["SessionEnd"] ?? []).flatMap((g) =>
      g.hooks.map((h) => h.command)
    );
    expect(commands).toContain(path.join(INSTALL_DIR, "record-conversation-run-state.ts"));
    expect(commands).toContain(path.join(INSTALL_DIR, "transcript-ingest-on-session-end.ts"));
  });

  test("every command carries the harness timeout budget", () => {
    const reg = buildBaselineRegistration(INSTALL_DIR);
    const timeouts = Object.values(reg).flatMap((groups) =>
      groups.flatMap((g) => g.hooks.map((h) => h.timeout))
    );
    expect(timeouts.length).toBeGreaterThan(0);
    expect(new Set(timeouts)).toEqual(new Set([BASELINE_HOOK_TIMEOUT_SECONDS]));
  });
});

describe("merge semantics", () => {
  test("preserves unrelated top-level keys and unrelated hook groups", () => {
    const foreignGroup = {
      matcher: "Edit",
      hooks: [{ type: "command", command: "/somewhere/else/user-hook.sh", timeout: 3 }],
    };
    const merged = mergeHookRegistration(
      { model: "opus", hooks: { PreToolUse: [foreignGroup], Custom: [foreignGroup] } },
      buildBaselineRegistration(INSTALL_DIR),
      INSTALL_DIR
    );

    expect(merged["model"]).toBe("opus");
    const hooks = merged["hooks"] as Record<string, unknown[]>;
    // The user's own PreToolUse hook survives alongside ours.
    expect(hooks["PreToolUse"]).toContainEqual(foreignGroup);
    // An event we never touch is untouched.
    expect(hooks["Custom"]).toEqual([foreignGroup]);
  });

  test("is idempotent — a second merge does not duplicate our groups", () => {
    const reg = buildBaselineRegistration(INSTALL_DIR);
    const once = mergeHookRegistration({}, reg, INSTALL_DIR);
    const twice = mergeHookRegistration(once, reg, INSTALL_DIR);
    expect(twice).toEqual(once);
  });
});

describe("provisionObservabilityHooks", () => {
  test("installs every baseline file and writes the LOCAL settings file", async () => {
    const fs = makeFs();
    const result = await provision(fs);

    for (const name of BASELINE_INSTALL_FILES) {
      expect(fs.files.has(path.join(INSTALL_DIR, name))).toBe(true);
    }
    expect(result.settingsPath).toBe(SETTINGS);
    // The committed team-shared file must NOT be touched (Claude Code settings
    // docs: settings.json is checked in and shared; local is personal).
    expect(fs.files.has(path.join(REPO, ".claude", "settings.json"))).toBe(false);
    // Nothing is written into the target repo except that one settings file.
    const inRepo = [...fs.files.keys()].filter((p) => p.startsWith(REPO));
    expect(inRepo).toEqual([SETTINGS]);
  });

  test("a pre-existing unrelated hook in settings.local.json survives", async () => {
    const userHook = {
      matcher: "Bash",
      hooks: [{ type: "command", command: "/usr/local/bin/my-audit.sh", timeout: 10 }],
    };
    const fs = makeFs({
      [SETTINGS]: JSON.stringify({ statusLine: "custom", hooks: { PreToolUse: [userHook] } }),
    });

    await provision(fs);
    const settings = readSettings(fs);

    expect(settings["statusLine"]).toBe("custom");
    const preToolUse = (settings["hooks"] as Record<string, unknown[]>)["PreToolUse"] ?? [];
    expect(preToolUse).toContainEqual(userHook);
    // Exactly two: the user's own hook, plus ours — not a duplicate of either.
    expect(preToolUse.length).toBe(2);
  });

  test("running twice adds no duplicate registrations", async () => {
    const fs = makeFs();
    await provision(fs);
    const after1 = readSettings(fs);
    await provision(fs);
    const after2 = readSettings(fs);
    expect(after2).toEqual(after1);
  });

  test("an unparseable existing settings file does not fail init", async () => {
    const fs = makeFs({ [SETTINGS]: "{ this is not json" });
    await provision(fs);
    // A well-formed file replaces the corrupt one rather than throwing.
    const settings = readSettings(fs);
    expect(Object.keys(settings["hooks"] as object).length).toBeGreaterThan(0);
  });

  test("registered commands point at the install dir, not the project", async () => {
    const fs = makeFs();
    await provision(fs);
    const settings = readSettings(fs);
    const commands = Object.values(
      settings["hooks"] as Record<string, { hooks: { command: string }[] }[]>
    )
      .flat()
      .flatMap((g) => g.hooks.map((h) => h.command));

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.startsWith(INSTALL_DIR)).toBe(true);
    }
  });
});

describe("path resolution", () => {
  test("install dir honors MINSKY_STATE_DIR", () => {
    expect(resolveHookInstallDir({ MINSKY_STATE_DIR: "/tmp/st" } as NodeJS.ProcessEnv)).toBe(
      path.join("/tmp/st", "hooks")
    );
  });

  test("source resolution fails LOUD on a bad override, naming the path", () => {
    expect(() =>
      resolveHookSourceDir({ MINSKY_HOOK_SOURCE_DIR: "/nope/does/not/exist" } as NodeJS.ProcessEnv)
    ).toThrow(/\/nope\/does\/not\/exist/);
  });

  test("resolves the real hook sources from this installation", () => {
    // Guards the production default: whichever tree this runs from, the
    // resolver must find the actual baseline files. A silent miss here is how
    // provisioning would install nothing.
    const dir = resolveHookSourceDir({} as NodeJS.ProcessEnv);
    expect(dir.length).toBeGreaterThan(0);
    expect(OBSERVABILITY_BASELINE_HOOKS.length).toBe(2);
  });
});
