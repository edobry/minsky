import {
  type ContextComponent,
  type ComponentInput,
  type ComponentOutput,
  type ComponentInputs,
} from "./types";
import * as ts from "typescript";
import * as fs from "fs/promises";
import * as path from "path";
import { glob } from "glob";

interface ErrorInfo {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning" | "info";
  source: "typescript" | "eslint" | "runtime";
  code?: string | number;
  category?: string;
}

interface ErrorContextInputs {
  workspacePath: string;
  typeScriptErrors: ErrorInfo[];
  runtimeErrors: ErrorInfo[];
  totalErrors: number;
  totalWarnings: number;
  errorsByFile: Record<string, ErrorInfo[]>;
  errorsByCategory: Record<string, ErrorInfo[]>;
  userPrompt?: string;
  recentErrors?: ErrorInfo[];
  criticalErrors?: ErrorInfo[];
}

export const ErrorContextComponent: ContextComponent = {
  id: "error-context",
  name: "Error Context",
  description: "Live TypeScript errors, diagnostics, and runtime issue detection",

  // Phase 1: Async input gathering (bespoke: dynamic error detection)
  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    const workspacePath = context.workspacePath || process.cwd();
    const userPrompt = context.userQuery;
    const typeScriptErrors: ErrorInfo[] = [];
    const runtimeErrors: ErrorInfo[] = [];

    try {
      // Discover TypeScript files in the workspace
      const tsFiles = await glob("src/**/*.ts", {
        cwd: workspacePath,
        ignore: ["**/*.test.ts", "**/*.d.ts", "**/node_modules/**"],
      });

      // Analyze TypeScript files for compilation errors
      for (const filePath of tsFiles.slice(0, 20)) {
        // Limit to first 20 files for performance
        try {
          const fullPath = path.join(workspacePath, filePath);
          const content = await fs.readFile(fullPath, "utf-8");
          const sourceFile = ts.createSourceFile(fullPath, content, ts.ScriptTarget.Latest, true);

          // Create a TypeScript program to get diagnostics
          const program = ts.createProgram([fullPath], {
            allowJs: true,
            checkJs: false,
            noEmit: true,
            skipLibCheck: true,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.ESNext,
          });

          const diagnostics = ts.getPreEmitDiagnostics(program, sourceFile);

          for (const diagnostic of diagnostics) {
            if (diagnostic.start !== undefined && diagnostic.file) {
              const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);

              // Convert diagnostic message to string
              let message: string;
              if (typeof diagnostic.messageText === "string") {
                message = diagnostic.messageText;
              } else {
                message = diagnostic.messageText.messageText;
              }

              // Categorize error types
              let category = "general";
              if (message.includes("Cannot find name")) category = "undefined-variable";
              else if (message.includes("Type '") && message.includes("is not assignable"))
                category = "type-mismatch";
              else if (message.includes("Cannot find module")) category = "import-error";
              else if (
                message.includes("Parameter") &&
                message.includes("implicitly has an 'any' type")
              )
                category = "missing-types";

              typeScriptErrors.push({
                file: filePath,
                line: position.line + 1,
                column: position.character + 1,
                message,
                severity: diagnostic.category === ts.DiagnosticCategory.Error ? "error" : "warning",
                source: "typescript",
                code: diagnostic.code,
                category,
              });
            }
          }
        } catch (fileError) {
          // Add runtime error for files that can't be processed
          runtimeErrors.push({
            file: filePath,
            line: 1,
            column: 1,
            message: `Failed to analyze file: ${fileError instanceof Error ? fileError.message : String(fileError)}`,
            severity: "warning",
            source: "runtime",
            category: "analysis-error",
          });
        }
      }

      // Group errors by file and category
      const errorsByFile: Record<string, ErrorInfo[]> = {};
      const errorsByCategory: Record<string, ErrorInfo[]> = {};
      const allErrors = [...typeScriptErrors, ...runtimeErrors];

      for (const error of allErrors) {
        // Group by file
        if (!errorsByFile[error.file]) errorsByFile[error.file] = [];
        errorsByFile[error.file].push(error);

        // Group by category
        const category = error.category || "other";
        if (!errorsByCategory[category]) errorsByCategory[category] = [];
        errorsByCategory[category].push(error);
      }

      // Filter for critical and recent errors
      const criticalErrors = allErrors.filter(
        (error) =>
          error.severity === "error" ||
          error.category === "undefined-variable" ||
          error.category === "import-error"
      );

      // Apply user prompt filtering if provided
      let recentErrors: ErrorInfo[] | undefined;
      if (userPrompt) {
        const promptLower = userPrompt.toLowerCase();
        recentErrors = allErrors.filter((error) => {
          return (
            error.message.toLowerCase().includes(promptLower) ||
            error.file.toLowerCase().includes(promptLower) ||
            error.category?.toLowerCase().includes(promptLower)
          );
        });
      }

      const totalErrors = allErrors.filter((e) => e.severity === "error").length;
      const totalWarnings = allErrors.filter((e) => e.severity === "warning").length;

      return {
        workspacePath,
        typeScriptErrors,
        runtimeErrors,
        totalErrors,
        totalWarnings,
        errorsByFile,
        errorsByCategory,
        userPrompt,
        recentErrors,
        criticalErrors,
      } as ErrorContextInputs;
    } catch (error) {
      // Fallback with error information
      return {
        workspacePath,
        typeScriptErrors: [],
        runtimeErrors: [
          {
            file: "error-context-component",
            line: 1,
            column: 1,
            message: `Failed to analyze errors: ${error instanceof Error ? error.message : String(error)}`,
            severity: "error",
            source: "runtime",
            category: "component-error",
          },
        ],
        totalErrors: 1,
        totalWarnings: 0,
        errorsByFile: {},
        errorsByCategory: {},
        userPrompt,
      } as ErrorContextInputs;
    }
  },

  // Phase 2: Pure rendering with error information
  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const errorInputs = inputs as ErrorContextInputs;

    let content = `## Error Context\n\n`;

    // Overview
    content += `### Error Summary\n`;
    content += `- **Workspace**: ${errorInputs.workspacePath}\n`;
    content += `- **Total Errors**: ${errorInputs.totalErrors}\n`;
    content += `- **Total Warnings**: ${errorInputs.totalWarnings}\n`;
    content += `- **Files with Issues**: ${Object.keys(errorInputs.errorsByFile).length}\n`;

    if (errorInputs.userPrompt && errorInputs.recentErrors) {
      content += `- **Filtered by "${errorInputs.userPrompt}"**: ${errorInputs.recentErrors.length} issues\n`;
    }

    content += `\n`;

    // Critical errors section
    if (errorInputs.criticalErrors && errorInputs.criticalErrors.length > 0) {
      content += `### 🚨 Critical Errors (${errorInputs.criticalErrors.length})\n\n`;
      const displayCritical = errorInputs.criticalErrors.slice(0, 5);

      for (const error of displayCritical) {
        content += `#### ${error.file}:${error.line}:${error.column}\n`;
        content += `**${error.severity.toUpperCase()}**: ${error.message}\n`;
        content += `- **Source**: ${error.source}\n`;
        content += `- **Category**: ${error.category || "general"}\n`;
        if (error.code) content += `- **Code**: ${error.code}\n`;
        content += `\n`;
      }

      if (errorInputs.criticalErrors.length > 5) {
        content += `*Showing first 5 critical errors. ${errorInputs.criticalErrors.length - 5} more critical errors exist.*\n\n`;
      }
    }

    // Error categories breakdown
    if (Object.keys(errorInputs.errorsByCategory).length > 0) {
      content += `### Error Categories\n`;
      const categories = Object.entries(errorInputs.errorsByCategory).sort(
        ([, a], [, b]) => b.length - a.length
      );

      for (const [category, errors] of categories) {
        const errorCount = errors.filter((e) => e.severity === "error").length;
        const warningCount = errors.filter((e) => e.severity === "warning").length;
        content += `- **${category}**: ${errorCount} errors, ${warningCount} warnings\n`;
      }
      content += `\n`;
    }

    // File-specific errors (if user prompt specified or few files)
    const relevantFiles = errorInputs.recentErrors
      ? Object.keys(errorInputs.errorsByFile).filter((file) =>
          errorInputs.recentErrors!.some((e) => e.file === file)
        )
      : Object.keys(errorInputs.errorsByFile).slice(0, 3);

    if (relevantFiles.length > 0) {
      content += `### Files with Issues\n\n`;

      for (const filePath of relevantFiles) {
        const fileErrors = errorInputs.errorsByFile[filePath] || [];
        const fileErrorCount = fileErrors.filter((e) => e.severity === "error").length;
        const fileWarningCount = fileErrors.filter((e) => e.severity === "warning").length;

        content += `#### ${filePath}\n`;
        content += `${fileErrorCount} errors, ${fileWarningCount} warnings\n\n`;

        // Show first few errors for this file
        const displayErrors = fileErrors.slice(0, 3);
        for (const error of displayErrors) {
          content += `- **Line ${error.line}**: ${error.message}\n`;
        }

        if (fileErrors.length > 3) {
          content += `- ... and ${fileErrors.length - 3} more issues\n`;
        }
        content += `\n`;
      }
    }

    // Development recommendations
    content += `### Development Recommendations\n`;

    if (errorInputs.totalErrors === 0 && errorInputs.totalWarnings === 0) {
      content += `✅ **Clean codebase**: No TypeScript errors or warnings detected\n`;
      content += `- Code appears to be in good health\n`;
      content += `- Continue maintaining code quality standards\n`;
    } else {
      content += `🔧 **Priority Actions**:\n`;

      if (errorInputs.criticalErrors && errorInputs.criticalErrors.length > 0) {
        content += `1. **Address critical errors first** - ${errorInputs.criticalErrors.length} issues need immediate attention\n`;
      }

      if (errorInputs.errorsByCategory["undefined-variable"]) {
        content += `2. **Fix undefined variables** - ${errorInputs.errorsByCategory["undefined-variable"].length} naming/import issues\n`;
      }

      if (errorInputs.errorsByCategory["type-mismatch"]) {
        content += `3. **Resolve type mismatches** - ${errorInputs.errorsByCategory["type-mismatch"].length} type safety issues\n`;
      }

      if (errorInputs.errorsByCategory["import-error"]) {
        content += `4. **Fix import errors** - ${errorInputs.errorsByCategory["import-error"].length} module resolution issues\n`;
      }

      content += `5. **Run type checker**: Use \`tsc --noEmit\` for full error detection\n`;
      content += `6. **Run linter**: Use \`eslint --fix\` for automated fixes\n`;
    }

    // Context-specific guidance
    if (errorInputs.userPrompt) {
      content += `\n### Context-Specific Guidance\n`;
      const promptLower = errorInputs.userPrompt.toLowerCase();

      if (promptLower.includes("test")) {
        content += `- **Testing focus**: Check for test-related imports and mocking issues\n`;
      }
      if (promptLower.includes("import") || promptLower.includes("module")) {
        content += `- **Import focus**: Review module resolution and dependency paths\n`;
      }
      if (promptLower.includes("type")) {
        content += `- **Type focus**: Examine TypeScript configuration and type definitions\n`;
      }
    }

    return {
      content,
      metadata: {
        componentId: this.id,
        generatedAt: new Date().toISOString(),
        tokenCount: Math.floor(content.length / 4), // rough token estimate
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const gatheredInputs = await this.gatherInputs(input);
    return this.render(gatheredInputs, input);
  },
};

export function createErrorContextComponent(): ContextComponent {
  return ErrorContextComponent;
}
