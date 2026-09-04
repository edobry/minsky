/**
 * mt#4866 SC2 — `init --overwrite` preserves every top-level key it does not emit.
 *
 * Pre-fix control, measured live 2026-09-04 at `d667c9634`. A scratch config:
 *
 *     tasks:
 *       backend: minsky
 *     rules:
 *       presets: []
 *       enabled: []
 *       disabled:
 *         - no-such-rule-xyz
 *     someUnrelatedKey: preserve-me
 *
 * After `init --overwrite`, BOTH `rules:` and `someUnrelatedKey` were gone —
 * `init` wrote the freshly generated file unconditionally. The loss is general,
 * not `rules:`-specific, which is why the merge is by top-level key.
 *
 * These are pure string→string assertions: no filesystem, no service, no clock.
 * The fs shell that calls them lives in `init.ts` and is covered end-to-end by the
 * live re-init run recorded in the PR body.
 */

import { describe, it, expect } from "bun:test";
import { parse as parseYaml } from "yaml";
import { mergeProjectConfigYaml, UnmergeableConfigError } from "./config-merge";

const mergedYaml = (existing: string | null, fresh: string): string =>
  mergeProjectConfigYaml(existing, fresh).merged;

const TASKS_BACKEND_MINSKY = "  backend: minsky";

const FRESH = ["tasks:", TASKS_BACKEND_MINSKY, "persistence:", "  backend: postgres"].join("\n");

const EXISTING_WITH_USER_KEYS = [
  "tasks:",
  "  backend: github-issues",
  "rules:",
  "  presets: []",
  "  enabled: []",
  "  disabled:",
  "    - minsky-workflow",
  "someUnrelatedKey: preserve-me",
].join("\n");

function parsed(yaml: string): Record<string, unknown> {
  return parseYaml(yaml) as Record<string, unknown>;
}

function mergedParsed(existing: string | null, fresh: string): Record<string, unknown> {
  return parsed(mergedYaml(existing, fresh));
}

describe("mergeProjectConfigYaml (mt#4866 SC2)", () => {
  it("preserves a `rules:` block init does not emit", () => {
    const merged = mergedParsed(EXISTING_WITH_USER_KEYS, FRESH);
    expect(merged.rules).toEqual({
      presets: [],
      enabled: [],
      disabled: ["minsky-workflow"],
    });
  });

  // The general form. The originating incident lost an unrelated key too, so a
  // fix that only rescued `rules:` would have been a partial one.
  it("preserves an arbitrary unrelated top-level key", () => {
    const merged = mergedParsed(EXISTING_WITH_USER_KEYS, FRESH);
    expect(merged.someUnrelatedKey).toBe("preserve-me");
  });

  it("refreshes the keys init does emit", () => {
    const merged = mergedParsed(EXISTING_WITH_USER_KEYS, FRESH);
    // `tasks.backend` was github-issues in the existing file and minsky in the
    // fresh one: the vendor's value wins.
    expect(merged.tasks).toEqual({ backend: "minsky" });
    expect(merged.persistence).toEqual({ backend: "postgres" });
  });

  // Not a deep merge, deliberately. mt#4699 STOPPED emitting `tasks.strictIds`
  // and the `mcp:` block; a deep merge would resurrect them from an old config
  // forever, which is the opposite of what that task shipped.
  it("replaces an emitted section wholesale rather than deep-merging it", () => {
    const stale = ["tasks:", TASKS_BACKEND_MINSKY, "  strictIds: false"].join("\n");
    const merged = mergedParsed(stale, FRESH);
    expect(merged.tasks).toEqual({ backend: "minsky" });
    expect((merged.tasks as Record<string, unknown>).strictIds).toBeUndefined();
  });

  // `repository` and `project` are emitted only when derivable. A re-init in a
  // directory whose git remote has gone away must not silently drop them.
  it("preserves a conditionally-emitted key when this run does not produce it", () => {
    const existing = ["tasks:", TASKS_BACKEND_MINSKY, "repository:", "  backend: local"].join("\n");
    const merged = mergedParsed(existing, FRESH);
    expect(merged.repository).toEqual({ backend: "local" });
  });

  it("returns the fresh content unchanged when there is no existing file", () => {
    expect(mergedYaml(null, FRESH)).toBe(FRESH);
  });

  // PR #3623 R1. The first implementation returned the fresh content here, which
  // silently destroyed every key in the unparseable file — the exact data loss
  // SC2 exists to stop, on the path where it is least visible (a --overwrite in
  // CI, where the warning goes nowhere and the command still reports success).
  // SC2 requires every unowned key to survive; when the file cannot be parsed
  // there is no way to honour that, so refusing is the only faithful outcome.
  it("REFUSES to merge when the existing file is unparseable, rather than replacing it", () => {
    expect(() => mergeProjectConfigYaml("{{ not: valid: yaml: [", FRESH)).toThrow(
      UnmergeableConfigError
    );
  });

  it("the refusal names the config path so the user knows what to repair", () => {
    expect(() => mergeProjectConfigYaml("{{ bad: [", FRESH, ".minsky/config.yaml")).toThrow(
      ".minsky/config.yaml"
    );
  });

  // The discriminating pair for the rule above: a file that PARSES but holds no
  // mapping has nothing to lose, so it must NOT throw. Refusing here would block
  // a legitimate re-init over an empty config.
  it("does not refuse for a parseable file with no top-level keys", () => {
    expect(() => mergeProjectConfigYaml("", FRESH)).not.toThrow();
    expect(() => mergeProjectConfigYaml("- a\n- b\n", FRESH)).not.toThrow();
  });

  it("falls back to the fresh content when the existing file is empty or not a mapping", () => {
    expect(mergedYaml("", FRESH)).toBe(FRESH);
    expect(mergedYaml("- a\n- b\n", FRESH)).toBe(FRESH);
    expect(mergedYaml("just-a-scalar\n", FRESH)).toBe(FRESH);
  });

  it("is idempotent — merging its own output changes nothing", () => {
    const once = mergedYaml(EXISTING_WITH_USER_KEYS, FRESH);
    const twice = mergedYaml(once, FRESH);
    expect(parsed(twice)).toEqual(parsed(once));
  });
});

describe("preservedKeys (mt#4866 SC2)", () => {
  it("names exactly the keys carried over from the existing file", () => {
    expect(mergeProjectConfigYaml(EXISTING_WITH_USER_KEYS, FRESH).preservedKeys.sort()).toEqual([
      "rules",
      "someUnrelatedKey",
    ]);
  });

  it("is empty when the existing file has nothing the fresh one lacks", () => {
    expect(mergeProjectConfigYaml(FRESH, FRESH).preservedKeys).toEqual([]);
  });

  it("is empty when there is no existing file", () => {
    expect(mergeProjectConfigYaml(null, FRESH).preservedKeys).toEqual([]);
  });
});
