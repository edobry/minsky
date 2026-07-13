import { describe, test, expect } from "bun:test";
import {
  getConfigCustomizations,
  renderConfigGetResult,
  renderConfigSetResult,
  renderConfigUnsetResult,
} from "./config-customizations";

describe("config CLI customizations — pure renderers (mt#1794)", () => {
  describe("renderConfigGetResult", () => {
    test("renders the raw string value when key exists", () => {
      expect(
        renderConfigGetResult({
          success: true,
          exists: true,
          key: "x.y",
          value: "sk-XXX",
          json: false,
        })
      ).toBe("sk-XXX");
    });

    test("renders numbers and booleans as bare strings", () => {
      expect(
        renderConfigGetResult({ success: true, exists: true, key: "a", value: 42, json: false })
      ).toBe("42");
      expect(
        renderConfigGetResult({ success: true, exists: true, key: "b", value: true, json: false })
      ).toBe("true");
    });

    test("renders objects as pretty-JSON", () => {
      const out = renderConfigGetResult({
        success: true,
        exists: true,
        key: "nested",
        value: { foo: "bar", n: 1 },
        json: false,
      });
      expect(JSON.parse(out)).toEqual({ foo: "bar", n: 1 });
    });

    test("emits explicit 'not found' on missing key (never bare success)", () => {
      const out = renderConfigGetResult({
        success: false,
        exists: false,
        key: "missing.key",
        error: "Configuration path 'missing.key' not found",
        json: false,
      });
      expect(out).toBe("Error: Configuration path 'missing.key' not found");
      expect(out).not.toContain("Success");
    });

    test("synthesizes 'Error:' prefix when error field is absent (defensive)", () => {
      // PR #1084 R1: reviewer flagged that the fallback path returned the
      // not-found message without the "Error:" prefix, contradicting the
      // documented UX.
      const out = renderConfigGetResult({
        success: false,
        exists: false,
        key: "missing.key",
        json: false,
      });
      expect(out).toBe("Error: Configuration path 'missing.key' not found");
      expect(out.startsWith("Error:")).toBe(true);
    });

    test("synthesizes 'Error:' prefix when error field is an empty string", () => {
      const out = renderConfigGetResult({
        success: false,
        exists: false,
        key: "x",
        error: "",
        json: false,
      });
      expect(out.startsWith("Error:")).toBe(true);
      expect(out).toContain("not found");
    });

    test("renders nested bigint values via the JSON replacer (no throw)", () => {
      const out = renderConfigGetResult({
        success: true,
        exists: true,
        key: "container",
        value: { count: BigInt("9007199254740993") },
        json: false,
      });
      expect(JSON.parse(out)).toEqual({ count: "9007199254740993" });
    });

    test("emits JSON form when result.json is true", () => {
      const out = renderConfigGetResult({
        success: true,
        exists: true,
        key: "x",
        value: "v",
        json: true,
      });
      expect(JSON.parse(out)).toEqual({
        success: true,
        exists: true,
        key: "x",
        value: "v",
        json: true,
      });
    });
  });

  describe("renderConfigSetResult", () => {
    test("renders 'key = value' on success", () => {
      expect(
        renderConfigSetResult({
          success: true,
          key: "observability.providers.braintrust.apiKey",
          newValue: "sk-XXX",
          json: false,
        })
      ).toBe("observability.providers.braintrust.apiKey = sk-XXX");
    });

    test("renders error on failure (never bare success)", () => {
      expect(
        renderConfigSetResult({ success: false, error: "Validation failed", json: false })
      ).toBe("Error: Validation failed");
    });
  });

  describe("renderConfigUnsetResult", () => {
    test("renders 'unset <key>' on success", () => {
      expect(renderConfigUnsetResult({ success: true, key: "some.key", json: false })).toBe(
        "unset some.key"
      );
    });
  });

  describe("config.set parameter mapping", () => {
    test("marks both key and value as positional arguments", () => {
      const customizations = getConfigCustomizations();
      const setOpts = customizations.options.commandOptions?.["config.set"];
      const params = (setOpts as { parameters?: Record<string, { asArgument?: boolean }> })
        ?.parameters;
      expect(params?.key?.asArgument).toBe(true);
      expect(params?.value?.asArgument).toBe(true);
    });
  });
});
