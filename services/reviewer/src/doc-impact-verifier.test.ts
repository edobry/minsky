import { describe, it, expect } from "bun:test";
import {
  extractSurfaceTerms,
  verifyAffectedDocs,
  applyDocImpactVerification,
} from "./doc-impact-verifier";
import type { ReviewToolCall } from "./output-tools";

const DOC_CONFIG_GUIDE = "docs/configuration-guide.md";
const DOC_README = "docs/README.md";
const DOC_UNRELATED = "docs/unrelated.md";
const KIND_BLOCKING = "blocking-needs-update" as const;
const KIND_NO_UPDATE = "no-update-needed" as const;
const EVIDENCE_NEEDS_UPDATING = "Docs need updating";
const TOOL_NAME = "submit_documentation_impact" as const;

describe("extractSurfaceTerms", () => {
  it("extracts meaningful path segments from changed files", () => {
    const terms = extractSurfaceTerms(
      ["src/cockpit/web/src/pages/Settings.tsx", "src/cockpit/web/src/routes.ts"],
      ""
    );
    expect(terms).toContain("cockpit");
    expect(terms).toContain("settings");
    expect(terms).toContain("routes");
    expect(terms).not.toContain("src");
    expect(terms).not.toContain("web");
    expect(terms).not.toContain("pages");
  });

  it("extracts identifiers from diff added/removed lines", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "+  const credentialStore = new CredentialStore();",
      "-  const oldStore = getOldStore();",
    ].join("\n");
    const terms = extractSurfaceTerms([], diff);
    expect(terms).toContain("credentialstore");
    expect(terms).toContain("getoldstore");
    expect(terms).toContain("oldstore");
  });

  it("extracts route paths from the diff", () => {
    const diff = [
      '+  { path: "/settings", component: SettingsPage },',
      '+  { path: "/credentials", component: CredentialsPage },',
    ].join("\n");
    const terms = extractSurfaceTerms([], diff);
    expect(terms).toContain("/settings");
    expect(terms).toContain("/credentials");
  });

  it("filters out noise tokens (import, export, const, etc.)", () => {
    const diff = ["+import { something } from './module';"].join("\n");
    const terms = extractSurfaceTerms([], diff);
    expect(terms).not.toContain("import");
    expect(terms).not.toContain("from");
    expect(terms).toContain("something");
  });

  it("filters out short identifiers (< 4 chars)", () => {
    const diff = ["+const foo = bar();"].join("\n");
    const terms = extractSurfaceTerms([], diff);
    expect(terms).not.toContain("foo");
    expect(terms).not.toContain("bar");
  });
});

describe("verifyAffectedDocs", () => {
  it("keeps docs that contain surface terms", () => {
    const docContents = new Map([
      [DOC_CONFIG_GUIDE, "# Configuration\n\nUse `minsky config set` to configure credentials."],
    ]);
    const result = verifyAffectedDocs([DOC_CONFIG_GUIDE], ["credentials", "config"], docContents);
    expect(result.verified).toEqual([DOC_CONFIG_GUIDE]);
    expect(result.removed).toEqual([]);
  });

  it("removes docs that contain no surface terms", () => {
    const docContents = new Map([
      [DOC_CONFIG_GUIDE, "# Configuration\n\nThis guide covers CLI setup and session management."],
    ]);
    const result = verifyAffectedDocs(
      [DOC_CONFIG_GUIDE],
      ["cockpit", "settings", "/settings"],
      docContents
    );
    expect(result.verified).toEqual([]);
    expect(result.removed).toEqual([DOC_CONFIG_GUIDE]);
  });

  it("removes docs whose content could not be fetched", () => {
    const docContents = new Map<string, string>();
    const result = verifyAffectedDocs(["docs/nonexistent.md"], ["anything"], docContents);
    expect(result.verified).toEqual([]);
    expect(result.removed).toEqual(["docs/nonexistent.md"]);
  });

  it("handles mixed verified and unverified docs", () => {
    const docContents = new Map([
      ["docs/a.md", "This doc covers the cockpit settings UI."],
      ["docs/b.md", "This doc covers the task system internals."],
    ]);
    const result = verifyAffectedDocs(
      ["docs/a.md", "docs/b.md"],
      ["cockpit", "settings"],
      docContents
    );
    expect(result.verified).toEqual(["docs/a.md"]);
    expect(result.removed).toEqual(["docs/b.md"]);
  });

  it("performs case-insensitive matching", () => {
    const docContents = new Map([["docs/guide.md", "The COCKPIT UI provides a Settings page."]]);
    const result = verifyAffectedDocs(["docs/guide.md"], ["cockpit", "settings"], docContents);
    expect(result.verified).toEqual(["docs/guide.md"]);
    expect(result.removed).toEqual([]);
  });
});

