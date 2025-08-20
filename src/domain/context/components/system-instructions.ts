import type { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";

/**
 * System Instructions Component
 *
 * Provides Cursor's core system instructions for AI assistants.
 * This replicates the exact system instructions from Cursor's context.
 */
export const SystemInstructionsComponent: ContextComponent = {
  id: "system-instructions",
  name: "System Instructions",
  description: "Core AI behavior guidelines and interaction principles",

  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    // System instructions are mostly static, but can adapt to user prompt
    const userPrompt = context.userPrompt?.toLowerCase() || "";

    return {
      baseInstructions:
        "You are an AI coding assistant, powered by Claude Sonnet 4. You operate in Cursor.",
      pairProgramming: "You are pair programming with a USER to solve their coding task.",
      mainGoal:
        "Your main goal is to follow the USER's instructions at each message, denoted by the <user_query> tag.",
      userPrompt,
      contextualFocus: this.getContextualFocus(userPrompt),
    };
  },

  getContextualFocus(userPrompt: string): string {
    if (userPrompt.includes("security") || userPrompt.includes("auth")) {
      return "Pay special attention to security best practices and authentication flows.";
    }
    if (userPrompt.includes("test") || userPrompt.includes("testing")) {
      return "Focus on testing strategies, test quality, and comprehensive coverage.";
    }
    if (userPrompt.includes("performance") || userPrompt.includes("optimization")) {
      return "Prioritize performance optimization and efficient code patterns.";
    }
    if (userPrompt.includes("error") || userPrompt.includes("debug")) {
      return "Focus on error handling, debugging strategies, and robust code.";
    }
    return "";
  },

  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    let content = `You are an AI coding assistant, powered by Claude Sonnet 4. You operate in Cursor.

You are pair programming with a USER to solve their coding task. Each time the USER sends a message, we may automatically attach some information about their current state, such as what files they have open, where their cursor is, recently viewed files, edit history in their session so far, linter errors, and more. This information may or may not be relevant to the coding task, it is up for you to decide.

Your main goal is to follow the USER's instructions at each message, denoted by the <user_query> tag.`;

    // Add contextual focus if relevant
    if (inputs.contextualFocus) {
      content += `\n\n**Context Focus**: ${inputs.contextualFocus}`;
    }

    content += `

Answer the user's request using the relevant tool(s), if they are available. Check that all the required parameters for each tool call are provided or can reasonably be inferred from context. IF there are no relevant tools or there are missing values for required parameters, ask the user to supply these values; otherwise proceed with the tool calls. If the user provides a specific value for a parameter (for example provided in quotes), make sure to use that value EXACTLY. DO NOT make up values for or ask about optional parameters. Carefully analyze descriptive terms in the request as they may indicate required parameter values that should be included even if not explicitly quoted.

Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.`;

    return {
      content,
      metadata: {
        componentId: "system-instructions",
        tokenCount: content.length / 4, // Rough estimate
        sections: ["system_instructions"],
        contextualFocus: inputs.contextualFocus || null,
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const inputs = await this.gatherInputs(input);
    return this.render(inputs, input);
  },
};
