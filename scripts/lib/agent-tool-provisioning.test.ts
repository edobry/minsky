import { describe, expect, test } from "bun:test";
import { findUnprovisionedTools, formatFindings, parseMcpServer } from "./agent-tool-provisioning";

/**
 * The tool at the center of the mt#4245 incoherence: `.minsky/agents/reviewer/agent.ts` and
 * `auditor/agent.ts` both declare it, and driven sessions had no `github` server until mt#4239.
 */
const GITHUB_READ_TOOL = "mcp__github__get_file_contents";

describe("parseMcpServer", () => {
  test("returns null for a built-in tool", () => {
    expect(parseMcpServer("Read")).toBeNull();
    expect(parseMcpServer("Bash")).toBeNull();
    expect(parseMcpServer("ToolSearch")).toBeNull();
  });

  test("extracts the server from the standard MCP form", () => {
    expect(parseMcpServer(GITHUB_READ_TOOL)).toBe("github");
    expect(parseMcpServer("mcp__minsky__git_log")).toBe("minsky");
  });

  test("is not confused by single underscores inside the tool segment", () => {
    // The separator is a DOUBLE underscore; `session_pr_review_submit` contains none, so a
    // greedy server capture would swallow it. This is the case that makes the regex non-greedy.
    expect(parseMcpServer("mcp__minsky__session_pr_review_submit")).toBe("minsky");
  });

  test("extracts the compound server name from the plugin form", () => {
    expect(parseMcpServer("mcp__plugin_Notion_notion__notion-fetch")).toBe("plugin_Notion_notion");
  });
});

describe("findUnprovisionedTools", () => {
  test("flags a declared tool whose server is not provisioned", () => {
    const findings = findUnprovisionedTools(
      [{ agent: "reviewer", tools: [GITHUB_READ_TOOL] }],
      ["minsky"]
    );

    expect(findings).toEqual([{ agent: "reviewer", tool: GITHUB_READ_TOOL, server: "github" }]);
  });

  test("this is the mt#4239 incoherence, and it clears once the server is provisioned", () => {
    const declarations = [{ agent: "reviewer", tools: [GITHUB_READ_TOOL] }];

    // Pre-mt#4239 substrate: driven sessions got `minsky` and nothing else.
    expect(findUnprovisionedTools(declarations, ["minsky"])).toHaveLength(1);
    // Post-mt#4239 default set.
    expect(findUnprovisionedTools(declarations, ["minsky", "github"])).toHaveLength(0);
  });

  test("ignores built-in tools, which are not server-supplied", () => {
    const findings = findUnprovisionedTools(
      [{ agent: "auditor", tools: ["Read", "Glob", "Grep", "Bash"] }],
      []
    );

    expect(findings).toEqual([]);
  });

  test("returns findings sorted by agent then tool", () => {
    const findings = findUnprovisionedTools(
      [
        { agent: "zeta", tools: ["mcp__absent__b"] },
        { agent: "alpha", tools: ["mcp__absent__z", "mcp__absent__a"] },
      ],
      ["minsky"]
    );

    expect(findings.map((f) => `${f.agent}:${f.tool}`)).toEqual([
      "alpha:mcp__absent__a",
      "alpha:mcp__absent__z",
      "zeta:mcp__absent__b",
    ]);
  });
});

describe("formatFindings", () => {
  test("names the missing SERVER, which the runtime error never does", () => {
    const report = formatFindings(
      [{ agent: "reviewer", tool: GITHUB_READ_TOOL, server: "github" }],
      ["minsky"]
    );

    expect(report).toContain('server "github" is not provisioned');
    expect(report).toContain(`reviewer: ${GITHUB_READ_TOOL}`);
  });

  test("reports the provisioned set on a clean run", () => {
    expect(formatFindings([], ["minsky", "github"])).toContain("minsky, github");
  });
});
