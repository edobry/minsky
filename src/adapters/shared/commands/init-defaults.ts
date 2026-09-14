/**
 * What `minsky init` DERIVES versus what it has to ASK (mt#5149).
 *
 * Interactive `init` used to ask four questions. Three of them had a single
 * right answer the code already computed or that prior decisions had fixed:
 *
 *   - rule format — derived from the running harness since mt#4715
 *     (`resolveInitClient()`), and the prompt was kept only so the two paths
 *     agreed on a default; under a detected harness the derived value is the
 *     only one that produces rules the harness reads (mt#4699 §Findings 1).
 *   - MCP enabled — declining skips `performSetup`, i.e. the agent gets no
 *     Minsky tools; there is no first-run user for whom that is the answer.
 *   - MCP transport — `stdio`, CHOSEN per ADR-038 (the shared daemon is reached
 *     by the shim; the client stays a `type: "stdio"` entry), and `mcp start`
 *     never reads the key (mt#4699 §Findings 3).
 *
 * A first-time user in a foreign project was therefore asked to choose between
 * "Cursor / Minsky / Generic" and "STDIO / SSE / HTTP Stream" — vocabulary that
 * needs `init.ts` open to answer. This module decides, as a VALUE, which of
 * those the run still has to ask, so the decision is assertable without
 * driving `@clack` prompts (`testing-standards.mdc §Testable Design`).
 *
 * The one case the rule-format prompt survives in: no environment signal AND
 * no installed client. `resolveInitClient()` never returns "unknown" — with
 * nothing detected it falls back to `cursor` for back-compat
 * (`STANDALONE_CLIENT_PRIORITY`'s docblock) — so the resolver's answer alone
 * cannot tell "Cursor detected" from "nothing detected". The two detectors it
 * takes as parameters can, and that is the predicate used here.
 *
 * Every derived value stays overridable by the flags that already exist
 * (`--rule-format`, `--mcp`, `--mcp-transport`, `--mcp-port`, `--mcp-host`),
 * on the interactive path exactly as on the non-interactive one.
 */

import {
  resolveInitClient,
  type AgentHarness,
  type ManagedClient,
} from "@minsky/domain/runtime/harness-detection";
import { RULE_FORMAT_OUTPUT_DIR, type RuleFormat } from "@minsky/domain/rules/types";

/** The MCP settings `initializeProject` accepts. */
export interface InitMcpSettings {
  enabled: boolean;
  transport: "stdio" | "sse" | "httpStream";
  port?: number;
  host?: string;
}

/**
 * The subset of `init`'s flags this decision reads — a projection the handler
 * builds from its own (registry-derived) params, not a handler param type.
 */
export interface InitDefaultsFlags {
  ruleFormat?: string;
  mcp?: string | boolean;
  mcpTransport?: string;
  mcpPort?: string;
  mcpHost?: string;
}

export interface InitDefaultsInput {
  /** `isInteractive()` — a TTY with prompts available. */
  interactive: boolean;
  /** `detectAgentHarness()` — the environment's own signal. */
  harness: AgentHarness;
  /** `detectInstalledClients()` — the filesystem fallback. */
  installedClients: readonly ManagedClient[];
  params: InitDefaultsFlags;
}

export interface InitDefaultsPlan {
  /** What `resolveInitClient()` resolved from the two signals. */
  client: ManagedClient;
  /** Whether EITHER signal carried a client — false means `client` is the back-compat fallback. */
  detected: boolean;
  /** The format to use, or `"ask"` when the user genuinely holds the answer. */
  ruleFormat: RuleFormat | "ask";
  /**
   * MCP settings to pass through. `undefined` is the non-interactive path's
   * long-standing value: `initializeProject` treats it as enabled, and
   * `performSetup` registers the client over stdio.
   */
  mcp: InitMcpSettings | undefined;
  /** One line telling the user what was decided for them and how to override it. */
  summary: string;
}

const CLIENT_LABELS: Record<ManagedClient, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  "claude-desktop": "Claude Desktop",
  vscode: "VS Code",
  windsurf: "Windsurf",
  junie: "Junie",
  codex: "Codex",
  openhands: "OpenHands",
};

/**
 * The harness-derived rule format (mt#4715). Claude Code reads neither
 * `.cursor/rules` nor `.ai/rules`; it reads what the compile pipeline emits
 * FROM `.minsky/rules` sources, so it gets `minsky`. Everything else keeps
 * `init`'s historical `cursor`.
 */
