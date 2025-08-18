import type { CommandMapper } from "../../src/mcp/command-mapper.js";
import { dirname } from "path";
import {
  mockFiles,
  createMockFile,
  getMockFile,
} from "./session-edit-file-cursor-parity.integration.test";

// Mock SessionPathResolver
class MockSessionPathResolver {
  async resolvePath(sessionName: string, path: string): Promise<string> {
    // Basic path traversal protection
    if (path.includes("..")) {
      const mockSessionPath = `/mock/sessions/${sessionName}`;
      const resolvedPath = require("path").resolve(mockSessionPath, path);
      if (!resolvedPath.startsWith(mockSessionPath)) {
        throw new Error(
          `Path "${path}" resolves outside session workspace. Session workspace: ${mockSessionPath}, Resolved path: ${resolvedPath}`
        );
      }
    }
    return `${sessionName}/${path}`;
  }
}

const mockPathResolver = new MockSessionPathResolver();

// Enhanced applyEditPattern with comprehensive logging
async function loggingApplyEditPattern(
  originalContent: string,
  editPattern: string,
  instruction?: string
): Promise<string> {
  console.log(`\n${"=".repeat(80)}`);
  console.log("🔍 MORPH API REQUEST ANALYSIS");
  console.log("=".repeat(80));

  console.log("\n📋 INPUT PARAMETERS:");
  console.log("📄 Original Content:");
  console.log("   Length:", originalContent.length, "characters");
  console.log("   Content:", JSON.stringify(originalContent, null, 2));

  console.log("\n📝 Edit Pattern:");
  console.log("   Length:", editPattern.length, "characters");
  console.log("   Content:", JSON.stringify(editPattern, null, 2));

  if (instruction) {
    console.log("\n🧭 Instruction:");
    console.log("   ", instruction);
  }

  console.log("\n🔍 PATTERN ANALYSIS:");
  const hasExistingCodeMarkers = editPattern.includes("// ... existing code ...");
  console.log("   Contains '// ... existing code ...' markers:", hasExistingCodeMarkers);

  if (hasExistingCodeMarkers) {
    const parts = editPattern.split("// ... existing code ...");
    console.log("   Number of parts after splitting on markers:", parts.length);
    parts.forEach((part, index) => {
      console.log(`   Part ${index + 1}:`, JSON.stringify(part.trim()));
    });
  }

  console.log("\n🚀 RECREATING MORPH API CALL...");
  const startTime = Date.now();

  try {
    // Recreate the logic from the actual applyEditPattern function with logging
    // Use the same import pattern as session-edit-tools.ts
    const { DefaultAICompletionService } = await import(
      "../../src/domain/ai/completion-service.js"
    );
    const { getConfiguration } = await import("../../src/domain/configuration/index.js");

    const config = getConfiguration();
    console.log("\n📋 AI CONFIGURATION:");
    console.log("   Config loaded:", !!config);
    console.log("   AI providers:", Object.keys(config.ai?.providers || {}));

    const aiConfig = config.ai;
    if (!aiConfig?.providers) {
      throw new Error("No AI providers configured for edit operations");
    }

    // Find fast-apply capable provider (currently Morph, extendable to others)
    const fastApplyProviders = Object.entries(aiConfig.providers)
      .filter(
        ([name, providerConfig]) => providerConfig?.enabled && name === "morph" // Add other fast-apply providers here as needed
      )
      .map(([name]) => name);

    let provider: string;
    let model: string | undefined;
    let isFastApply = false;

    if (fastApplyProviders.length > 0) {
      provider = fastApplyProviders[0]; // Use the first available fast-apply provider
      model = aiConfig.providers[provider]?.model;
      isFastApply = true;
      console.log(`   Using fast-apply provider: ${provider} with model: ${model}`);
    } else {
      // Fallback to any enabled provider
      const enabledProviders = Object.entries(aiConfig.providers)
        .filter(([, providerConfig]) => providerConfig?.enabled)
        .map(([name]) => name);

      if (enabledProviders.length === 0) {
        throw new Error("No enabled AI providers found for edit operations");
      }

      provider = enabledProviders[0];
      model = aiConfig.providers[provider]?.model;
      console.log(`   Using fallback provider: ${provider} with model: ${model}`);
    }

    // Create completion service
    const completionService = new DefaultAICompletionService();

    // Create the prompt that will be sent to Morph
    const prompt = `You are an expert code editor. Apply the following edit pattern to the original code.

ORIGINAL CODE:
\`\`\`
${originalContent}
\`\`\`

EDIT PATTERN:
\`\`\`
${editPattern}
\`\`\`

Instructions:
1. Replace "// ... existing code ..." markers with the actual existing code from the original
2. Merge the new code with the existing code as indicated by the pattern
3. Return ONLY the final, complete code - no explanations or markdown
4. Preserve all original code that isn't being replaced
5. The result should contain both the original code and the new additions

${instruction ? `6. Apply this additional guidance precisely: ${instruction}` : ""}

Return the complete merged code:`;

    console.log("\n📤 PROMPT BEING SENT TO MORPH:");
    console.log("   Prompt length:", prompt.length, "characters");
    console.log("   Prompt content:", JSON.stringify(prompt, null, 2));

    // Make the actual API call
    console.log("\n🌐 CALLING MORPH API...");
    const response = await completionService.createCompletion([{ role: "user", content: prompt }], {
      provider,
      model,
      temperature: 0.1, // Lower temperature for more consistent edits
    });

    const duration = Date.now() - startTime;
    const result = response.content;

    console.log("\n✅ MORPH API RESPONSE:");
    console.log("   Duration:", duration, "ms");
    console.log("   Response type:", typeof response);
    console.log("   Response keys:", Object.keys(response));
    console.log("   Response content length:", result.length, "characters");
    console.log("   Response content:", JSON.stringify(result, null, 2));

    console.log("\n📊 RESULT ANALYSIS:");
    console.log("   Original length:", originalContent.length);
    console.log("   Edit pattern length:", editPattern.length);
    console.log("   Result length:", result.length);
    console.log(
      "   Result vs Original ratio:",
      `${(result.length / originalContent.length).toFixed(2)}x`
    );
    console.log(
      "   Result vs Pattern ratio:",
      `${(result.length / editPattern.length).toFixed(2)}x`
    );

    // Check if result contains both original and new content
    const originalLines = originalContent.split("\n").filter((line) => line.trim());
    const resultLines = result.split("\n");
    const containsOriginalContent = originalLines.some((line) =>
      resultLines.some((resultLine) => resultLine.includes(line.trim()))
    );
    console.log("   Contains original content lines:", containsOriginalContent);

    // Check for specific content
    console.log("\n🔍 DETAILED CONTENT ANALYSIS:");
    console.log("   Result contains 'add' method:", result.includes("add("));
    console.log("   Result contains 'multiply' method:", result.includes("multiply("));
    console.log(
      "   Result contains original class structure:",
      result.includes("export class Calculator")
    );

    console.log("\n🔍 DETAILED COMPARISON:");
    console.log(
      "   Expected behavior: Result should be longer than edit pattern if merging worked"
    );
    console.log(
      "   Actual behavior:",
      result.length > editPattern.length ? "✅ Longer (correct)" : "❌ Shorter/equal (incorrect)"
    );

    if (result.length <= editPattern.length) {
      console.log("   🚨 POTENTIAL BUG: Result is not longer than edit pattern!");
      console.log(
        "   This suggests the AI returned a cleaned edit pattern instead of merging with original content"
      );

      console.log("\n🔍 DEBUGGING ANALYSIS:");
      console.log(
        "   Does result match edit pattern exactly?",
        result.trim() === editPattern.replace(/\/\/ \.\.\. existing code \.\.\./g, "").trim()
      );
      console.log(
        "   Edit pattern without markers:",
        JSON.stringify(editPattern.replace(/\/\/ \.\.\. existing code \.\.\./g, ""))
      );
    }

    console.log("=".repeat(80));
    console.log("🔚 END MORPH API ANALYSIS");
    console.log(`${"=".repeat(80)}\n`);

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    console.log("\n❌ MORPH API ERROR:");
    console.log("   Duration:", duration, "ms");
    console.log("   Error type:", error.constructor.name);
    console.log("   Error message:", error.message);
    console.log("   Error stack:", error.stack);
    console.log("=".repeat(80));
    console.log("🔚 END MORPH API ANALYSIS (ERROR)");
    console.log(`${"=".repeat(80)}\n`);
    throw error;
  }
}

