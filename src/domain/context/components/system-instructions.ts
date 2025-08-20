import {
  type ContextComponent,
  type ComponentInput,
  type ComponentOutput,
  type ComponentInputs,
} from "./types";

interface SystemInstructionsInputs {
  userPrompt?: string;
  targetModel: string;
  taskContext?: {
    id?: string;
    title?: string;
    status?: string;
  };
  customInstructions?: string[];
}

export const SystemInstructionsComponent: ContextComponent = {
  id: "system-instructions",
  name: "System Instructions",
  description: "Core AI behavior guidelines and interaction principles",

  // Phase 1: Async input gathering
  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    const userPrompt = context.userQuery;
    const targetModel = context.targetModel || "gpt-4o";
    const taskContext = context.task;

    // Basic system instructions - these could come from templates or config
    const customInstructions: string[] = [];

    // Add context-specific instructions based on user prompt
    if (userPrompt) {
      if (userPrompt.toLowerCase().includes("test")) {
        customInstructions.push("Focus on testing best practices and test coverage");
      }
      if (
        userPrompt.toLowerCase().includes("error") ||
        userPrompt.toLowerCase().includes("debug")
      ) {
        customInstructions.push("Prioritize error handling and debugging information");
      }
      if (userPrompt.toLowerCase().includes("security")) {
        customInstructions.push("Apply security-first thinking to all recommendations");
      }
      if (userPrompt.toLowerCase().includes("performance")) {
        customInstructions.push("Consider performance implications in all suggestions");
      }
    }

    return {
      userPrompt,
      targetModel,
      taskContext,
      customInstructions,
    } as SystemInstructionsInputs;
  },

  // Phase 2: Pure rendering using template-style approach
  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const sysInputs = inputs as SystemInstructionsInputs;

    let content = `## System Instructions\n\n`;

    // Core AI interaction principles
    content += `### Core Principles\n`;
    content += `- **Accuracy**: Provide precise, technically correct information\n`;
    content += `- **Clarity**: Use clear, unambiguous language and explanations\n`;
    content += `- **Completeness**: Address all aspects of questions and requests\n`;
    content += `- **Context Awareness**: Consider the specific project and environment\n`;
    content += `- **Best Practices**: Recommend industry-standard approaches and patterns\n\n`;

    // Model-specific considerations
    content += `### AI Model Context\n`;
    content += `- Target Model: ${sysInputs.targetModel}\n`;
    content += `- Interaction Mode: Technical assistance and code collaboration\n`;
    content += `- Response Style: Direct, actionable, and comprehensive\n\n`;

    // Task-specific context if available
    if (sysInputs.taskContext?.id) {
      content += `### Current Task Context\n`;
      content += `- Task ID: ${sysInputs.taskContext.id}\n`;
      if (sysInputs.taskContext.title) {
        content += `- Task: ${sysInputs.taskContext.title}\n`;
      }
      if (sysInputs.taskContext.status) {
        content += `- Status: ${sysInputs.taskContext.status}\n`;
      }
      content += `\n`;
    }

    // User-specific context adaptations
    if (sysInputs.userPrompt) {
      content += `### Session Focus\n`;
      content += `- User Query: "${sysInputs.userPrompt}"\n`;
      content += `- Context Adaptation: Tailored to user's specific needs and focus areas\n\n`;
    }

    // Custom instructions based on context analysis
    if (sysInputs.customInstructions && sysInputs.customInstructions.length > 0) {
      content += `### Context-Specific Guidelines\n`;
      sysInputs.customInstructions.forEach((instruction) => {
        content += `- ${instruction}\n`;
      });
      content += `\n`;
    }

    // Code-specific guidelines
    content += `### Code Collaboration Guidelines\n`;
    content += `- **Code Quality**: Follow project conventions and best practices\n`;
    content += `- **Testing**: Include appropriate test coverage for new code\n`;
    content += `- **Documentation**: Provide clear comments and documentation\n`;
    content += `- **Error Handling**: Implement robust error handling patterns\n`;
    content += `- **Performance**: Consider efficiency and scalability implications\n`;
    content += `- **Security**: Apply security-conscious development practices\n\n`;

    // Response format guidelines
    content += `### Response Format Guidelines\n`;
    content += `- Use markdown formatting for structure and clarity\n`;
    content += `- Provide code examples with appropriate language tags\n`;
    content += `- Include reasoning and explanation for recommendations\n`;
    content += `- Suggest multiple approaches when applicable\n`;
    content += `- Reference relevant documentation and resources\n`;

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

export function createSystemInstructionsComponent(): ContextComponent {
  return SystemInstructionsComponent;
}
