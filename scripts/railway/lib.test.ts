import { describe, test, expect } from "bun:test";
import {
  secret,
  isSecretRef,
  defineRailwayConfig,
  resolveSecret,
  defaultSecretsFilePath,
  computeDiff,
  buildVariablePatches,
  buildAllSecretPatches,
  buildJsonPatch,
  buildDeletePatch,
  formatDiffOutput,
  summarizeDiff,
  assertHttpOk,
  type SecretsFileReader,
  type CurrentVar,
  type VariableValue,
  type DiffEntry,
} from "./lib";

// Shared constants to satisfy no-magic-string-duplication rule
const SECRETS_FILE_PATH = "/mock/railway-secrets.json";
const SECRETS_FILE_ENV_VAR = "MINSKY_RAILWAY_SECRETS_FILE";
const KIND_CHANGE_SEALED_FLAG = "CHANGE-SEALED-FLAG";
const KIND_CHANGE_VALUE = "CHANGE-VALUE";
const ENV_KEY_REDACTION = "REDACTION_TEST_SECRET";
const ENV_KEY_RESEAL_A = "RE_SEAL_SECRET_A";
const ENV_KEY_RESEAL_B = "RE_SEAL_SECRET_B";
const ENV_KEY_RESEAL_C = "RE_SEAL_SECRET_C";

/** In-memory secrets file reader — avoids real fs in tests. */
function makeFileReader(files: Record<string, string>): SecretsFileReader {
  return {
    exists: (path) => path in files,
    read: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`mock file not found: ${path}`);
      return content;
    },
  };
}

describe("secret()", () => {
  test("returns a SecretRef sentinel", () => {
    const ref = secret("MY_VAR");
    expect(isSecretRef(ref)).toBe(true);
    expect(ref.envVarName).toBe("MY_VAR");
  });

  test("isSecretRef returns false for plain strings", () => {
    expect(isSecretRef("plain")).toBe(false);
    expect(isSecretRef(null)).toBe(false);
    expect(isSecretRef(42)).toBe(false);
  });
});

describe("defineRailwayConfig()", () => {
  test("returns the config unchanged", () => {
    const config = defineRailwayConfig({
      projectId: "proj-1",
      environmentId: "env-1",
      serviceId: "svc-1",
      variables: { FOO: "bar" },
    });
    expect(config.projectId).toBe("proj-1");
    expect(config.variables["FOO"]).toBe("bar");
  });
});

describe("resolveSecret()", () => {
  test("resolves from process.env (env var takes priority)", () => {
    process.env["TEST_SECRET_VAR_XYZ"] = "env-value";
    const reader = makeFileReader({
      [SECRETS_FILE_PATH]: JSON.stringify({ TEST_SECRET_VAR_XYZ: "file-value" }),
    });
    // Even with file present, env var wins
    const result = resolveSecret("TEST_SECRET_VAR_XYZ", reader);
    expect(result).toBe("env-value");
    delete process.env["TEST_SECRET_VAR_XYZ"];
  });

  test("resolves from secrets file when env var not set", () => {
    delete process.env["TEST_SECRET_VAR_XYZ"];
    const reader = makeFileReader({
      [SECRETS_FILE_PATH]: JSON.stringify({ TEST_SECRET_VAR_XYZ: "file-value" }),
    });
    process.env[SECRETS_FILE_ENV_VAR] = SECRETS_FILE_PATH;
    const result = resolveSecret("TEST_SECRET_VAR_XYZ", reader);
    expect(result).toBe("file-value");
    delete process.env[SECRETS_FILE_ENV_VAR];
  });

  test("throws with missing var name when neither source resolves", () => {
    delete process.env["TEST_SECRET_VAR_XYZ"];
    const reader = makeFileReader({});
    process.env[SECRETS_FILE_ENV_VAR] = SECRETS_FILE_PATH;
    expect(() => resolveSecret("TEST_SECRET_VAR_XYZ", reader)).toThrow("TEST_SECRET_VAR_XYZ");
    delete process.env[SECRETS_FILE_ENV_VAR];
  });
});