describe("applyDocImpactVerification", () => {
  const makeDocImpactCall = (
    kind: typeof KIND_BLOCKING | typeof KIND_NO_UPDATE | "updated-in-pr",
    evidence: string,
    affectedDocs?: string[]
  ): ReviewToolCall => ({
    name: TOOL_NAME,
    args: { kind, evidence, ...(affectedDocs ? { affectedDocs } : {}) },
  });

  const makeFindingCall = (): ReviewToolCall => ({
    name: "submit_finding" as const,
    args: {
      severity: "BLOCKING" as const,
      file: "src/foo.ts",
      line: 1,
      summary: "test",
      details: "test details",
    },
  });

  it("downgrades blocking-needs-update to no-update-needed when all docs are unverified", () => {
    const toolCalls: ReviewToolCall[] = [
      makeFindingCall(),
      makeDocImpactCall(KIND_BLOCKING, EVIDENCE_NEEDS_UPDATING, [DOC_README, DOC_CONFIG_GUIDE]),
    ];
    const docContents = new Map([
      [DOC_README, "# Minsky\n\nAn AI agent orchestration platform."],
      [DOC_CONFIG_GUIDE, "# Configuration\n\nCLI setup and session management."],
    ]);

    const result = applyDocImpactVerification(
      toolCalls,
      ["cockpit", "settings", "/settings"],
      docContents
    );

    expect(result.verificationsApplied).toBe(true);
    expect(result.removedDocs).toEqual([DOC_README, DOC_CONFIG_GUIDE]);

    const docCall = result.toolCalls.find((tc) => tc.name === TOOL_NAME);
    expect(docCall).toBeDefined();
    if (docCall) {
      expect(docCall.args.kind).toBe(KIND_NO_UPDATE);
      expect(docCall.args.evidence).toContain("[Verification:");
    }
  });

  it("preserves verified docs and removes unverified ones", () => {
    const toolCalls: ReviewToolCall[] = [
      makeDocImpactCall(KIND_BLOCKING, EVIDENCE_NEEDS_UPDATING, ["docs/config.md", DOC_UNRELATED]),
    ];
    const docContents = new Map([
      ["docs/config.md", "# Config\n\nThe `minsky config set` command manages credentials."],
      [DOC_UNRELATED, "# Architecture\n\nThe task system uses a state machine."],
    ]);

    const result = applyDocImpactVerification(toolCalls, ["credentials", "config"], docContents);

    expect(result.verificationsApplied).toBe(true);
    expect(result.removedDocs).toEqual([DOC_UNRELATED]);

    const docCall = result.toolCalls.find((tc) => tc.name === TOOL_NAME);
    expect(docCall).toBeDefined();
    if (docCall) {
      expect(docCall.args.kind).toBe(KIND_BLOCKING);
      expect(docCall.args.affectedDocs).toEqual(["docs/config.md"]);
    }
  });

  it("passes through non-blocking doc-impact calls unchanged", () => {
    const toolCalls: ReviewToolCall[] = [makeDocImpactCall(KIND_NO_UPDATE, "No docs affected")];

    const result = applyDocImpactVerification(toolCalls, ["anything"], new Map());
    expect(result.verificationsApplied).toBe(false);
    expect(result.toolCalls).toEqual(toolCalls);
  });

  it("passes through when affectedDocs is empty", () => {
    const toolCalls: ReviewToolCall[] = [
      makeDocImpactCall(KIND_BLOCKING, EVIDENCE_NEEDS_UPDATING, []),
    ];

    const result = applyDocImpactVerification(toolCalls, ["anything"], new Map());
    expect(result.verificationsApplied).toBe(false);
    expect(result.toolCalls).toEqual(toolCalls);
  });

  it("leaves other tool calls untouched", () => {
    const finding = makeFindingCall();
    const toolCalls: ReviewToolCall[] = [
      finding,
      makeDocImpactCall(KIND_BLOCKING, EVIDENCE_NEEDS_UPDATING, ["docs/a.md"]),
    ];
    const docContents = new Map([["docs/a.md", "No relevant content here."]]);

    const result = applyDocImpactVerification(toolCalls, ["cockpit"], docContents);
    expect(result.toolCalls[0]).toEqual(finding);
  });
});
