#!/usr/bin/env bun
/**
 * Fail when an agent definition declares an MCP tool the driven-session substrate
 * cannot supply (mt#4245; ADR-043 §"Immediate, independent of the registry").
 *
 * This is the imperative shell — discovery, config read, exit code. The decision logic is
 * `scripts/lib/agent-tool-provisioning.ts`, which is pure and unit-tested; see that module
 * for what the check covers and what it deliberately does not.
 *
 * Usage:
 *   bun scripts/check-agent-tool-provisioning.ts          # human-readable
 *   bun scripts/check-agent-tool-provisioning.ts --json   # structured
 *
 * Exit code: 0 = every declared MCP tool resolves; 1 = at least one does not. Unlike the
 * report-style `check-*` scripts in this directory, this one is a GATE — the whole point is
 * to turn a silent runtime mismatch into a build failure.
 *
 * @see docs/architecture/adr-043-agent-tool-surface-registry.md
 */

// Must precede anything that can reach tsyringe. `drivenSessionMcpServerNames` reads the
// configuration system, which pulls the DI container — without this the script dies on
// "tsyringe requires a reflect polyfill" before it can check anything (mt#3680). Static, so
// it is hoisted ahead of the dynamic imports below.
import "reflect-metadata";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { findUnprovisionedTools, formatFindings } = await import("./lib/agent-tool-provisioning");
const { drivenSessionMcpServerNames } = await import("../src/cockpit/driven-session-mcp-servers");
const { DRIVEN_SESSION_MCP_SERVER_NAME } = await import("../src/cockpit/driven-session-mcp-config");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = path.join(REPO_ROOT, ".minsky", "agents");

interface AgentModule {
  readonly default?: { readonly name?: string; readonly tools?: readonly string[] };
}

/**
 * Read every agent definition's declared tool list.
 *
 * A missing agents directory yields an EMPTY list rather than throwing. This check runs from
 * `validate-all`, so it can execute in a minimal or variant checkout that carries no
 * `.minsky/agents/` at all — and crashing there would fail the whole validation run for a
 * condition that is not a finding. The caller reports the absence explicitly, so an empty
 * corpus is distinguishable from a corpus that was read and found clean.
 *
 * Definitions are IMPORTED rather than text-parsed. That costs a module side effect per agent
 * (`loadMarkdown` reads the sibling `prompt.md`), which is the deliberate trade: `tools` is a
 * typed array on the real `AgentDefinition`, and regex-parsing TypeScript to avoid a file read
 * would reintroduce exactly the source-of-truth drift this check exists to catch.
 */
async function loadDeclarations(): Promise<{ agent: string; tools: readonly string[] }[]> {
  if (!existsSync(AGENTS_DIR)) return [];

  const entries = readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const declarations: { agent: string; tools: readonly string[] }[] = [];

  for (const name of entries) {
    // `import()` of an ABSOLUTE path must be a file:// URL — a bare path is not a valid ESM
    // specifier and resolution of it is runtime-specific (and breaks outright on Windows,
    // where a drive letter reads as a protocol).
    const moduleUrl = pathToFileURL(path.join(AGENTS_DIR, name, "agent.ts")).href;
    const mod: AgentModule = await import(moduleUrl);
    const definition = mod.default;
    // `tools` is optional in AgentDefinition and means "all tools" when omitted — an agent
    // that restricts nothing cannot declare a tool the substrate lacks, so it has no findings.
    if (definition?.tools === undefined) continue;
    declarations.push({ agent: definition.name ?? name, tools: definition.tools });
  }

  return declarations;
}

/**
 * Initialize configuration so `drivenSessionMcpServerNames()` reads the OPERATOR's set rather
 * than silently falling back.
 *
 * That fallback is deliberate in the resolver — it must never stop a driven session from
 * spawning — but it makes this check dishonest by default: it would report against the shipped
 * default while its output names the configured set, so an operator who narrowed
 * `cockpit.drivenSession.mcpServers` would get a clean run for tools their own driven sessions
 * cannot supply. Anchored at the repo root, not `process.cwd()`, so the answer does not depend
 * on where the check was invoked from.
 */
async function initConfiguration(): Promise<void> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: REPO_ROOT });
}

async function main(): Promise<void> {
  await initConfiguration();
  const declarations = await loadDeclarations();

  // `minsky` is provisioned unconditionally and SYNTHESIZED rather than inherited — its command
  // must point at the running build and the session's own repo path, so it is never read from
  // the operator's `.mcp.json`. Sourced from the resolver's own constant rather than a literal
  // here, so the two cannot drift.
  const provisioned = [
    ...new Set([DRIVEN_SESSION_MCP_SERVER_NAME, ...drivenSessionMcpServerNames()]),
  ];
  const findings = findUnprovisionedTools(declarations, provisioned);

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          agentsDir: existsSync(AGENTS_DIR) ? AGENTS_DIR : null,
          provisionedServers: provisioned,
          agentsChecked: declarations.length,
          findings,
        },
        null,
        2
      )
    );
  } else if (declarations.length === 0) {
    // Named explicitly: a corpus that was never read must not look like one that read clean.
    console.log(
      `No agent definitions with a declared tool list under ${AGENTS_DIR} — nothing to check.`
    );
  } else {
    console.log(formatFindings(findings, provisioned));
  }

  process.exit(findings.length === 0 ? 0 : 1);
}

await main();