describe("computeDiff()", () => {
  const makeCurrentVar = (value: string, isSealed?: boolean): CurrentVar => ({ value, isSealed });
  const emptyReader = makeFileReader({});

  test("classifies new variables as ADD", () => {
    const desired: Record<string, VariableValue> = { NEW_VAR: "hello" };
    const current: Record<string, CurrentVar> = {};
    const diff = computeDiff(desired, current, emptyReader);
    expect(diff).toHaveLength(1);
    expect(diff[0]?.kind).toBe("ADD");
    expect(diff[0]?.key).toBe("NEW_VAR");
  });

  test("classifies missing variables as REMOVE", () => {
    const desired: Record<string, VariableValue> = {};
    const current: Record<string, CurrentVar> = { OLD_VAR: makeCurrentVar("old") };
    const diff = computeDiff(desired, current, emptyReader);
    expect(diff).toHaveLength(1);
    expect(diff[0]?.kind).toBe("REMOVE");
    expect(diff[0]?.key).toBe("OLD_VAR");
  });

  test("classifies matching variables as NO-CHANGE", () => {
    const desired: Record<string, VariableValue> = { MY_VAR: "same" };
    const current: Record<string, CurrentVar> = { MY_VAR: makeCurrentVar("same", false) };
    const diff = computeDiff(desired, current, emptyReader);
    expect(diff).toHaveLength(1);
    expect(diff[0]?.kind).toBe("NO-CHANGE");
  });

  test("classifies value-changed variables as CHANGE-VALUE", () => {
    const desired: Record<string, VariableValue> = { MY_VAR: "new-value" };
    const current: Record<string, CurrentVar> = { MY_VAR: makeCurrentVar("old-value", false) };
    const diff = computeDiff(desired, current, emptyReader);
    expect(diff).toHaveLength(1);
    expect(diff[0]?.kind).toBe(KIND_CHANGE_VALUE);
    if (diff[0]?.kind === KIND_CHANGE_VALUE) {
      expect(diff[0].patch.value).toBe("new-value");
      expect(diff[0].patch.isSealed).toBe(false);
    }
  });

  test("classifies sealed-flag-only changes as CHANGE-SEALED-FLAG", () => {
    process.env["SEALED_TEST_VAR"] = "same-value";
    const desired: Record<string, VariableValue> = { SEALED_TEST_VAR: secret("SEALED_TEST_VAR") };
    const current: Record<string, CurrentVar> = {
      SEALED_TEST_VAR: makeCurrentVar("same-value", false),
    };
    const diff = computeDiff(desired, current, emptyReader);
    expect(diff[0]?.kind).toBe(KIND_CHANGE_SEALED_FLAG);
    if (diff[0]?.kind === KIND_CHANGE_SEALED_FLAG) {
      expect(diff[0].patch.isSealed).toBe(true);
    }
    delete process.env["SEALED_TEST_VAR"];
  });

  test("classifies sealed current + SecretRef desired as NO-CHANGE without resolving the secret", () => {
    // Regression test for R3 BLOCKING #1: computeDiff must not call resolveSecret
    // when current[key].isSealed === true and desired[key] is a SecretRef.
    // The env var is deliberately absent and the secrets file reader returns null,
    // so any attempt to resolve would throw — proving the short-circuit fires.
    const missingEnvVar = "SEALED_NO_CHANGE_SECRET_ABSENT";
    delete process.env[missingEnvVar];
    const nullReader: SecretsFileReader = { exists: () => false, read: () => "" };

    const desired: Record<string, VariableValue> = { MY_SECRET: secret(missingEnvVar) };
    const current: Record<string, CurrentVar> = {
      MY_SECRET: makeCurrentVar("irrelevant-sealed-value", true),
    };

    // Must not throw even though the secret cannot be resolved locally
    const diff = computeDiff(desired, current, nullReader);
    expect(diff).toHaveLength(1);
    expect(diff[0]?.kind).toBe("NO-CHANGE");
    expect(diff[0]?.key).toBe("MY_SECRET");
  });

  test("handles multiple vars with mixed classifications", () => {
    process.env["SECRET_A"] = "secret-a-value";
    const desired: Record<string, VariableValue> = {
      KEEP: "same",
      CHANGE: "new",
      ADD: "brand-new",
      SECRET_A: secret("SECRET_A"),
    };
    const current: Record<string, CurrentVar> = {
      KEEP: makeCurrentVar("same", false),
      CHANGE: makeCurrentVar("old", false),
      REMOVE: makeCurrentVar("goodbye", false),
      SECRET_A: makeCurrentVar("secret-a-value", true),
    };
    const diff = computeDiff(desired, current, emptyReader);
    const summary = summarizeDiff(diff);

    expect(summary.noChange).toHaveLength(2);
    expect(summary.toChangeValue).toHaveLength(1);
    expect(summary.toChangeValue[0]?.key).toBe("CHANGE");
    expect(summary.toAdd).toHaveLength(1);
    expect(summary.toAdd[0]?.key).toBe("ADD");
    expect(summary.toRemove).toHaveLength(1);
    expect(summary.toRemove[0]?.key).toBe("REMOVE");

    delete process.env["SECRET_A"];
  });
});

