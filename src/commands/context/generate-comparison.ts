/**
 * Model comparison functions for the generate command
 *
 * Handles cross-model context comparison and display.
 */

import { log } from "../../utils/logger";
import { TaskStatus } from "../../domain/tasks/taskConstants";
import type {
  GenerateRequest,
  GenerateOptions,
  AnalysisResult,
  ComponentBreakdown,
} from "./generate-types";
import { generateContext, getDefaultComponents } from "./generate-core";
import { first } from "../../utils/array-safety";
import { analyzeGeneratedContext } from "./generate-analysis";
import { displayContextVisualization } from "./generate-visualization";

export async function displayModelComparison(models: string[], options: GenerateOptions) {
  log.cli("\n🔄 Cross-Model Comparison");
  log.cli("━".repeat(80));

  const requestedComponents = options.components
    ? options.components.split(",").map((c) => c.trim())
    : getDefaultComponents();

  const comparisons: Array<{ model: string; result: AnalysisResult }> = [];

  for (const model of models) {
    try {
      const request: GenerateRequest = {
        components: requestedComponents,
        input: {
          environment: {
            os: `${process.platform} ${process.arch}`,
            shell: process.env.SHELL || "unknown",
          },
          workspacePath: process.cwd(),
          task: {
            id: "mt#461",
            title: "Context Visualization Redesign",
            status: TaskStatus.IN_PROGRESS,
            spec: "Implementing context visualization using new component architecture",
          },
          userQuery: options.prompt || "Generating context visualization analysis",
          userPrompt: options.prompt,
          targetModel: model.trim(),
          interfaceConfig: {
            interface: options.interface || "cli",
            mcpEnabled: options.interface === "mcp" || options.interface === "hybrid",
            preferMcp: options.interface === "mcp",
          },
        },
      };

      const result = await generateContext(request);
      const analysisResult = await analyzeGeneratedContext(result, {
        ...options,
        model: model.trim(),
      });
      comparisons.push({ model: model.trim(), result: analysisResult });
    } catch (error) {
      log.cli(`❌ Failed to analyze for ${model}: ${error}`);
    }
  }

  if (comparisons.length > 1) {
    log.cli(
      "Model".padEnd(25) +
        "Tokens".padStart(10) +
        "Components".padStart(12) +
        "Utilization".padStart(12)
    );
    log.cli("-".repeat(59));

    comparisons.forEach(({ model, result }) => {
      const utilization = result.summary.contextWindowUtilization.toFixed(1);
      log.cli(
        model.padEnd(25) +
          result.summary.totalTokens.toLocaleString().padStart(10) +
          result.summary.totalComponents.toString().padStart(12) +
          `${utilization}%`.padStart(12)
      );
    });

    log.cli("\n📊 Component Comparison");
    log.cli("━".repeat(80));

    const allComponents = new Set();
    comparisons.forEach(({ result }) => {
      result.componentBreakdown.forEach((comp: ComponentBreakdown) =>
        allComponents.add(comp.component)
      );
    });

    Array.from(allComponents).forEach((componentName) => {
      log.cli(`\n${componentName}:`);
      comparisons.forEach(({ model, result }) => {
        const comp = result.componentBreakdown.find(
          (c: ComponentBreakdown) => c.component === componentName
        );
        if (comp) {
          log.cli(
            `  ${model.padEnd(20)} ${comp.tokens.toLocaleString().padStart(8)} tokens (${comp.percentage}%)`
          );
        } else {
          log.cli(`  ${model.padEnd(20)}        0 tokens (0.0%)`);
        }
      });
    });

    if (options.visualize && comparisons.length > 0) {
      const firstComparison = first(comparisons, "comparisons");
      log.cli(`\n📊 Visualization for ${firstComparison.model}`);
      displayContextVisualization(firstComparison.result, options);
    }
  }
}
