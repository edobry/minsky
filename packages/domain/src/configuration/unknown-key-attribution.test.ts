/**
 * Tests for unrecognized-top-level-key attribution (mt#5033).
 *
 * The defect these cover: the warning used to prescribe "fix the key name in
 * your config file" for every unrecognized key, including keys that no file
 * contains because an unregistered `MINSKY_*` environment variable manufactured
 * them. AT1 and AT2 in mt#5033's spec are the first two tests below.
 *
 * No logger is patched anywhere here — the formatter is pure and the loader
 * logs what it returns, which is the seam that makes this testable.
 */

import { describe, test, expect } from "bun:test";
import {
  attributeUnknownTopLevelKey,
  formatUnknownTopLevelKeyWarning,
  type AttributableSourceResult,
} from "./unknown-key-attribution";

/** The environment source's real result shape, as `getEnvironmentConfiguration` returns it. */
function envSource(
  config: Record<string, unknown>,
  mappings: Record<string, string>
): AttributableSourceResult {
  return {
    source: { name: "environment" },
    config,
    metadata: { loadedVariables: Object.keys(mappings), mappings },
    success: true,
  };
}

/** A file-backed source's real result shape (`getProjectConfiguration` / `getUserConfiguration`). */
function fileSource(
  name: string,
  config: Record<string, unknown>,
  configFile: string | null
): AttributableSourceResult {
  return {
    source: { name },
    config,
    metadata: { configFile, searchedPaths: configFile ? [configFile] : [] },
    success: true,
  };
}

/** A representative project-config path, shared so the assertions cannot drift apart. */
const PROJECT_CONFIG = "/repo/.minsky/config.yaml";

/** Render in one step, the way the loader does. */
function warn(key: string, sources: AttributableSourceResult[]): string {
  return formatUnknownTopLevelKeyWarning(key, attributeUnknownTopLevelKey(key, sources));
}

describe("mt#5033 AT1 — an env-var-sourced key names the variable, not a config file", () => {
  const sources = [
    fileSource("project", { tasks: { backend: "minsky" } }, PROJECT_CONFIG),
    envSource(
      { config: { dir: "/tmp/fakehome/.config/minsky" } },
      {
        MINSKY_CONFIG_DIR: "config.dir",
      }
    ),
  ];

  test("names the environment variable that produced the key", () => {
    expect(warn("config", sources)).toContain("MINSKY_CONFIG_DIR");
  });

  test("does not tell the operator to edit a config file", () => {
    expect(warn("config", sources)).not.toContain("in your config file");
  });

  test("does not blame the project config file, which does not carry the key", () => {
    expect(warn("config", sources)).not.toContain(PROJECT_CONFIG);
  });

  test("explains the MINSKY_* auto-mapping that caused it", () => {
    expect(warn("config", sources)).toContain("MINSKY_*");
  });
});

describe("mt#5033 AT2 — a file-sourced key names the file", () => {
  const sources = [fileSource("project", { persistance: { backend: "postgres" } }, PROJECT_CONFIG)];

  test("names the file path the key was loaded from", () => {
    expect(warn("persistance", sources)).toContain(PROJECT_CONFIG);
  });

  test("keeps the newer-version hint, which is a real cause for a file key", () => {
    expect(warn("persistance", sources)).toContain("update your installation");
  });
});

