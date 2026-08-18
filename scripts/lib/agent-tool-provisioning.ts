/**
 * Agent-declaration ↔ substrate cross-reference (mt#4245, ADR-043 "Immediate").
 *
 * An agent definition's `tools:` list is a DECLARATION. Whether the substrate can
 * actually supply those tools is a separate fact, and nothing checked the two against
 * each other: `.minsky/agents/reviewer/agent.ts` declared `mcp__github__get_file_contents`
 * while driven sessions were provisioned with `minsky` and nothing else (mt#3377, until
 * mt#4239). The mismatch surfaced only as `No such tool available` at call time — the same
 * string mt#3779 traces to four other causes, so it does not even identify itself.
 *
 * This module is the pure core; `scripts/check-agent-tool-provisioning.ts` is the shell
 * that discovers definitions and prints findings.
 *
 * ## What this checks, and what it deliberately does not
 *
 * Scope is the DRIVEN-SESSION substrate. A dispatched subagent inherits its PARENT's MCP
 * config, so in an ordinary conversation `mcp__github__*` resolves whenever the operator's
 * `.mcp.json` carries a `github` server — and that file is gitignored, absent from every
 * session clone and from CI, so it cannot be the baseline. The answerable question, and the
 * one that produced the incoherence, is: **if this agent type ran inside a driven session,
 * would its declared tools resolve?**
 *
 * A finding therefore means "unavailable when driven," NOT "this tool does not exist."
 *
 * @see docs/architecture/adr-043-agent-tool-surface-registry.md — the decision this serves
 * @see src/cockpit/driven-session-mcp-servers.ts — where the provisioned set comes from
 */

/** One agent's declared tool list, as read from its definition. */
export interface AgentToolDeclaration {
  readonly agent: string;
  readonly tools: readonly string[];
}

/** A declared MCP tool whose server the driven-session substrate does not provision. */
export interface UnprovisionedTool {
  readonly agent: string;
  readonly tool: string;
  readonly server: string;
}

/**
 * The server segment of an MCP tool name, or `null` for a built-in.
 *
 * Handles both forms the harness emits:
 *   `mcp__<server>__<tool>`                        → `<server>`
 *   `mcp__plugin_<plugin>_<server>__<tool>`        → `plugin_<plugin>_<server>`
 *
 * The server capture is non-greedy so the FIRST `__` after the prefix ends it; a tool name
 * containing underscores (`git_log`, `session_pr_review_submit`) is unaffected because it is
 * single underscores that appear inside a segment, not doubles.
 */
export function parseMcpServer(toolName: string): string | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return match?.[1] ?? null;
}

/**
 * Every declared MCP tool whose server is absent from `provisionedServers`.
 *
 * Built-in tools (`Read`, `Bash`, `Glob`) are ignored — they are not server-supplied, so the
 * question does not apply to them. Results are ordered by agent then tool so the output is
 * stable across runs and diffs cleanly in CI.
 */
export function findUnprovisionedTools(
  declarations: readonly AgentToolDeclaration[],
  provisionedServers: readonly string[]
): UnprovisionedTool[] {
  const provisioned = new Set(provisionedServers);
  const findings: UnprovisionedTool[] = [];

  for (const { agent, tools } of declarations) {
    for (const tool of tools) {
      const server = parseMcpServer(tool);
      if (server === null || provisioned.has(server)) continue;
      findings.push({ agent, tool, server });
    }
  }

  return findings.sort((a, b) => a.agent.localeCompare(b.agent) || a.tool.localeCompare(b.tool));
}

/**
 * Human-readable report. Names the server, not just the tool — the whole point is that the
 * failure is a missing SERVER, which the runtime error never says.
 */
export function formatFindings(
  findings: readonly UnprovisionedTool[],
  provisionedServers: readonly string[]
): string {
  const provisioned = provisionedServers.length > 0 ? provisionedServers.join(", ") : "(none)";

  if (findings.length === 0) {
    return `All declared MCP tools resolve against the driven-session server set: ${provisioned}`;
  }

  const byServer = new Map<string, UnprovisionedTool[]>();
  for (const finding of findings) {
    const group = byServer.get(finding.server) ?? [];
    group.push(finding);
    byServer.set(finding.server, group);
  }

  const lines = [
    `${findings.length} declared tool(s) name an MCP server a driven session does not provision.`,
    `Driven-session server set: ${provisioned}`,
    "",
    "An agent of this type running inside a driven session would get",
    '"No such tool available" for each of these — with no indication that a SERVER is missing.',
    "",
  ];

  for (const [server, group] of [...byServer.entries()].sort()) {
    lines.push(`  server "${server}" is not provisioned:`);
    for (const { agent, tool } of group) lines.push(`    ${agent}: ${tool}`);
  }

  lines.push(
    "",
    "Fix by either adding the server to `cockpit.drivenSession.mcpServers`, or removing the",
    "tool from the agent definition. See docs/architecture/adr-043-agent-tool-surface-registry.md."
  );

  return lines.join("\n");
}