describe("buildVariablePatches()", () => {
  test("includes ADD, CHANGE-VALUE, CHANGE-SEALED-FLAG entries", () => {
    const diff: DiffEntry[] = [
      { kind: "ADD", key: "A", patch: { value: "a", isSealed: false } },
      { kind: "REMOVE", key: "B" },
      { kind: KIND_CHANGE_VALUE, key: "C", patch: { value: "c", isSealed: false } },
      { kind: KIND_CHANGE_SEALED_FLAG, key: "D", patch: { value: "d", isSealed: true } },
      { kind: "NO-CHANGE", key: "E" },
    ];
    const patches = buildVariablePatches(diff);
    expect(Object.keys(patches)).toEqual(["A", "C", "D"]);
    expect(patches["A"]).toEqual({ value: "a", isSealed: false });
    expect(patches["C"]).toEqual({ value: "c", isSealed: false });
    expect(patches["D"]).toEqual({ value: "d", isSealed: true });
  });
});

describe("buildJsonPatch()", () => {
  test("constructs the correct patch shape", () => {
    const patches = {
      FOO: { value: "bar", isSealed: false },
      SECRET: { value: "s3cr3t", isSealed: true },
    };
    const result = buildJsonPatch("svc-123", patches);
    expect(result).toEqual({
      services: {
        "svc-123": {
          variables: {
            FOO: { value: "bar", isSealed: false },
            SECRET: { value: "s3cr3t", isSealed: true },
          },
        },
      },
    });
  });
});

describe("buildDeletePatch()", () => {
  test("empty key array produces variables object with no keys", () => {
    const result = buildDeletePatch("svc-123", []);
    expect(result).toEqual({
      services: {
        "svc-123": {
          variables: {},
        },
      },
    });
  });

  test("single key produces correct deletion shape with null value", () => {
    const result = buildDeletePatch("svc-456", ["OLD_VAR"]);
    expect(result).toEqual({
      services: {
        "svc-456": {
          variables: {
            OLD_VAR: null,
          },
        },
      },
    });
  });

  test("multiple keys all map to null", () => {
    const result = buildDeletePatch("svc-789", ["KEY_A", "KEY_B", "KEY_C"]);
    expect(result).toEqual({
      services: {
        "svc-789": {
          variables: {
            KEY_A: null,
            KEY_B: null,
            KEY_C: null,
          },
        },
      },
    });
  });

  test("outer envelope shape matches buildJsonPatch (services.[id].variables)", () => {
    const deleteResult = buildDeletePatch("my-svc", ["X"]);
    const patchResult = buildJsonPatch("my-svc", { Y: { value: "v", isSealed: false } });
    // Both must have the same outer shape: { services: { "my-svc": { variables: { ... } } } }
    expect(Object.keys(deleteResult)).toEqual(["services"]);
    expect(Object.keys(patchResult)).toEqual(["services"]);
    const deleteSvc = (deleteResult as { services: Record<string, unknown> }).services["my-svc"];
    const patchSvc = (patchResult as { services: Record<string, unknown> }).services["my-svc"];
    expect(Object.keys(deleteSvc as object)).toEqual(["variables"]);
    expect(Object.keys(patchSvc as object)).toEqual(["variables"]);
  });
});

