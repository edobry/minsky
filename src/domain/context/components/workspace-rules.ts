import type { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";
import type { Rule } from "../../rules/types";
import { suggestRules, groupRulesByType } from "../../rules/rule-suggestion-enhanced";
import { createRuleSimilarityService } from "../../rules/rule-similarity-service";
import { createLogger } from "../../../utils/logger";

const log = createLogger("workspace-rules");

/**
 * Workspace Rules Component
 *
 * Provides workspace-level rules in Cursor's exact format.
 * This replicates how Cursor presents workspace rules to AI assistants.
 *
 * Enhanced with context-aware filtering using rule types:
 * - Always Apply: Always included
 * - Auto Attached: Included when files match globs
 * - Agent Requested: Included based on query similarity
 * - Manual: Only included when explicitly requested
 */
export const WorkspaceRulesComponent: ContextComponent = {
  id: "workspace-rules",
  name: "Workspace Rules",
  description: "Project-specific behavioral rules and guidelines",

  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    // Get the rules service for dynamic rule discovery
    const { ModularRulesService } = require("../../rules/rules-service-modular");

    try {
      const rulesService = new ModularRulesService(context.workspacePath || process.cwd());
      const allRules = await rulesService.listRules();

      // Check if we should use enhanced filtering
      const userQuery = context.userQuery || context.userPrompt;
      const filesInContext = context.filesInContext || [];
      let shouldUseEnhancedFiltering = Boolean(userQuery?.trim() || filesInContext.length > 0);

      let filteredRules: Rule[] = [];
      let filteredBy: string | undefined;
      let queryUsed: string | undefined = userQuery;
      let reductionPercentage: number | undefined;
      let rulesByType: Record<string, Rule[]> | undefined;

      if (shouldUseEnhancedFiltering) {
        try {
          // Use enhanced rule suggestion
          const similarityService = await createRuleSimilarityService(
            context.workspacePath || process.cwd()
          );

          filteredRules = await suggestRules(
            {
              query: userQuery,
              filesInContext: filesInContext,
              limit: 20,
              threshold: 0.1,
            },
            allRules,
            similarityService
          );

          // Group rules by type
          rulesByType = groupRulesByType(filteredRules);

          // Calculate reduction
          reductionPercentage =
            allRules.length > 0
              ? Math.round(((allRules.length - filteredRules.length) / allRules.length) * 100)
              : 0;

          filteredBy = "enhanced-suggestion";
        } catch (error) {
          log.warn(
            "Failed to apply enhanced rule filtering, falling back to simple filter:",
            error
          );
          // Fall back to simple filtering by leaving filteredBy undefined
          filteredBy = undefined;
        }
      }

      // Fallback to simple filtering
      if (!filteredBy) {
        if (userQuery) {
          const prompt = userQuery.toLowerCase();
          filteredRules = allRules.filter((rule) => {
            if (!rule || !rule.name) return false;
            return (
              rule.name.toLowerCase().includes(prompt) ||
              rule.description?.toLowerCase().includes(prompt) ||
              rule.content?.toLowerCase().includes(prompt)
            );
          });
          filteredBy = "simple-filter-fallback";
        } else {
          filteredRules = allRules;
          filteredBy = "all-rules";
        }
      }

      return {
        requestableRules: filteredRules,
        totalRules: allRules.length,
        filteredCount: filteredRules.length,
        userPrompt: context.userPrompt,
        filteredBy,
        queryUsed,
        reductionPercentage,
        rulesByType,
        originalToolCount: allRules.length, // For consistency with tool-schemas
      };
    } catch (error) {
      log.warn("Failed to load workspace rules:", error);
      return {
        requestableRules: [],
        totalRules: 0,
        filteredCount: 0,
        error: "Failed to load workspace rules",
      };
    }
  },

  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    if (inputs.error) {
      const content = `## Workspace Rules

Error loading workspace rules: ${inputs.error}

Workspace-specific behavioral guidelines could not be determined.`;

      return {
        content,
        metadata: {
          componentId: "workspace-rules",
          tokenCount: content.length / 4,
          sections: ["workspace_rules"],
        },
      };
    }

    // Build content exactly like Cursor's format
    let content = `<rules>
The rules section has a number of possible rules/memories/context that you should consider. In each subsection, we provide instructions about what information the subsection contains and how you should consider/follow the contents of the subsection.


<agent_requestable_workspace_rules description="These are workspace-level rules that the agent should follow. They can request the full details of the rule with the fetch_rules tool.">`;

    // Add requestable rules in Cursor's format
    for (const rule of inputs.requestableRules) {
      if (rule && rule.name) {
        const description = rule.description || `Use this when working with ${rule.name}`;
        content += `\n- ${rule.name}: ${description}`;
      }
    }

    content += `
</agent_requestable_workspace_rules>
<always_applied_workspace_rules description="These are workspace-level rules that the agent must always follow.">
- # Changelog Rule

## Rule Name: changelog

## Description

For any code change, **record it in the \`CHANGELOG.md\` file in the nearest ancestor directory that contains a \`CHANGELOG.md\`**.

- If the file you changed is in a subdirectory with its own \`CHANGELOG.md\`, use that changelog.
- If there is no \`CHANGELOG.md\` in the current or any parent directory, use the root \`CHANGELOG.md\`.
- Never update more than one changelog for a single change. Always use the most specific (deepest) changelog file in the directory tree.



## Additional Guidance
- Only update the \`CHANGELOG.md\` at the end of an editing session, after testing whether the change worked.
- If a change affects multiple directories with their own changelogs, split the changelog entries accordingly, but never duplicate the same entry in multiple changelogs.
- For documentation-only changes, use the root changelog unless the documentation is scoped to a subproject with its own changelog.

## Rationale
This ensures that changelog entries are always relevant to the part of the codebase they affect, and provides traceability and context by linking to the exact SpecStory conversation(s) where the change was discussed and implemented.

### Examples

| File Changed                              | Changelog to Update         |
|----|----|
| \`project/src/commands/tools/constants.ts\`| \`project/CHANGELOG.md\`    |
| \`project/src/utils/tools.ts\`             | \`project/CHANGELOG.md\`    |
| \`README.md\` (root)                        | \`CHANGELOG.md\`             |
| \`docs/usage.md\`                           | \`CHANGELOG.md\`             |
- # Commit All Changes Rule

## Core Principle

Always commit and push all code changes without waiting for an explicit request from the user. This rule ensures that every change made is properly persisted to the repository.

## Requirements

1. After implementing any feature, fix, or update:
   - Stage all changed files
   - Commit with a descriptive message following conventional commits format
   - Push the changes to the remote repository

2. Never consider a task complete until changes have been:
   - Committed to the local repository
   - Pushed to the remote repository

3. This applies to ALL changes:
   - Code fixes
   - Feature implementations
   - Documentation updates
   - Configuration changes
   - Rule updates
   - Task management operations

## Verification Checklist

Before considering any implementation complete, verify:
- [ ] All changes are staged
- [ ] Changes are committed with a descriptive message
- [ ] Changes are pushed to the remote repository
- Try to not create very large code files, the definition of which is flexible but generally not more than ~400 lines, ideally much less. Don't break them up arbitrarily but look for opportunities to extract submodules/utility modules along subdomain lines.
- # Operational Safety: Dry-Run First

Keep potentially destructive operations safe by default.

## Requirements
- Default to preview/dry-run; perform changes only when user passes an explicit \`--execute\` flag.
- Reflect this behavior in CLI help, docs, and package scripts.
- Show a clear preview plan for what would happen before applying.
- Provide a follow-up example with \`--execute\`.

## Examples

// AVOID: applying by default
\`\`\`
minsky sessiondb migrate
# applies immediately
\`\`\`

// PREFER: safe default with explicit execution
\`\`\`
# preview
minsky sessiondb migrate --dry-run

# apply (must be explicit)
minsky sessiondb migrate --execute
\`\`\`

## Cross-References
- See \`sessiondb.migrate\` behavior and other commands using \`--execute\` semantics.
</always_applied_workspace_rules>

</rules>`;

    return {
      content,
      metadata: {
        componentId: "workspace-rules",
        tokenCount: content.length / 4, // Rough estimate
        sections: ["rules", "agent_requestable_workspace_rules", "always_applied_workspace_rules"],
        totalRules: inputs.totalRules,
        filteredCount: inputs.filteredCount,
        filteredBy: inputs.filteredBy,
        queryUsed: inputs.queryUsed,
        reductionPercentage: inputs.reductionPercentage,
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const inputs = await this.gatherInputs(input);
    return this.render(inputs, input);
  },
};