export function ruleFormatForClient(client: ManagedClient): RuleFormat {
  return client === "claude-code" ? "minsky" : "cursor";
}

function describeRuleFormat(format: RuleFormat): string {
  if (format === "minsky") return "rules compile to CLAUDE.md and .claude/rules";
  return `rules compile to ${RULE_FORMAT_OUTPUT_DIR[format]}`;
}

/**
 * The MCP half of the summary. When flags supplied the settings, the line
 * names the flags that were actually given (PR #3756 R1) — `--mcp-port 4000`
 * alone must not be attributed to `--mcp-transport` — and host/port are shown
 * only for a network transport, since stdio has neither.
 */
function describeMcp(mcp: InitMcpSettings | undefined, params: InitDefaultsFlags): string {
  if (mcp === undefined) return "MCP registers over stdio";
  if (!mcp.enabled) return "MCP registration skipped (--mcp false)";
  const given = [
    params.mcp !== undefined ? "--mcp" : undefined,
    params.mcpTransport ? "--mcp-transport" : undefined,
    params.mcpPort ? "--mcp-port" : undefined,
    params.mcpHost ? "--mcp-host" : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  const where =
    mcp.transport === "stdio"
      ? ""
      : [mcp.host, mcp.port !== undefined ? String(mcp.port) : undefined]
          .filter((part): part is string => part !== undefined)
          .join(":");
  const suffix = where.length > 0 ? ` on ${where}` : "";
  return `MCP registers over ${mcp.transport}${suffix} (${given.join(", ")})`;
}

/**
 * Decide what `init` derives and what it still asks. Pure: every input is a
 * parameter, so the prompt-or-derive branch is testable as a value.
 */
export function planInitDefaults(input: InitDefaultsInput): InitDefaultsPlan {
  const { interactive, harness, installedClients, params } = input;
  const client = resolveInitClient(harness, [...installedClients]);
  const detected = harness !== "standalone" || installedClients.length > 0;

  // MCP: explicit flags win; otherwise the non-interactive path's `undefined`
  // on EVERY path — that is the value an agent-driven init has always passed,
  // and `performSetup` resolves it to a stdio registration.
  // Truthiness on the string flags is deliberate and pre-dates this module: an
  // empty `--mcp-transport ""` has always read as "not given".
  const mcpFlagsGiven = Boolean(
    params.mcp !== undefined || params.mcpTransport || params.mcpPort || params.mcpHost
  );
  const mcp: InitMcpSettings | undefined = mcpFlagsGiven
    ? {
        enabled: params.mcp === undefined ? true : params.mcp === true || params.mcp === "true",
        transport:
          (params.mcpTransport as InitMcpSettings["transport"] | "" | undefined) || "stdio",
        port: params.mcpPort ? Number(params.mcpPort) : undefined,
        host: params.mcpHost || undefined,
      }
    : undefined;

  // Rule format: explicit flag wins; derived under any detected client; asked
  // only when interactive AND nothing at all was detected.
  let ruleFormat: RuleFormat | "ask";
  let formatSource: "flag" | "derived" | "ask";
  if (params.ruleFormat !== undefined) {
    ruleFormat = params.ruleFormat as RuleFormat;
    formatSource = "flag";
  } else if (interactive && !detected) {
    ruleFormat = "ask";
    formatSource = "ask";
  } else {
    ruleFormat = ruleFormatForClient(client);
    formatSource = "derived";
  }

  const lead =
    harness !== "standalone"
      ? `Detected ${CLIENT_LABELS[client]}`
      : detected
        ? `No agent harness detected; using the installed ${CLIENT_LABELS[client]} client`
        : "No agent harness or client detected";
  const parts: string[] = [];
  if (formatSource === "flag") {
    parts.push(`${describeRuleFormat(ruleFormat as RuleFormat)} (--rule-format)`);
  } else if (formatSource === "derived") {
    parts.push(describeRuleFormat(ruleFormat as RuleFormat));
  }
  parts.push(describeMcp(mcp, params));
  const overrides =
    formatSource === "flag" && mcpFlagsGiven
      ? ""
      : " Override with --rule-format, --mcp, --mcp-transport.";

  return {
    client,
    detected,
    ruleFormat,
    mcp,
    summary: `${lead}: ${parts.join("; ")}.${overrides}`,
  };
}
