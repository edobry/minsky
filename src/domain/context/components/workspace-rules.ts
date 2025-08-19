import { type ContextComponent, type ComponentInput, type ComponentOutput, type ComponentInputs } from "./types";
// Reuse existing Minsky rule service
import { ModularRulesService } from "../../rules/rules-service-modular";
import { type Rule } from "../../rules/types";

interface WorkspaceRulesInputs {
  rules: Rule[];
  totalRules: number;
  rulesByTag: Record<string, Rule[]>;
  userPrompt?: string;
}

export const WorkspaceRulesComponent: ContextComponent = {
  id: "workspace-rules",
  name: "Workspace Rules",
  description: "Project-specific behavioral rules and guidelines",

  // Phase 1: Async input gathering (reuses existing rule service)
  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    const workspacePath = context.workspacePath || process.cwd();
    const rulesService = new ModularRulesService(workspacePath);
    
    // Get all rules in workspace
    const rules = await rulesService.listRules();
    
    // Filter out any undefined/null rules
    const validRules = rules.filter(rule => rule && rule.id);
    
    // Organize rules by tags for better structure
    const rulesByTag: Record<string, Rule[]> = {};
    validRules.forEach(rule => {
      if (rule.tags && Array.isArray(rule.tags)) {
        rule.tags.forEach(tag => {
          if (!rulesByTag[tag]) {
            rulesByTag[tag] = [];
          }
          rulesByTag[tag].push(rule);
        });
      }
    });

    return {
      rules: validRules,
      totalRules: validRules.length,
      rulesByTag,
      userPrompt: context.userQuery,
    } as WorkspaceRulesInputs;
  },

  // Phase 2: Pure rendering with template-style approach
  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const rulesInputs = inputs as WorkspaceRulesInputs;
    
    let content = `## Workspace Rules\n\n`;
    
    if (rulesInputs.totalRules === 0) {
      content += `No rules found in workspace. Consider adding some behavioral guidelines.\n`;
      return {
        content,
        metadata: { componentId: this.id, generatedAt: new Date().toISOString() },
      };
    }

    content += `Found ${rulesInputs.totalRules} rules in workspace.\n\n`;

    // If user provided a query, filter relevant rules
    if (rulesInputs.userPrompt) {
      const relevantRules = rulesInputs.rules.filter(rule => {
        if (!rule || !rule.name) return false;
        
        const prompt = rulesInputs.userPrompt!.toLowerCase();
        return (
          rule.name.toLowerCase().includes(prompt) ||
          (rule.description && rule.description.toLowerCase().includes(prompt)) ||
          (rule.tags && rule.tags.some(tag => tag.toLowerCase().includes(prompt)))
        );
      });
      
      if (relevantRules.length > 0) {
        content += `### Rules Relevant to "${rulesInputs.userPrompt}"\n\n`;
        relevantRules.forEach(rule => {
          content += `**${rule.name}** (${rule.id})\n`;
          if (rule.description) {
            content += `- ${rule.description}\n`;
          }
          if (rule.tags && rule.tags.length > 0) {
            content += `- Tags: ${rule.tags.join(', ')}\n`;
          }
          content += `\n`;
        });
        content += `\n`;
      }
    }

    // Group rules by category/tags
    const majorTags = Object.keys(rulesInputs.rulesByTag)
      .filter(tag => rulesInputs.rulesByTag[tag].length >= 2)
      .sort((a, b) => rulesInputs.rulesByTag[b].length - rulesInputs.rulesByTag[a].length);

    if (majorTags.length > 0) {
      content += `### Rules by Category\n\n`;
      majorTags.slice(0, 5).forEach(tag => { // Limit to top 5 categories
        const tagRules = rulesInputs.rulesByTag[tag];
        content += `**${tag.toUpperCase()}** (${tagRules.length} rules)\n`;
        tagRules.slice(0, 3).forEach(rule => { // Limit to 3 rules per category
          if (rule && rule.name) {
            content += `- ${rule.name}: ${rule.description || 'No description'}\n`;
          }
        });
        if (tagRules.length > 3) {
          content += `- ... and ${tagRules.length - 3} more\n`;
        }
        content += `\n`;
      });
    }

    // Add note about accessing full rule content
    content += `### Usage\n\nTo view full rule content, use: \`minsky rules get <rule-id>\`\n`;

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

export function createWorkspaceRulesComponent(): ContextComponent { 
  return WorkspaceRulesComponent; 
}