// Mock fs functions to use in-memory file system
require("fs/promises").readFile = async (path: string, encoding?: string) => {
  console.log("📖 Mock readFile:", path);
  const content = getMockFile("", path); // Extract session from path
  if (!content) {
    const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
    (error as any).code = "ENOENT";
    throw error;
  }
  return encoding === "utf8" ? content : Buffer.from(content);
};

require("fs/promises").writeFile = async (
  path: string,
  data: string | Buffer,
  encoding?: string
) => {
  console.log(`📝 Mock wrote file: ${path} (${data.length} chars)`);
  const content = typeof data === "string" ? data : data.toString();

  // Extract session name from path
  const sessionMatch = path.match(/^([^/]+)\//);
  const sessionName = sessionMatch ? sessionMatch[1] : "";
  const filePath = sessionMatch ? path.substring(sessionMatch[1].length + 1) : path;

  createMockFile(sessionName, filePath, content);
  return Promise.resolve();
};

require("fs/promises").mkdir = async (path: string, options?: any) => {
  console.log("📁 Mock created directory:", path);
  return Promise.resolve();
};

require("fs/promises").stat = async (path: string) => {
  console.log("📊 Mock stat:", path);
  const content = getMockFile("", path);
  if (!content) {
    const error = new Error(`ENOENT: no such file or directory, stat '${path}'`);
    (error as any).code = "ENOENT";
    throw error;
  }
  return {
    isFile: () => true,
    isDirectory: () => false,
    size: content.length,
    mtime: new Date(),
    ctime: new Date(),
    atime: new Date(),
  };
};

export function registerMockSessionEditTools(commandMapper: CommandMapper): void {
  console.log("📋 Registering mock session edit tools with enhanced logging");

  // Register session.edit_file tool with enhanced logging
  commandMapper.register("session.edit_file", {
    description: "Edit a file within a session workspace with comprehensive logging",
    inputSchema: {
      type: "object",
      properties: {
        sessionName: { type: "string", description: "Session identifier" },
        path: { type: "string", description: "Path to the file within the session workspace" },
        instructions: { type: "string", description: "Instructions describing the edit to make" },
        content: {
          type: "string",
          description: "The edit content with '// ... existing code ...' markers",
        },
        createDirs: {
          type: "boolean",
          description: "Create parent directories if they don't exist",
          default: true,
        },
      },
      required: ["sessionName", "path", "instructions", "content"],
    },
    handler: async (args: any) => {
      try {
        const resolvedPath = await mockPathResolver.resolvePath(args.sessionName, args.path);

        // Check if file exists
        let originalContent = "";
        let fileExists = false;

        try {
          originalContent = getMockFile(args.sessionName, args.path) || "";
          fileExists = !!originalContent;
        } catch (error) {
          fileExists = false;
        }

        console.log(
          `📄 File exists: ${fileExists}, Original content length: ${originalContent.length}`
        );

        // Validate edit pattern for non-existent files
        if (!fileExists && args.content.includes("// ... existing code ...")) {
          throw new Error(
            `Cannot apply edits with existing code markers to non-existent file: ${args.path}`
          );
        }

        let finalContent: string;
        const startTime = Date.now();

        if (fileExists && args.content.includes("// ... existing code ...")) {
          // Use enhanced logging version of applyEditPattern
          finalContent = await loggingApplyEditPattern(
            originalContent,
            args.content,
            args.instructions
          );
        } else {
          finalContent = args.content;
        }

        const duration = Date.now() - startTime;

        // Create directories if needed
        if (args.createDirs) {
          // Mock directory creation - already handled in writeFile mock
        }

        // Write the file using mock file system
        createMockFile(args.sessionName, args.path, finalContent);

        console.log(`✅ Edit completed in ${duration}ms`);

        return {
          success: true,
          timestamp: new Date().toISOString(),
          path: args.path,
          session: args.sessionName,
          edited: fileExists,
          created: !fileExists,
          bytesWritten: finalContent.length,
          duration,
        };
      } catch (error) {
        console.log("Mock session file edit failed", {
          session: args.sessionName,
          path: args.path,
          error: error instanceof Error ? error.message : String(error),
        });

        return {
          success: false,
          timestamp: new Date().toISOString(),
          path: args.path,
          session: args.sessionName,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  // Register session.search_replace tool (minimal logging for now)
  commandMapper.register("session.search_replace", {
    description: "Replace text in a file within a session workspace",
    inputSchema: {
      type: "object",
      properties: {
        sessionName: { type: "string", description: "Session identifier" },
        path: { type: "string", description: "Path to the file within the session workspace" },
        search: { type: "string", description: "Text to search for" },
        replace: { type: "string", description: "Text to replace with" },
      },
      required: ["sessionName", "path", "search", "replace"],
    },
    handler: async (args: any) => {
      try {
        const resolvedPath = await mockPathResolver.resolvePath(args.sessionName, args.path);

        const originalContent = getMockFile(args.sessionName, args.path);
        if (!originalContent) {
          throw new Error(`File not found: ${args.path}`);
        }

        const newContent = originalContent.replace(args.search, args.replace);
        createMockFile(args.sessionName, args.path, newContent);

        return {
          success: true,
          timestamp: new Date().toISOString(),
          path: args.path,
          session: args.sessionName,
          replacements: originalContent === newContent ? 0 : 1,
        };
      } catch (error) {
        return {
          success: false,
          timestamp: new Date().toISOString(),
          path: args.path,
          session: args.sessionName,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  console.log("📋 Mock session edit tools registered successfully");
}
