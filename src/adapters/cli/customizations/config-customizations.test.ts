import { describe, test, expect } from "bun:test";
import {
  getConfigCustomizations,
  renderConfigDoctorResult,
  renderConfigGetResult,
  renderConfigSetResult,
  renderConfigUnsetResult,
  renderConfigValidateResult,
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

describe("config doctor / validate renderers (mt#3478)", () => {
  const CHECK_LOADING = "Configuration Loading";
  const CHECK_DIRECTORY = "Configuration Directory";
  const CHECK_MODELS = "Configured Model Validity";
  const ALL_PASSED = "All checks passed.";

  const doctorResult = (overrides: Record<string, unknown> = {}) => ({
    success: true,
    json: false,
    summary: { total: 3, passed: 2, warnings: 1, errors: 0 },
    diagnostics: [
      { check: CHECK_LOADING, status: "pass", message: "Configuration loaded" },
      {
        check: CHECK_MODELS,
        status: "warning",
        message: "Configured default model not found: anthropic -> 'retired-model-id'",
        suggestion: "Set the provider's model to an id the listing returns",
      },
      { check: CHECK_DIRECTORY, status: "pass", message: "Directory exists" },
    ],
    healthy: true,
    verbose: false,
    ...overrides,
  });

  describe("renderConfigDoctorResult — scoped groups (mt#5154)", () => {
    const scopedResult = (overrides: Record<string, unknown> = {}) => ({
      success: false,
      json: false,
      workspace: "/ws/flotato",
      summary: {
        total: 4,
        passed: 2,
        warnings: 0,
        errors: 2,
        user: { total: 2, passed: 2, warnings: 0, errors: 0 },
        project: { total: 2, passed: 0, warnings: 0, errors: 2 },
      },
      diagnostics: [
        { check: CHECK_LOADING, status: "pass", message: "Configuration loaded", scope: "user" },
        {
          check: CHECK_DIRECTORY,
          status: "pass",
          message: "Directory exists",
          scope: "user",
        },
        {
          check: "Project Harness",
          status: "error",
          message: 'Recorded harness is "cursor" but this call runs under "claude-code"',
          suggestion: "Run `minsky setup --client claude-code` in the project",
          scope: "project",
        },
        {
          check: "Repository Identity",
          status: "error",
          message: 'repository.backend is "local", origin says "github"',
          scope: "project",
        },
      ],
      healthy: false,
      verbose: false,
      ...overrides,
    });

    test("renders a User scope group and a Project scope group naming the workspace", () => {
      const out = renderConfigDoctorResult(scopedResult());
      expect(out).toContain("User scope (this machine): 2 checks, 0 errors, 0 warnings");
      expect(out).toContain("Project scope (/ws/flotato): 2 checks, 2 errors, 0 warnings");
      expect(out.indexOf("User scope")).toBeLessThan(out.indexOf("Project scope"));
    });

    test("a group with nothing to show says all checks passed instead of vanishing", () => {
      const out = renderConfigDoctorResult(scopedResult());
      expect(out).toContain(ALL_PASSED);
      expect(out).toContain("Project Harness");
      expect(out).toContain("Run `minsky setup --client claude-code`");
    });

    test("verbose lists the passing user checks under their group", () => {
      const out = renderConfigDoctorResult(scopedResult({ verbose: true }));
      expect(out).toContain(CHECK_LOADING);
      expect(out).not.toContain(ALL_PASSED);
    });

    test("a result whose diagnostics carry no scope renders the flat pre-mt#5154 form", () => {
      const out = renderConfigDoctorResult(doctorResult());
      expect(out).not.toContain("User scope");
      expect(out).toContain(CHECK_MODELS);
    });
  });

  describe("renderConfigDoctorResult", () => {
    // AT1: a warning's check name AND message appear in default output.
    test("shows a warning check's name and message by default", () => {
      const out = renderConfigDoctorResult(doctorResult());
      expect(out).toContain(CHECK_MODELS);
      expect(out).toContain("Configured default model not found");
    });

    // AT4: the suggestion — the actionable half — is displayed.
    test("shows the suggestion when a diagnostic carries one", () => {
      const out = renderConfigDoctorResult(doctorResult());
      expect(out).toContain("Set the provider's model to an id the listing returns");
    });

    test("never renders a bare success line when diagnostics exist", () => {
      expect(renderConfigDoctorResult(doctorResult())).not.toBe("✅ Success");
    });

    test("reports the summary counts", () => {
      expect(renderConfigDoctorResult(doctorResult())).toContain(
        "3 checks — 2 passed, 1 warning, 0 errors"
      );
    });

    // AT2: --verbose produces observably more output than the default run.
    test("verbose adds the passing checks the default run omits", () => {
      const quiet = renderConfigDoctorResult(doctorResult());
      const loud = renderConfigDoctorResult(doctorResult({ verbose: true }));

      expect(quiet).not.toContain(CHECK_LOADING);
      expect(loud).toContain(CHECK_LOADING);
      expect(loud).toContain(CHECK_DIRECTORY);
      expect(loud.length).toBeGreaterThan(quiet.length);
    });

    test("an all-passing run still names the outcome instead of going silent", () => {
      const out = renderConfigDoctorResult({
        success: true,
        json: false,
        summary: { total: 1, passed: 1, warnings: 0, errors: 0 },
        diagnostics: [{ check: CHECK_LOADING, status: "pass", message: "ok" }],
        verbose: false,
      });
      expect(out).toContain("1 check — 1 passed");
      expect(out).toContain(ALL_PASSED);
    });

    // AT3: --json passes the payload straight through, unchanged.
    test("json mode emits the payload verbatim", () => {
      const payload = doctorResult({ json: true });
      expect(JSON.parse(renderConfigDoctorResult(payload))).toEqual(payload);
    });

    // PR #2727 R1: an unmapped status used to render as an anonymous bullet,
    // hiding its severity. It now carries its raw status text.
    test("an unknown status renders with its raw status text, not an anonymous bullet", () => {
      const out = renderConfigDoctorResult({
        json: false,
        summary: { total: 1, passed: 0, warnings: 0, errors: 0 },
        diagnostics: [{ check: "Novel Check", status: "indeterminate", message: "unclear" }],
        verbose: false,
      });
      expect(out).toContain("Novel Check");
      expect(out).toContain("[indeterminate]");
    });

    test("a mapped status does not get a redundant status prefix", () => {
      const out = renderConfigDoctorResult(doctorResult());
      expect(out).toContain("⚠️ Configured Model Validity");
      expect(out).not.toContain("[warning]");
    });
  });

  describe("renderConfigValidateResult", () => {
    test("names the no-issue outcome instead of a bare success line", () => {
      const out = renderConfigValidateResult({ success: true, json: false, errors: [] });
      expect(out).toContain("no issues found");
      expect(out).not.toBe("✅ Success");
    });

    test("shows each issue's path, message and severity split", () => {
      const out = renderConfigValidateResult({
        success: false,
        json: false,
        errors: [
          { path: "ai.providers.openai", message: "missing credential", severity: "error" },
          { path: "sessiondb.path", message: "deprecated key", severity: "warning" },
        ],
      });
      expect(out).toContain("2 issues — 1 error, 1 warning");
      expect(out).toContain("ai.providers.openai");
      expect(out).toContain("missing credential");
      expect(out).toContain("sessiondb.path");
    });

    // PR #2727 R1: `severity` is error | warning | info. Counting
    // "everything not an error" as a warning misreported info-level issues.
    test("counts info-severity issues separately from warnings", () => {
      const out = renderConfigValidateResult({
        success: true,
        json: false,
        errors: [
          { path: "a.b", message: "note", severity: "info" },
          { path: "c.d", message: "careful", severity: "warning" },
        ],
      });
      expect(out).toContain("0 errors, 1 warning, 1 info");
    });

    test("verbose adds the configuration sources the default run omits", () => {
      const base = { success: true, json: false, errors: [], sources: ["defaults", "user-file"] };
      const quiet = renderConfigValidateResult(base);
      const loud = renderConfigValidateResult({ ...base, verbose: true });

      expect(quiet).not.toContain("user-file");
      expect(loud).toContain("user-file");
      expect(loud.length).toBeGreaterThan(quiet.length);
    });

    test("json mode emits the payload verbatim", () => {
      const payload = { success: true, json: true, errors: [], totalIssues: 0 };
      expect(JSON.parse(renderConfigValidateResult(payload))).toEqual(payload);
    });
  });

  describe("formatter registration", () => {
    test("both commands have an outputFormatter so neither falls through to the generic one", () => {
      const commandOptions = getConfigCustomizations().options.commandOptions;
      expect(commandOptions?.["config.doctor"]?.outputFormatter).toBeDefined();
      expect(commandOptions?.["config.validate"]?.outputFormatter).toBeDefined();
    });
  });
});
