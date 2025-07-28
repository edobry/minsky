#!/usr/bin/env bun

import { createRuleTemplateService } from "./src/domain/rules/rule-template-service";
import {
  DEFAULT_CLI_CONFIG,
  DEFAULT_MCP_CONFIG,
  DEFAULT_HYBRID_CONFIG,
} from "./src/domain/rules/template-system";
import { registerTasksCommands } from "./src/adapters/shared/commands/tasks";
import { registerGitCommands } from "./src/adapters/shared/commands/git";
import { registerSessionCommands } from "./src/adapters/shared/commands/session";
import { registerRulesCommands } from "./src/adapters/shared/commands/rules";
import * as path from "path";

async function testTemplateSystem() {
  console.log("Testing Template-Based Rules Generation System...\n");

  // Register all commands first
  console.log("0. Registering shared commands:");
  try {
    registerTasksCommands();
    console.log("   ✓ Task commands registered");
    registerGitCommands();
    console.log("   ✓ Git commands registered");
    registerSessionCommands();
    console.log("   ✓ Session commands registered");
    registerRulesCommands();
    console.log("   ✓ Rules commands registered");
  } catch (error) {
    console.log("   ✗ Error registering commands:", error);
  }

  const workspacePath = process.cwd();
  const service = createRuleTemplateService(workspacePath);

  // Test 1: Check if templates are registered
  console.log("\n1. Checking registered templates:");
  const templates = service.getTemplates();
  console.log(`   Found ${templates.length} templates:`);
  templates.forEach((t) => console.log(`   - ${t.id}: ${t.name}`));

  // Test 2: Generate CLI rules (dry run)
  console.log("\n2. Testing CLI rule generation (dry run):");
  const cliResult = await service.generateRules({
    config: DEFAULT_CLI_CONFIG,
    selectedRules: ["minsky-workflow", "task-status-protocol"],
    dryRun: true,
  });
  console.log(`   Success: ${cliResult.success}`);
  console.log(`   Generated: ${cliResult.rules.length} rules`);
  console.log(`   Errors: ${cliResult.errors.length}`);
  if (cliResult.errors.length > 0) {
    console.log("   Error details:");
    cliResult.errors.forEach((err) => console.log(`     - ${err}`));
  }

  // Test 3: Generate MCP rules (dry run)
  console.log("\n3. Testing MCP rule generation (dry run):");
  const mcpResult = await service.generateRules({
    config: DEFAULT_MCP_CONFIG,
    selectedRules: ["mcp-usage"],
    dryRun: true,
  });
  console.log(`   Success: ${mcpResult.success}`);
  console.log(`   Generated: ${mcpResult.rules.length} rules`);
  if (mcpResult.errors.length > 0) {
    console.log("   Error details:");
    mcpResult.errors.forEach((err) => console.log(`     - ${err}`));
  }

  // Test 4: Generate hybrid rules (dry run)
  console.log("\n4. Testing hybrid rule generation (dry run):");
  const hybridResult = await service.generateRules({
    config: DEFAULT_HYBRID_CONFIG,
    selectedRules: ["minsky-workflow"],
    dryRun: true,
  });
  console.log(`   Success: ${hybridResult.success}`);
  console.log(`   Generated: ${hybridResult.rules.length} rules`);
  if (hybridResult.errors.length > 0) {
    console.log("   Error details:");
    hybridResult.errors.forEach((err) => console.log(`     - ${err}`));
  }

  if (hybridResult.rules[0]) {
    console.log("   Rule content preview (first 200 chars):");
    console.log(`   "${hybridResult.rules[0].content.substring(0, 200)}..."`);
  }

  // Test 5: Check command references
  console.log("\n5. Checking command references in generated content:");
  if (cliResult.rules.length > 0 && cliResult.rules[0]) {
    const cliHasCliCommand = cliResult.rules[0].content.includes("minsky tasks");
    console.log(`   CLI rule has CLI commands: ${cliHasCliCommand}`);
  }
  if (mcpResult.rules.length > 0 && mcpResult.rules[0]) {
    const mcpHasMcpCommand = mcpResult.rules[0].content.includes("mcp_minsky");
    console.log(`   MCP rule has MCP commands: ${mcpHasMcpCommand}`);
  }

  // Test 6: Show a snippet of generated rule content
  console.log("\n6. Sample generated rule content:");
  if (cliResult.rules.length > 0) {
    console.log("   CLI Rule (minsky-workflow) snippet:");
    const lines = cliResult.rules[0].content.split("\n").slice(0, 10);
    lines.forEach((line) => console.log(`     ${line}`));
  }

  console.log("\n✅ Template system test complete!");
}

testTemplateSystem().catch(console.error);
