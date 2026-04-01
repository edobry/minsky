/**
 * Visualization functions for the generate command
 *
 * Handles chart rendering (bar, pie, tree) and detailed breakdowns.
 */

import { log } from "../../utils/logger";
import type { GenerateOptions } from "./generate-types";

/**
 * Generate visualization data structure for JSON output
 */
export function generateVisualizationData(analysisResult: any, options: GenerateOptions) {
  const { chartType, maxWidth } = options;

  return {
    chartType: chartType || "bar",
    maxWidth: parseInt(maxWidth || "80"),
    elements: analysisResult.componentBreakdown.map((component: any) => ({
      type: "component",
      name: component.component,
      tokens: component.tokens,
      percentage: component.percentage,
    })),
    typeBreakdown: {
      components: {
        count: analysisResult.componentBreakdown.length,
        tokens: analysisResult.summary.totalTokens,
      },
    },
  };
}

/**
 * Display context visualization to the console
 */
export function displayContextVisualization(analysisResult: any, options: GenerateOptions) {
  const { chartType, maxWidth, showDetails } = options;
  const width = parseInt(maxWidth || "80");

  log.cli("\n🎨 Context Visualization");
  log.cli("━".repeat(Math.min(width, 80)));
  log.cli(`Total Tokens: ${analysisResult.summary.totalTokens.toLocaleString()}`);
  log.cli(
    `Context Window Utilization: ${analysisResult.summary.contextWindowUtilization.toFixed(1)}%`
  );
  log.cli(`Total Components: ${analysisResult.summary.totalComponents}`);
  log.cli(`Model: ${analysisResult.metadata.model}`);

  switch (chartType) {
    case "bar":
      displayBarChart(analysisResult, width);
      break;
    case "pie":
      displayPieChart(analysisResult, width);
      break;
    case "tree":
      displayTreeView(analysisResult, width);
      break;
    default:
      displayBarChart(analysisResult, width);
  }

  if (showDetails) {
    displayDetailedBreakdown(analysisResult);
  }
}

function displayBarChart(analysisResult: any, width: number) {
  log.cli("\n📊 Token Distribution (Bar Chart)");
  log.cli("━".repeat(Math.min(width, 80)));

  const components = analysisResult.componentBreakdown;
  const maxTokens = Math.max(...components.map((c: any) => c.tokens));
  const barWidth = Math.min(width - 30, 50);

  components.forEach((component: any) => {
    const percentage = component.percentage;
    const barLength = Math.round((component.tokens / maxTokens) * barWidth);
    const bar = "█".repeat(barLength) + "░".repeat(barWidth - barLength);

    log.cli(
      `${component.component.padEnd(20)} │${bar}│ ${component.tokens.toLocaleString().padStart(8)} (${percentage}%)`
    );
  });
}

function displayPieChart(analysisResult: any, width: number) {
  log.cli("\n🥧 Token Distribution (Pie Chart)");
  log.cli("━".repeat(Math.min(width, 80)));

  const components = analysisResult.componentBreakdown;

  // Simple ASCII pie representation
  components.forEach((component: any) => {
    const percentage = parseFloat(component.percentage);
    const segmentSize = Math.round(percentage / 5); // Each ● represents ~5%
    const visual = "●".repeat(segmentSize) + "○".repeat(20 - segmentSize);
    log.cli(
      `${component.component.padEnd(20)} ${visual} ${component.percentage}% (${component.tokens.toLocaleString()} tokens)`
    );
  });
}