describe("assertHttpOk()", () => {
  test("does not throw for 2xx status codes", () => {
    expect(() => assertHttpOk(200, "OK", "")).not.toThrow();
    expect(() => assertHttpOk(201, "Created", "")).not.toThrow();
    expect(() => assertHttpOk(204, "No Content", "")).not.toThrow();
    expect(() => assertHttpOk(299, "Whatever", "")).not.toThrow();
  });

  test("throws for 4xx status with status and body in message", () => {
    expect(() => assertHttpOk(401, "Unauthorized", "invalid token")).toThrow(
      "HTTP 401 Unauthorized"
    );
    expect(() => assertHttpOk(401, "Unauthorized", "invalid token")).toThrow("invalid token");
  });

  test("throws for 5xx status with actionable message", () => {
    expect(() => assertHttpOk(500, "Internal Server Error", "server down")).toThrow(
      "HTTP 500 Internal Server Error"
    );
    expect(() => assertHttpOk(500, "Internal Server Error", "server down")).toThrow(
      "Check your Railway token"
    );
  });

  test("truncates long body text to 500 chars", () => {
    const longBody = "x".repeat(600);
    let caught: Error | undefined;
    try {
      assertHttpOk(503, "Service Unavailable", longBody);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught).toBeDefined();
    const bodySlice = "x".repeat(500);
    expect(caught?.message).toContain(bodySlice);
    expect(caught?.message).not.toContain("x".repeat(501));
  });

  test("throws for 1xx and 3xx (non-2xx) status codes", () => {
    expect(() => assertHttpOk(301, "Moved Permanently", "redirect")).toThrow("HTTP 301");
    expect(() => assertHttpOk(100, "Continue", "")).toThrow("HTTP 100");
  });
});

describe("buildAllSecretPatches()", () => {
  test("returns patches only for NO-CHANGE SecretRef variables", () => {
    process.env[ENV_KEY_RESEAL_A] = "val-a";
    process.env[ENV_KEY_RESEAL_B] = "val-b";

    const config = {
      variables: {
        SECRET_A: secret(ENV_KEY_RESEAL_A),
        SECRET_B: secret(ENV_KEY_RESEAL_B),
        PLAIN: "plain-value",
      },
    };
    const diff: DiffEntry[] = [
      { kind: "NO-CHANGE", key: "SECRET_A" },
      { kind: "NO-CHANGE", key: "SECRET_B" },
      { kind: "NO-CHANGE", key: "PLAIN" },
    ];
    const emptyReader: SecretsFileReader = { exists: () => false, read: () => "" };
    const patches = buildAllSecretPatches(config, diff, emptyReader);

    expect(Object.keys(patches)).toEqual(["SECRET_A", "SECRET_B"]);
    expect(patches["SECRET_A"]).toEqual({ value: "val-a", isSealed: true });
    expect(patches["SECRET_B"]).toEqual({ value: "val-b", isSealed: true });
    expect(patches["PLAIN"]).toBeUndefined();

    delete process.env[ENV_KEY_RESEAL_A];
    delete process.env[ENV_KEY_RESEAL_B];
  });

  test("returns empty object when no NO-CHANGE entries exist", () => {
    const config = { variables: { SECRET: secret("SOME_ENV") } };
    const diff: DiffEntry[] = [
      { kind: "ADD", key: "SECRET", patch: { value: "v", isSealed: true } },
    ];
    const emptyReader: SecretsFileReader = { exists: () => false, read: () => "" };
    const patches = buildAllSecretPatches(config, diff, emptyReader);
    expect(Object.keys(patches)).toHaveLength(0);
  });

  test("skips NO-CHANGE entries that are plain strings (not SecretRef)", () => {
    const config = { variables: { PLAIN: "plain-val" } };
    const diff: DiffEntry[] = [{ kind: "NO-CHANGE", key: "PLAIN" }];
    const emptyReader: SecretsFileReader = { exists: () => false, read: () => "" };
    const patches = buildAllSecretPatches(config, diff, emptyReader);
    expect(Object.keys(patches)).toHaveLength(0);
  });

  test("skips REMOVE and ADD entries, only processes NO-CHANGE", () => {
    process.env[ENV_KEY_RESEAL_C] = "val-c";
    const config = {
      variables: {
        SECRET_C: secret(ENV_KEY_RESEAL_C),
        ADDED: secret("SOME_ADD_ENV"),
      },
    };
    process.env["SOME_ADD_ENV"] = "add-val";
    const diff: DiffEntry[] = [
      { kind: "NO-CHANGE", key: "SECRET_C" },
      { kind: "ADD", key: "ADDED", patch: { value: "add-val", isSealed: true } },
      { kind: "REMOVE", key: "OLD_KEY" },
    ];
    const emptyReader: SecretsFileReader = { exists: () => false, read: () => "" };
    const patches = buildAllSecretPatches(config, diff, emptyReader);
    expect(Object.keys(patches)).toEqual(["SECRET_C"]);

    delete process.env[ENV_KEY_RESEAL_C];
    delete process.env["SOME_ADD_ENV"];
  });
});

