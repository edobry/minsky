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
 * The rule-format prompt no longer survives anywhere (mt#5153). The CLIENT is
 * resolved before this runs — `resolveClientForCommand` in
 * `client-resolution.ts`: an explicit `--client`, the MCP caller's identity,
 * the CLI environment, or the one installed client; otherwise it asks on a
 * TTY or refuses naming the accepted values. So by the time the plan is made
 * the harness is known, and the format is derived from it. What this module
 * still decides is the derivation and the summary; it takes the resolved
 * client and HOW it was resolved, so the summary can say so.
 *
 * Every derived value stays overridable by the flags that already exist
 * (`--rule-format`, `--mcp`, `--mcp-transport`, `--mcp-port`, `--mcp-host`),
 * on the interactive path exactly as on the non-interactive one.
 */

import {
  describeHarnessSource,
  type HarnessSource,
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
  /** The client `resolveClientForCommand` settled on (mt#5153). */
  client: ManagedClient;
  /** How it was settled — the summary names it, so a defaulted value is visible. */
  source: HarnessSource;
  params: InitDefaultsFlags;
}

export interface InitDefaultsPlan {
  /** The client the plan was made for — as given. */
  client: ManagedClient;
  /** The format to use. Derived from `client` unless `--rule-format` said otherwise. */
  ruleFormat: RuleFormat;
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
  const { client, source, params } = input;

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

  // Rule format: explicit flag wins; otherwise derived from the client, which
  // is always known here (mt#5153 — the ask-or-refuse happened upstream).
  let ruleFormat: RuleFormat;
  let formatSource: "flag" | "derived";
  if (params.ruleFormat !== undefined) {
    ruleFormat = params.ruleFormat as RuleFormat;
    formatSource = "flag";
  } else {
    ruleFormat = ruleFormatForClient(client);
    formatSource = "derived";
  }

  // The lead names the harness AND its provenance (mt#5153 SC5): "Detected"
  // only when something actually detected it; "Using" when the operator or the
  // machine's sole installed client answered.
  const label = CLIENT_LABELS[client];
  const lead =
    source === "env" || source === "mcp-client"
      ? `Detected ${label} (${describeHarnessSource(source)})`
      : `Using ${label} (${describeHarnessSource(source)})`;
  const parts: string[] = [];
  if (formatSource === "flag") {
    parts.push(`${describeRuleFormat(ruleFormat)} (--rule-format)`);
  } else {
    parts.push(describeRuleFormat(ruleFormat));
  }
  parts.push(describeMcp(mcp, params));
  // `--client` joins the override hint (mt#5153): the harness is now one of
  // the things this line reports as decided, so it is one of the things the
  // hint has to say can be overridden.
  const overrides =
    formatSource === "flag" && mcpFlagsGiven && source === "flag"
      ? ""
      : " Override with --client, --rule-format, --mcp, --mcp-transport.";

  return {
    client,
    ruleFormat,
    mcp,
    summary: `${lead}: ${parts.join("; ")}.${overrides}`,
  };
}