function displayTreeView(analysisResult: any, width: number) {
  log.cli("\n🌳 Context Component Hierarchy");
  log.cli("━".repeat(Math.min(width, 80)));

  const components = analysisResult.componentBreakdown;

  // Group components by logical categories
  const groups = groupComponentsByCategory(components, analysisResult);

  groups.forEach((group, groupIndex) => {
    const isLastGroup = groupIndex === groups.length - 1;
    const groupConnector = isLastGroup ? "└── " : "├── ";

    log.cli(
      `${groupConnector}${group.name} (${group.totalTokens.toLocaleString()} tokens, ${group.percentage.toFixed(1)}%)`
    );

    group.components.forEach((component: any, compIndex: number) => {
      const isLastComponent = compIndex === group.components.length - 1;
      const componentConnector = isLastGroup
        ? isLastComponent
          ? "    └── "
          : "    ├── "
        : isLastComponent
          ? "│   └── "
          : "│   ├── ";

      log.cli(
        `${componentConnector}${component.component} (${component.tokens.toLocaleString()} tokens, ${component.percentage}%)`
      );

      // Show sub-components if available
      if (component.subComponents && component.subComponents.length > 0) {
        component.subComponents.forEach((subComp: any, subIndex: number) => {
          const isLastSub = subIndex === component.subComponents.length - 1;
          const subConnector = isLastGroup
            ? isLastComponent
              ? isLastSub
                ? "        └── "
                : "        ├── "
              : isLastSub
                ? "    │   └── "
                : "    │   ├── "
            : isLastComponent
              ? isLastSub
                ? "│       └── "
                : "│       ├── "
              : isLastSub
                ? "│   │   └── "
                : "│   │   ├── ";

          log.cli(
            `${subConnector}${subComp.name}${subComp.description ? ` - ${subComp.description}` : ""}`
          );
        });
      }
    });
  });
}