describe("attributeUnknownTopLevelKey", () => {
  test("attributes only sources whose own config carries the key", () => {
    const origins = attributeUnknownTopLevelKey("config", [
      fileSource("project", { tasks: {} }, PROJECT_CONFIG),
      envSource({ config: { dir: "/x" } }, { MINSKY_CONFIG_DIR: "config.dir" }),
    ]);
    expect(origins).toHaveLength(1);
    expect(origins[0]?.sourceName).toBe("environment");
  });

  test("ignores a source that failed to load", () => {
    const failed: AttributableSourceResult = {
      source: { name: "user" },
      config: { config: {} },
      metadata: { configFile: "/home/u/.config/minsky/config.yaml" },
      success: false,
    };
    expect(attributeUnknownTopLevelKey("config", [failed])).toHaveLength(0);
  });

  test("reports every contributing source when a key comes from two", () => {
    const origins = attributeUnknownTopLevelKey("config", [
      fileSource("project", { config: { a: 1 } }, PROJECT_CONFIG),
      envSource({ config: { dir: "/x" } }, { MINSKY_CONFIG_DIR: "config.dir" }),
    ]);
    expect(origins.map((o) => o.kind)).toEqual(["file", "environment"]);
  });

  test("matches a bare top-level env mapping with no dot", () => {
    const origins = attributeUnknownTopLevelKey("skip", [
      envSource({ skip: "1" }, { MINSKY_SKIP: "skip" }),
    ]);
    expect(origins[0]).toMatchObject({ kind: "environment", envVars: ["MINSKY_SKIP"] });
  });

  test("does not match an env mapping whose top-level segment merely shares a prefix", () => {
    const origins = attributeUnknownTopLevelKey("config", [
      envSource({ config: {} }, { MINSKY_CONFIGURATION_DIR: "configuration.dir" }),
    ]);
    expect(origins[0]).toMatchObject({ kind: "unattributed" });
  });

  test("sorts the env vars so the message is stable across runs", () => {
    const origins = attributeUnknownTopLevelKey("config", [
      envSource(
        { config: {} },
        { MINSKY_CONFIG_ZONE: "config.zone", MINSKY_CONFIG_DIR: "config.dir" }
      ),
    ]);
    expect(origins[0]).toMatchObject({ envVars: ["MINSKY_CONFIG_DIR", "MINSKY_CONFIG_ZONE"] });
  });

  test("falls back to the source name when metadata attributes nothing", () => {
    const origins = attributeUnknownTopLevelKey("config", [
      { source: { name: "defaults" }, config: { config: {} }, metadata: {}, success: true },
    ]);
    expect(origins[0]).toEqual({ kind: "unattributed", sourceName: "defaults" });
  });

  test("does not attribute an inherited prototype member as a contributed key", () => {
    const inherited = Object.create({ config: { dir: "/x" } }) as Record<string, unknown>;
    expect(
      attributeUnknownTopLevelKey("config", [
        { source: { name: "project" }, config: inherited, metadata: {}, success: true },
      ])
    ).toHaveLength(0);
  });

  test("treats a null configFile as unattributed rather than naming it", () => {
    const origins = attributeUnknownTopLevelKey("config", [
      fileSource("user", { config: {} }, null),
    ]);
    expect(origins[0]).toEqual({ kind: "unattributed", sourceName: "user" });
  });
});

describe("formatUnknownTopLevelKeyWarning", () => {
  test("always names the key and says it is ignored", () => {
    const message = warn("config", []);
    expect(message).toContain("Unrecognized top-level config key: config");
    expect(message).toContain("will be ignored");
  });

  test("with no attributable origin, offers both causes rather than guessing one", () => {
    const message = formatUnknownTopLevelKeyWarning("config", []);
    expect(message).toContain("could not be determined");
    expect(message).toContain("MINSKY_*");
    expect(message).toContain("config file");
  });

  test("uses singular phrasing for one variable and plural for several", () => {
    const one = warn("config", [envSource({ config: {} }, { MINSKY_CONFIG_DIR: "config.dir" })]);
    expect(one).toContain("environment variable MINSKY_CONFIG_DIR");

    const many = warn("config", [
      envSource(
        { config: {} },
        { MINSKY_CONFIG_DIR: "config.dir", MINSKY_CONFIG_ZONE: "config.zone" }
      ),
    ]);
    expect(many).toContain("environment variables MINSKY_CONFIG_DIR, MINSKY_CONFIG_ZONE");
  });
});