describe("computeDiff() — REMOVE classification", () => {
  const makeCurrentVar = (value: string, isSealed?: boolean): CurrentVar => ({ value, isSealed });
  const emptyReader: SecretsFileReader = { exists: () => false, read: () => "" };

  test("classifies vars present in current but absent in desired as REMOVE", () => {
    const desired: Record<string, VariableValue> = { KEEP: "keep-val" };
    const current: Record<string, CurrentVar> = {
      KEEP: makeCurrentVar("keep-val"),
      EXTRA: makeCurrentVar("extra-val"),
      TEST_VAR: makeCurrentVar("x"),
    };
    const diff = computeDiff(desired, current, emptyReader);
    const summary = summarizeDiff(diff);
    expect(summary.toRemove).toHaveLength(2);
    const removedKeys = summary.toRemove.map((e) => e.key).sort();
    expect(removedKeys).toEqual(["EXTRA", "TEST_VAR"]);
    expect(summary.noChange).toHaveLength(1);
  });
});

describe("formatDiffOutput() — secret redaction", () => {
  test("never prints resolved secret values", () => {
    const secretValue = "super-secret-do-not-log";
    process.env[ENV_KEY_REDACTION] = secretValue;

    const desired: Record<string, VariableValue> = {
      [ENV_KEY_REDACTION]: secret(ENV_KEY_REDACTION),
      PLAIN: "visible",
    };
    const diff: DiffEntry[] = [
      { kind: "ADD", key: ENV_KEY_REDACTION, patch: { value: secretValue, isSealed: true } },
      { kind: "ADD", key: "PLAIN", patch: { value: "visible", isSealed: false } },
    ];

    const output = formatDiffOutput(diff, desired);
    expect(output).not.toContain(secretValue);
    expect(output).toContain("(sealed)");
    expect(output).toContain("PLAIN = visible");

    delete process.env[ENV_KEY_REDACTION];
  });

  test("shows (sealed) for CHANGE-VALUE with secret ref", () => {
    const secretValue = "another-secret-12345";
    process.env["ANOTHER_SECRET"] = secretValue;

    const desired: Record<string, VariableValue> = {
      ANOTHER_SECRET: secret("ANOTHER_SECRET"),
    };
    const diff: DiffEntry[] = [
      {
        kind: KIND_CHANGE_VALUE,
        key: "ANOTHER_SECRET",
        patch: { value: secretValue, isSealed: true },
      },
    ];

    const output = formatDiffOutput(diff, desired);
    expect(output).not.toContain(secretValue);
    expect(output).toContain("(sealed)");

    delete process.env["ANOTHER_SECRET"];
  });

  test("shows plain value for non-secret ADD", () => {
    const desired: Record<string, VariableValue> = { PLAIN_VAR: "1000" };
    const diff: DiffEntry[] = [
      { kind: "ADD", key: "PLAIN_VAR", patch: { value: "1000", isSealed: false } },
    ];
    const output = formatDiffOutput(diff, desired);
    expect(output).toContain("PLAIN_VAR = 1000");
  });

  test("returns 'No changes.' when diff is empty or all NO-CHANGE", () => {
    const desired: Record<string, VariableValue> = { X: "y" };
    const diff: DiffEntry[] = [{ kind: "NO-CHANGE", key: "X" }];
    const output = formatDiffOutput(diff, desired);
    expect(output).toBe("No changes.");
  });
});