function parseComponentContent(componentId: string, analysisResult?: any): any[] {
  if (!analysisResult?.fullResult?.components) {
    return [];
  }

  // Find the full component content
  const fullComponent = analysisResult.fullResult.components.find(
    (comp: any) => comp.component_id === componentId
  );

  if (!fullComponent?.content) {
    return [];
  }

  const content = fullComponent.content;
  const subComponents: any[] = [];

  try {
    switch (componentId) {
      case "tool-schemas": {
        // Parse JSON tool schemas
        if (content.includes("Here are the functions available in JSONSchema format:")) {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const toolSchemas = JSON.parse(jsonMatch[0]);
            Object.keys(toolSchemas).forEach((toolName) => {
              const tool = toolSchemas[toolName];
              subComponents.push({
                name: toolName,
                description: tool.description
                  ? tool.description.substring(0, 60) + (tool.description.length > 60 ? "..." : "")
                  : "No description",
              });
            });
          }
        }
        break;
      }

      case "workspace-rules": {
        // Parse rule sections
        const ruleSections = content.split(/^#\s+/m).filter((section: string) => section.trim());
        ruleSections.forEach((section: string) => {
          const lines = section.split("\n");
          const title = lines[0]?.trim();
          if (title && title !== "workspace-rules") {
            subComponents.push({
              name: title.replace(/^#+\s*/, ""),
              description: "Workspace rule",
            });
          }
        });
        break;
      }

      case "environment": {
        // Parse environment details
        const envLines = content.split("\n").filter((line: string) => line.includes(":"));
        envLines.forEach((line: string) => {
          const [key, value] = line.split(":");
          if (key && value) {
            subComponents.push({
              name: key.trim(),
              description: value.trim().substring(0, 30),
            });
          }
        });
        break;
      }

      default: {
        // Generic parsing - look for headers
        const headers = content.match(/^#+\s+(.+)$/gm);
        if (headers && headers.length > 1) {
          headers.slice(1, 6).forEach((header: string) => {
            // Limit to 5
            const title = header.replace(/^#+\s*/, "").trim();
            subComponents.push({
              name: title.substring(0, 40) + (title.length > 40 ? "..." : ""),
              description: "Section",
            });
          });
        }
        break;
      }
    }
  } catch (error) {
    // If parsing fails, don't show sub-components
  }

  return subComponents.slice(0, 8); // Limit to 8 sub-components
}

function groupComponentsByCategory(components: any[], analysisResult?: any) {
  const totalTokens = components.reduce((sum: number, comp: any) => sum + comp.tokens, 0);

  // Parse component content to extract sub-components
  const enrichedComponents = components.map((comp: any) => ({
    ...comp,
    subComponents: parseComponentContent(comp.component, analysisResult),
  }));

  // Define logical groupings based on component purpose
  const environmentComponents = enrichedComponents.filter((c) =>
    ["environment", "project-context", "session-context"].includes(c.component)
  );

  const rulesComponents = enrichedComponents.filter((c) =>
    [
      "workspace-rules",
      "system-instructions",
      "communication",
      "tool-calling-rules",
      "maximize-parallel-tool-calls",
      "maximize-context-understanding",
      "making-code-changes",
      "code-citation-format",
      "task-management",
    ].includes(c.component)
  );

  const toolsComponents = enrichedComponents.filter((c) => ["tool-schemas"].includes(c.component));

  const dataComponents = enrichedComponents.filter((c) =>
    [
      "file-content",
      "error-context",
      "test-context",
      "dependency-context",
      "conversation-history",
    ].includes(c.component)
  );

  // Collect any components that don't fit the above categories
  const categorizedComponents = [
    ...environmentComponents,
    ...rulesComponents,
    ...toolsComponents,
    ...dataComponents,
  ].map((comp) => comp.component);

  const otherComponents = enrichedComponents.filter(
    (c) => !categorizedComponents.includes(c.component)
  );

  const groups: Array<{
    name: string;
    totalTokens: number;
    percentage: number;
    components: any[];
  }> = [];

  if (environmentComponents.length > 0) {
    const groupTokens = environmentComponents.reduce(
      (sum: number, comp: any) => sum + comp.tokens,
      0
    );
    groups.push({
      name: "Environment & Context",
      totalTokens: groupTokens,
      percentage: (groupTokens / totalTokens) * 100,
      components: environmentComponents.sort((a: any, b: any) => b.tokens - a.tokens),
    });
  }

  if (rulesComponents.length > 0) {
    const groupTokens = rulesComponents.reduce((sum: number, comp: any) => sum + comp.tokens, 0);
    groups.push({
      name: "Rules & Guidelines",
      totalTokens: groupTokens,
      percentage: (groupTokens / totalTokens) * 100,
      components: rulesComponents.sort((a: any, b: any) => b.tokens - a.tokens),
    });
  }

  if (toolsComponents.length > 0) {
    const groupTokens = toolsComponents.reduce((sum: number, comp: any) => sum + comp.tokens, 0);
    groups.push({
      name: "Tools & Schemas",
      totalTokens: groupTokens,
      percentage: (groupTokens / totalTokens) * 100,
      components: toolsComponents.sort((a: any, b: any) => b.tokens - a.tokens),
    });
  }

  if (dataComponents.length > 0) {
    const groupTokens = dataComponents.reduce((sum: number, comp: any) => sum + comp.tokens, 0);
    groups.push({
      name: "Dynamic Data & Content",
      totalTokens: groupTokens,
      percentage: (groupTokens / totalTokens) * 100,
      components: dataComponents.sort((a: any, b: any) => b.tokens - a.tokens),
    });
  }

  if (otherComponents.length > 0) {
    const groupTokens = otherComponents.reduce((sum: number, comp: any) => sum + comp.tokens, 0);
    groups.push({
      name: "Other Components",
      totalTokens: groupTokens,
      percentage: (groupTokens / totalTokens) * 100,
      components: otherComponents.sort((a: any, b: any) => b.tokens - a.tokens),
    });
  }

  // Sort groups by token count (largest first)
  return groups.sort((a, b) => b.totalTokens - a.totalTokens);
}

function displayDetailedBreakdown(analysisResult: any) {
  log.cli("\n📋 Detailed Component Breakdown");
  log.cli("━".repeat(80));

  const topComponents = analysisResult.componentBreakdown.slice(0, 10);

  topComponents.forEach((component: any, index: number) => {
    log.cli(`${(index + 1).toString().padStart(2)}. ${component.component}`);
    log.cli(`    Tokens: ${component.tokens.toLocaleString()} (${component.percentage}%)`);
    log.cli(`    Characters: ${component.content_length.toLocaleString()}`);
    log.cli("");
  });
}
