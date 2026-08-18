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
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { findUnprovisionedTools, formatFindings } = await import("./lib/agent-tool-provisioning");
const { drivenSessionMcpServerNames } = await import("../src/cockpit/driven-session-mcp-servers");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = path.join(REPO_ROOT, ".minsky", "agents");

/**
 * `minsky` is provisioned unconditionally and SYNTHESIZED rather than inherited — its command
 * must point at the running build and the session's own repo path, so it is never read from
 * the operator's `.mcp.json`. Union it in explicitly rather than relying on it appearing in
 * the configured list, which an operator may legitimately set to `[]`.
 *
 * @see packages/domain/src/configuration/schemas/cockpit.ts — where that invariant is stated
 */
const ALWAYS_PROVISIONED = "minsky";

interface AgentModule {
  readonly default?: { readonly name?: string; readonly tools?: readonly string[] };
}

async function loadDeclarations(): Promise<{ agent: string; tools: readonly string[] }[]> {
  const entries = readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const declarations: { agent: string; tools: readonly string[] }[] = [];

  for (const name of entries) {
    const modulePath = path.join(AGENTS_DIR, name, "agent.ts");
    const mod: AgentModule = await import(modulePath);
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
  const provisioned = [...new Set([ALWAYS_PROVISIONED, ...drivenSessionMcpServerNames()])];
  const findings = findUnprovisionedTools(declarations, provisioned);

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        { provisionedServers: provisioned, agentsChecked: declarations.length, findings },
        null,
        2
      )
    );
  } else {
    console.log(formatFindings(findings, provisioned));
  }

  process.exit(findings.length === 0 ? 0 : 1);
}

await main();