describe("formatDiffOutput() — --prune flag behavior", () => {
  const makeRemoveDiff = (key: string): DiffEntry => ({ kind: "REMOVE", key });

  test("without prune: REMOVE entries shown as WOULD-PRUNE (skipped)", () => {
    const desired: Record<string, VariableValue> = {};
    const diff: DiffEntry[] = [makeRemoveDiff("STALE_VAR")];
    const output = formatDiffOutput(diff, desired, false);
    expect(output).toContain("WOULD-PRUNE");
    expect(output).toContain("STALE_VAR");
    expect(output).toContain("--prune");
    expect(output).not.toContain("- REMOVE");
  });

  test("with prune: REMOVE entries shown as REMOVE", () => {
    const desired: Record<string, VariableValue> = {};
    const diff: DiffEntry[] = [makeRemoveDiff("STALE_VAR")];
    const output = formatDiffOutput(diff, desired, true);
    expect(output).toContain("- REMOVE");
    expect(output).toContain("STALE_VAR");
    expect(output).not.toContain("WOULD-PRUNE");
  });

  test("without prune: only REMOVE entries → does not return No changes.", () => {
    const desired: Record<string, VariableValue> = {};
    const diff: DiffEntry[] = [makeRemoveDiff("OUT_OF_BAND_VAR")];
    const output = formatDiffOutput(diff, desired, false);
    expect(output).not.toBe("No changes.");
    expect(output).toContain("WOULD-PRUNE");
  });

  test("without prune: mix of ADD and REMOVE → shows ADD and WOULD-PRUNE", () => {
    const desired: Record<string, VariableValue> = { NEW_VAR: "val" };
    const diff: DiffEntry[] = [
      { kind: "ADD", key: "NEW_VAR", patch: { value: "val", isSealed: false } },
      makeRemoveDiff("OLD_VAR"),
    ];
    const output = formatDiffOutput(diff, desired, false);
    expect(output).toContain("+ ADD    NEW_VAR");
    expect(output).toContain("WOULD-PRUNE");
    expect(output).toContain("OLD_VAR");
    expect(output).not.toContain("- REMOVE");
  });

  test("prune=false is the default (no third argument)", () => {
    const desired: Record<string, VariableValue> = {};
    const diff: DiffEntry[] = [makeRemoveDiff("DEFAULT_TEST_VAR")];
    const output = formatDiffOutput(diff, desired);
    expect(output).toContain("WOULD-PRUNE");
    expect(output).not.toContain("- REMOVE");
  });
});

describe("resolveSecret() — error message includes actual secretsFilePath", () => {
  test("error message contains default secrets file path when no env override", () => {
    const savedOverride = process.env[SECRETS_FILE_ENV_VAR];
    delete process.env[SECRETS_FILE_ENV_VAR];
    const emptyReader: SecretsFileReader = { exists: () => false, read: () => "" };

    let caught: Error | undefined;
    try {
      resolveSecret("NONEXISTENT_VAR_FOR_PATH_TEST", emptyReader);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught).toBeDefined();
    const expectedPath = defaultSecretsFilePath();
    expect(caught?.message).toContain(expectedPath);
    // Must NOT contain the old hardcoded path if env var is set to something different
    expect(caught?.message).not.toContain("~/.config/minsky/railway-secrets.json");

    if (savedOverride !== undefined) {
      process.env[SECRETS_FILE_ENV_VAR] = savedOverride;
    }
  });

  test("error message contains MINSKY_RAILWAY_SECRETS_FILE override path when set", () => {
    const customPath = "/custom/path/my-secrets.json";
    process.env[SECRETS_FILE_ENV_VAR] = customPath;
    const emptyReader: SecretsFileReader = { exists: () => false, read: () => "" };

    let caught: Error | undefined;
    try {
      resolveSecret("NONEXISTENT_VAR_FOR_OVERRIDE_TEST", emptyReader);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain(customPath);
    // Must not contain any other hardcoded path
    expect(caught?.message).not.toContain("~/.config/minsky");

    delete process.env[SECRETS_FILE_ENV_VAR];
  });
});
