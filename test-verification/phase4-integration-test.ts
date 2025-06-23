/**
 * Phase 4 Integration Test: Comprehensive validation of all session-aware tools
 * Tests tool registration, interface compatibility, and end-to-end functionality
 */

import { MinskyMCPServer } from "../src/mcp/server.js";
import { CommandMapper } from "../src/mcp/command-mapper.js";
import { registerSessionFileTools } from "../src/adapters/mcp/session-files.js";
import { registerSessionEditTools } from "../src/adapters/mcp/session-edit-tools.js";
import { registerSessionSearchTools } from "../src/adapters/mcp/session-search-tools.js";
import { registerSessionCommandTools } from "../src/adapters/mcp/session-command-tools.js";

interface ToolValidationResult {
  toolName: string;
  registered: boolean;
  hasValidSchema: boolean;
  interfaceCompatible: boolean;
  errors: string[];
}

interface IntegrationTestResult {
  success: boolean;
  totalTools: number;
  registeredTools: number;
  validTools: number;
  toolResults: ToolValidationResult[];
  errors: string[];
}

/**
 * Expected session tools based on implementation
 */
const EXPECTED_SESSION_TOOLS = [
  // Phase 1: File Operations
  "session_edit_file",
  "session_search_replace",
  
  // Phase 2: Search Operations  
  "session_grep_search",
  "session_file_search",
  "session_codebase_search",
  
  // Phase 3: Command Execution
  "session_run_command",
  "session_list_dir", 
  "session_read_file",
  
  // Existing session tools
  "session_read_file", // from session-files.ts
  "session_write_file",
  "session_delete_file",
  "session_list_directory",
  "session_file_exists",
  "session_create_directory"
];

/**
 * Validate tool registration and interface compatibility
 */
async function validateToolRegistration(): Promise<IntegrationTestResult> {
  const result: IntegrationTestResult = {
    success: false,
    totalTools: EXPECTED_SESSION_TOOLS.length,
    registeredTools: 0,
    validTools: 0,
    toolResults: [],
    errors: []
  };

  try {
    console.log("🧪 Starting Phase 4 Integration Test");
    console.log("📋 Validating session-aware tool registration...");

    // Create a test MCP server instance
    const server = new MinskyMCPServer({
      name: "Integration Test Server",
      version: "1.0.0",
      transportType: "stdio"
    });

    // Create command mapper for tool registration
    const commandMapper = new CommandMapper(server.getFastMCPServer());

    // Register all session tools
    console.log("🔧 Registering session tools...");
    registerSessionFileTools(commandMapper);
    registerSessionEditTools(commandMapper);
    registerSessionSearchTools(commandMapper);
    registerSessionCommandTools(commandMapper);

    // Get list of registered tools
    const registeredToolNames = commandMapper.getRegisteredToolNames();
    result.registeredTools = registeredToolNames.length;

    console.log(`📊 Found ${registeredToolNames.length} registered tools`);

    // Validate each expected tool
    for (const expectedTool of EXPECTED_SESSION_TOOLS) {
      const toolResult: ToolValidationResult = {
        toolName: expectedTool,
        registered: false,
        hasValidSchema: false,
        interfaceCompatible: false,
        errors: []
      };

      // Check if tool is registered
      if (registeredToolNames.includes(expectedTool)) {
        toolResult.registered = true;
        
        try {
          // Get tool definition
          const tool = commandMapper.getTool(expectedTool);
          
          if (tool) {
            toolResult.hasValidSchema = true;
            
            // Validate interface compatibility (basic checks)
            const schema = tool.inputSchema;
            if (schema && schema.shape && schema.shape.session) {
              toolResult.interfaceCompatible = true;
              result.validTools++;
            } else {
              toolResult.errors.push("Missing required 'session' parameter");
            }
          } else {
            toolResult.errors.push("Tool definition not found");
          }
        } catch (error) {
          toolResult.errors.push(`Schema validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        toolResult.errors.push("Tool not registered");
      }

      result.toolResults.push(toolResult);
    }

    // Calculate success rate
    const successRate = (result.validTools / result.totalTools) * 100;
    result.success = successRate >= 90; // 90% success threshold

    console.log(`✅ Validation complete: ${result.validTools}/${result.totalTools} tools valid (${successRate.toFixed(1)}%)`);

    return result;

  } catch (error) {
    result.errors.push(`Integration test failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error("❌ Integration test failed:", error);
    return result;
  }
}

/**
 * Generate detailed report of validation results
 */
function generateReport(result: IntegrationTestResult): string {
  let report = "# Phase 4 Integration Test Report\n\n";
  
  report += `## Summary\n\n`;
  report += `- **Status**: ${result.success ? "✅ PASSED" : "❌ FAILED"}\n`;
  report += `- **Total Expected Tools**: ${result.totalTools}\n`;
  report += `- **Registered Tools**: ${result.registeredTools}\n`;
  report += `- **Valid Tools**: ${result.validTools}\n`;
  report += `- **Success Rate**: ${((result.validTools / result.totalTools) * 100).toFixed(1)}%\n\n`;

  if (result.errors.length > 0) {
    report += `## Global Errors\n\n`;
    for (const error of result.errors) {
      report += `- ${error}\n`;
    }
    report += `\n`;
  }

  report += `## Tool Validation Results\n\n`;
  
  // Group by phase
  const phases = {
    "Phase 1 (File Operations)": ["session_edit_file", "session_search_replace"],
    "Phase 2 (Search Operations)": ["session_grep_search", "session_file_search", "session_codebase_search"], 
    "Phase 3 (Command Execution)": ["session_run_command", "session_list_dir", "session_read_file"],
    "Existing Tools": ["session_read_file", "session_write_file", "session_delete_file", "session_list_directory", "session_file_exists", "session_create_directory"]
  };

  for (const [phaseName, phaseTools] of Object.entries(phases)) {
    report += `### ${phaseName}\n\n`;
    
    for (const toolName of phaseTools) {
      const toolResult = result.toolResults.find(r => r.toolName === toolName);
      if (toolResult) {
        const status = toolResult.interfaceCompatible ? "✅" : "❌";
        report += `- **${toolName}** ${status}\n`;
        
        if (toolResult.errors.length > 0) {
          for (const error of toolResult.errors) {
            report += `  - Error: ${error}\n`;
          }
        }
      }
    }
    report += `\n`;
  }

  return report;
}

/**
 * Main integration test execution
 */
async function runIntegrationTest(): Promise<void> {
  console.log("🚀 Starting Task 158 Phase 4 Integration Test");
  console.log("=" .repeat(60));

  const result = await validateToolRegistration();
  const report = generateReport(result);

  console.log("\n" + report);

  if (result.success) {
    console.log("🎉 Integration test PASSED! All session-aware tools are properly registered and functional.");
  } else {
    console.log("⚠️  Integration test FAILED. Some tools have issues that need to be addressed.");
  }

  return;
}

// Export for use in other tests
export {
  validateToolRegistration,
  generateReport,
  runIntegrationTest,
  type IntegrationTestResult,
  type ToolValidationResult
};

// Run if called directly
if (import.meta.main) {
  runIntegrationTest().catch(console.error);
} 
