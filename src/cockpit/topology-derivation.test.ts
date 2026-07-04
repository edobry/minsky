/**
 * Unit tests for the slow-clock topology derivation pure functions (mt#2602).
 *
 * Covers: registry walk + dedupe across the mt#2304 migration window,
 * git-log parsing (canned `git log` output — no real subprocess), and the
 * retrospective correlation logic (task-ref strong match, time-proximity
 * weaker match, honest "unknown" when neither applies).
 */

import { describe, test, expect } from "bun:test";
import {
  deriveHookRegistry,
  deriveTaskIdFromSubject,
  parseHookInstallLog,
  correlateRetrospective,
  buildWeldEntries,
  RETROSPECTIVE_CORRELATION_WINDOW_MS,
  type HookInstallInfo,
  type RetrospectiveEventInput,
  type HookRegistryEntry,
} from "./topology-derivation";

// Shared fixture literals (custom/no-magic-string-duplication) — a single
// hook name/filename reused across several registry-dedupe test cases below.
const SAMPLE_HOOK_NAME = "check-branch-fresh";
const SAMPLE_HOOK_FILE = `${SAMPLE_HOOK_NAME}.ts`;
const SAMPLE_HOOK_TEST_FILE = `${SAMPLE_HOOK_NAME}.test.ts`;
const FOO_HOOK_FILE_PATH = ".claude/hooks/foo.ts";

// ---------------------------------------------------------------------------
// deriveHookRegistry
// ---------------------------------------------------------------------------

describe("deriveHookRegistry", () => {
  test("pre-migration: only .claude/hooks exists", () => {
    const registry = deriveHookRegistry({
      claudeHooks: [SAMPLE_HOOK_FILE, "block-git-gh-cli.ts", SAMPLE_HOOK_TEST_FILE],
      minskyHooks: null,
    });
    expect(registry).toEqual([
      { name: "block-git-gh-cli", sourceDir: ".claude/hooks" },
      { name: SAMPLE_HOOK_NAME, sourceDir: ".claude/hooks" },
    ]);
  });

  test("post-migration: only .minsky/hooks exists", () => {
    const registry = deriveHookRegistry({
      claudeHooks: null,
      minskyHooks: [SAMPLE_HOOK_FILE, SAMPLE_HOOK_TEST_FILE],
    });
    expect(registry).toEqual([{ name: SAMPLE_HOOK_NAME, sourceDir: ".minsky/hooks" }]);
  });

  test("mid-flight migration: same hook in both dirs dedupes, .minsky/hooks wins", () => {
    const registry = deriveHookRegistry({
      claudeHooks: [SAMPLE_HOOK_FILE, "legacy-only.ts"],
      minskyHooks: [SAMPLE_HOOK_FILE, "new-only.ts"],
    });
    expect(registry).toEqual([
      { name: SAMPLE_HOOK_NAME, sourceDir: ".minsky/hooks" },
      { name: "legacy-only", sourceDir: ".claude/hooks" },
      { name: "new-only", sourceDir: ".minsky/hooks" },
    ]);
  });

  test("both dirs absent (fs error) yields an empty registry, not a crash", () => {
    expect(deriveHookRegistry({ claudeHooks: null, minskyHooks: null })).toEqual([]);
  });

  test("non-.ts and .test.ts files are excluded", () => {
    const registry = deriveHookRegistry({
      claudeHooks: ["foo.ts", "foo.test.ts", "README.md", "types.d.ts.bak"],
      minskyHooks: null,
    });
    expect(registry.map((r) => r.name)).toEqual(["foo"]);
  });
});

// ---------------------------------------------------------------------------
// deriveTaskIdFromSubject
// ---------------------------------------------------------------------------

