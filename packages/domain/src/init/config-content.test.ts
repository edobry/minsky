/**
 * Tests for getMinskyConfigContentYaml slug stamping (mt#2414 — Phase 1.1).
 *
 * Verifies that `minsky init` writes a project slug into .minsky/config.yaml
 * and that the slug round-trips through resolveProjectIdentity.
 */

import { describe, test, expect } from "bun:test";
import { parse as yamlParse } from "yaml";
import { getMinskyConfigContentYaml } from "./config-content";
import { resolveProjectIdentity, type ProjectIdentityDeps } from "../project/identity";

// ─────────────────────────────────────────────────────────────────────────────
// getMinskyConfigContentYaml — slug stamping
// ─────────────────────────────────────────────────────────────────────────────

describe("getMinskyConfigContentYaml — project slug stamping", () => {
  test("stamps project.slug when projectSlug is provided explicitly", () => {
    const yaml = getMinskyConfigContentYaml("minsky", undefined, {
      projectSlug: "org/my-repo",
    });
    const parsed = yamlParse(yaml) as Record<string, unknown>;
    expect(parsed.project).toBeDefined();
    const project = parsed.project as Record<string, unknown>;
    expect(project.slug).toBe("org/my-repo");
  });

  test("does not stamp project.slug when no slug options provided", () => {
    const yaml = getMinskyConfigContentYaml("minsky");
    const parsed = yamlParse(yaml) as Record<string, unknown>;
    expect(parsed.project).toBeUndefined();
  });

  test("does not stamp project.slug when repoPath has no git remote", () => {
    // /tmp has no git remote — slug auto-derivation returns null
    const yaml = getMinskyConfigContentYaml("minsky", undefined, {
      repoPath: "/tmp",
    });
    const parsed = yamlParse(yaml) as Record<string, unknown>;
    expect(parsed.project).toBeUndefined();
  });

  test("explicit projectSlug takes precedence over repoPath auto-derivation", () => {
    const yaml = getMinskyConfigContentYaml("minsky", undefined, {
      projectSlug: "explicit-org/explicit-repo",
      repoPath: "/tmp", // would return null from git remote
    });
    const parsed = yamlParse(yaml) as Record<string, unknown>;
    const project = parsed.project as Record<string, unknown>;
    expect(project.slug).toBe("explicit-org/explicit-repo");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip: stamp via getMinskyConfigContentYaml, resolve via
// resolveProjectIdentity using readConfigSlug
// ─────────────────────────────────────────────────────────────────────────────

describe("project slug round-trip (init → resolve)", () => {
  test("slug written by getMinskyConfigContentYaml is returned by resolveProjectIdentity", () => {
    // Step 1: generate config content as minsky init would
    const slug = "edobry/minsky";
    const configYaml = getMinskyConfigContentYaml("minsky", undefined, {
      projectSlug: slug,
    });

    // Step 2: resolve using a deps shim that serves the generated YAML
    const deps: ProjectIdentityDeps = {
      execSync: () => "",
      existsSync: () => true,
      readFileSync: () => configYaml,
      getEnvVar: () => undefined,
    };

    const result = resolveProjectIdentity({ repoPath: "/any/path" }, deps);
    expect(result).toEqual({ kind: "resolved", slug, source: "config-slug" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mt#4699 — keys the generated project config must NOT contain
// ─────────────────────────────────────────────────────────────────────────────

describe("getMinskyConfigContentYaml — keys deliberately not emitted (mt#4699)", () => {
  test("does not emit tasks.strictIds — the flag has no production consumer", () => {
    const parsed = yamlParse(getMinskyConfigContentYaml("minsky")) as Record<string, unknown>;
    const tasks = parsed.tasks as Record<string, unknown>;
    // The section itself must survive — only the dead key goes.
    expect(tasks).toBeDefined();
    expect(tasks.backend).toBe("minsky");
    expect("strictIds" in tasks).toBe(false);
  });

  test("does not emit an mcp section — transport/port/host are machine scope", () => {
    const parsed = yamlParse(getMinskyConfigContentYaml("minsky")) as Record<string, unknown>;
    expect(parsed.mcp).toBeUndefined();
  });

  test("still emits the sections that ARE project scope", () => {
    // Guards against a regression that removes too much: this test fails if the
    // edit above deletes a neighbouring key rather than the two intended ones.
    const parsed = yamlParse(getMinskyConfigContentYaml("minsky")) as Record<string, unknown>;
    expect((parsed.persistence as Record<string, unknown>).backend).toBe("postgres");
    expect((parsed.logger as Record<string, unknown>).mode).toBe("auto");
  });
});