describe("deriveTaskIdFromSubject", () => {
  test("extracts a lowercase mt#N ref from a conventional-commit subject", () => {
    expect(deriveTaskIdFromSubject("fix(mt#2537): wire hook.fired bridge")).toBe("mt#2537");
    expect(deriveTaskIdFromSubject("feat(MT#42): something")).toBe("mt#42");
  });

  test("returns null when no task ref is present", () => {
    expect(deriveTaskIdFromSubject("chore: bump deps")).toBeNull();
    expect(deriveTaskIdFromSubject(null)).toBeNull();
    expect(deriveTaskIdFromSubject(undefined)).toBeNull();
    expect(deriveTaskIdFromSubject("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseHookInstallLog
// ---------------------------------------------------------------------------

describe("parseHookInstallLog", () => {
  test("parses commit + file lines into a per-hook install map", () => {
    const stdout = [
      "COMMIT\tabc1234abc1234abc1234abc1234abc1234abcd\t2026-01-01T00:00:00-05:00\tfeat(mt#100): add check-branch-fresh",
      ".claude/hooks/check-branch-fresh.ts",
      "COMMIT\tdef5678def5678def5678def5678def5678defa\t2026-02-01T00:00:00-05:00\tfeat(mt#200): add block-git-gh-cli",
      ".claude/hooks/block-git-gh-cli.ts",
    ].join("\n");

    const map = parseHookInstallLog(stdout);
    expect(map.size).toBe(2);
    expect(map.get(SAMPLE_HOOK_NAME)).toEqual({
      name: SAMPLE_HOOK_NAME,
      commitSha: "abc1234abc1234abc1234abc1234abc1234abcd",
      commitDate: "2026-01-01T00:00:00-05:00",
      commitSubject: "feat(mt#100): add check-branch-fresh",
      derivedTaskId: "mt#100",
    });
    expect(map.get("block-git-gh-cli")?.derivedTaskId).toBe("mt#200");
  });

  test("--reverse means the FIRST occurrence per name is kept (original install, not a later touch)", () => {
    const stdout = [
      "COMMIT\t1111111111111111111111111111111111111a\t2026-01-01T00:00:00Z\tfeat(mt#1): original add",
      FOO_HOOK_FILE_PATH,
      "COMMIT\t2222222222222222222222222222222222222b\t2026-03-01T00:00:00Z\tfix(mt#2): re-add after rename-back",
      FOO_HOOK_FILE_PATH,
    ].join("\n");

    const map = parseHookInstallLog(stdout);
    expect(map.get("foo")?.commitSha).toBe("1111111111111111111111111111111111111a");
    expect(map.get("foo")?.derivedTaskId).toBe("mt#1");
  });

  test("ignores .test.ts adds and non-hook paths", () => {
    const stdout = [
      "COMMIT\t1111111111111111111111111111111111111a\t2026-01-01T00:00:00Z\tfeat(mt#1): add hook + test",
      FOO_HOOK_FILE_PATH,
      ".claude/hooks/foo.test.ts",
      "src/unrelated-file.ts",
    ].join("\n");

    const map = parseHookInstallLog(stdout);
    expect(Array.from(map.keys())).toEqual(["foo"]);
  });

  test("malformed / unparseable commit lines are skipped rather than throwing", () => {
    const stdout = [
      "COMMIT\tnot-a-valid-sha\t2026-01-01T00:00:00Z\tfeat: bad sha",
      FOO_HOOK_FILE_PATH,
      "",
      "garbage line with no leading COMMIT and no prior commit context",
    ].join("\n");

    expect(() => parseHookInstallLog(stdout)).not.toThrow();
    expect(parseHookInstallLog(stdout).size).toBe(0);
  });

  test("empty stdout yields an empty map", () => {
    expect(parseHookInstallLog("").size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// correlateRetrospective
// ---------------------------------------------------------------------------

function hook(overrides: Partial<HookInstallInfo> = {}): HookInstallInfo {
  return {
    name: "foo",
    commitSha: "abc1234abc1234abc1234abc1234abc1234abcd",
    commitDate: "2026-06-10T00:00:00Z",
    commitSubject: "fix(mt#500): add foo hook",
    derivedTaskId: "mt#500",
    ...overrides,
  };
}

function retro(overrides: Partial<RetrospectiveEventInput> = {}): RetrospectiveEventInput {
  return {
    id: "retro-1",
    createdAt: "2026-06-09T00:00:00Z",
    payload: { note: "found the bug", taskId: "mt#500" },
    ...overrides,
  };
}

describe("correlateRetrospective", () => {
  test("task-ref match wins even when a closer time-proximity candidate exists", () => {
    const taskRefMatch = retro({ id: "retro-task-ref", createdAt: "2026-05-01T00:00:00Z" });
    const closerButWrongTask = retro({
      id: "retro-closer",
      createdAt: "2026-06-09T23:00:00Z",
      payload: { note: "unrelated", taskId: "mt#999" },
    });
    const link = correlateRetrospective(hook(), [closerButWrongTask, taskRefMatch]);
    expect(link).toEqual({
      eventId: "retro-task-ref",
      note: "found the bug",
      taskId: "mt#500",
      createdAt: "2026-05-01T00:00:00Z",
      matchType: "task-ref",
    });
  });

  test("falls back to nearest preceding retrospective within the window when no task-ref matches", () => {
    const far = retro({
      id: "retro-far",
      createdAt: "2026-05-01T00:00:00Z",
      payload: { note: "far", taskId: "mt#other" },
    });
    const near = retro({
      id: "retro-near",
      createdAt: "2026-06-08T00:00:00Z",
      payload: { note: "near", taskId: "mt#other" },
    });
    const link = correlateRetrospective(hook({ derivedTaskId: null }), [far, near]);
    expect(link?.eventId).toBe("retro-near");
    expect(link?.matchType).toBe("time-proximity");
  });

  test("a retrospective AFTER the install commit is never matched by time-proximity", () => {
    const after = retro({
      id: "retro-after",
      createdAt: "2026-06-11T00:00:00Z",
      payload: { note: "after", taskId: "mt#other" },
    });
    expect(correlateRetrospective(hook({ derivedTaskId: null }), [after])).toBeNull();
  });

  test("a retrospective outside the correlation window is not matched", () => {
    const tooFar = retro({
      id: "retro-too-far",
      createdAt: new Date(
        Date.parse("2026-06-10T00:00:00Z") - RETROSPECTIVE_CORRELATION_WINDOW_MS - 1000
      ).toISOString(),
      payload: { note: "too far", taskId: "mt#other" },
    });
    expect(correlateRetrospective(hook({ derivedTaskId: null }), [tooFar])).toBeNull();
  });

  test("renders honest null (no invented link) when the hook has no install date", () => {
    expect(correlateRetrospective(hook({ commitDate: null }), [retro()])).toBeNull();
  });

  test("renders honest null when no retrospectives are supplied", () => {
    expect(correlateRetrospective(hook({ derivedTaskId: null }), [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildWeldEntries
// ---------------------------------------------------------------------------

describe("buildWeldEntries", () => {
  const registry: HookRegistryEntry[] = [
    { name: "newer-hook", sourceDir: ".minsky/hooks" },
    { name: "older-hook", sourceDir: ".claude/hooks" },
    { name: "unknown-hook", sourceDir: ".claude/hooks" },
  ];

  const installMap = new Map<string, HookInstallInfo>([
    [
      "newer-hook",
      hook({
        name: "newer-hook",
        commitDate: "2026-06-15T00:00:00Z",
        commitSha: "newer00000000000000000000000000000000",
      }),
    ],
    [
      "older-hook",
      hook({
        name: "older-hook",
        commitDate: "2026-01-01T00:00:00Z",
        commitSha: "older00000000000000000000000000000000",
        derivedTaskId: null,
      }),
    ],
    // unknown-hook deliberately absent from installMap — no git history found.
  ]);

  test("sorts most-recently-installed first; undated entries sort last, alphabetically", () => {
    const entries = buildWeldEntries(registry, installMap, [], "https://github.com/edobry/minsky");
    expect(entries.map((e) => e.name)).toEqual(["newer-hook", "older-hook", "unknown-hook"]);
  });

  test("constructs a GitHub commit URL when a repoWebBase and commitSha are available", () => {
    const entries = buildWeldEntries(registry, installMap, [], "https://github.com/edobry/minsky");
    const newer = entries.find((e) => e.name === "newer-hook");
    expect(newer?.commitUrl).toBe(
      "https://github.com/edobry/minsky/commit/newer00000000000000000000000000000000"
    );
  });

  test("renders honest unknown fields (null, not fabricated) for an undated hook", () => {
    const entries = buildWeldEntries(registry, installMap, [], "https://github.com/edobry/minsky");
    const unknown = entries.find((e) => e.name === "unknown-hook");
    expect(unknown).toEqual({
      name: "unknown-hook",
      sourceDir: ".claude/hooks",
      installDate: null,
      commitSha: null,
      commitUrl: null,
      retrospective: null,
    });
  });

  test("no repoWebBase (non-GitHub remote / unresolved) yields null commit URLs, not a guess", () => {
    const entries = buildWeldEntries(registry, installMap, [], null);
    expect(entries.every((e) => e.commitUrl === null)).toBe(true);
  });

  test("threads retrospective correlation through end to end", () => {
    const linkedRetro = retro({
      id: "retro-link",
      createdAt: "2025-12-31T00:00:00Z",
      payload: { note: "found it", taskId: "mt#other-older" },
    });
    const customInstall = new Map<string, HookInstallInfo>([
      [
        "older-hook",
        hook({
          name: "older-hook",
          commitDate: "2026-01-01T00:00:00Z",
          commitSha: "older00000000000000000000000000000000",
          derivedTaskId: null,
        }),
      ],
    ]);
    const entries = buildWeldEntries(
      [{ name: "older-hook", sourceDir: ".claude/hooks" }],
      customInstall,
      [linkedRetro],
      null
    );
    expect(entries[0]?.retrospective?.eventId).toBe("retro-link");
    expect(entries[0]?.retrospective?.matchType).toBe("time-proximity");
  });
});
