import type { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";

/**
 * Communication Component
 *
 * Provides Cursor's communication guidelines for AI assistants.
 * This replicates the exact communication rules from Cursor's context.
 */
export const CommunicationComponent: ContextComponent = {
  id: "communication",
  name: "Communication Guidelines",
  description: "Communication formatting and interaction guidelines for AI assistants",

  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    // Communication guidelines are static, no dynamic input needed
    return {
      guidelines: {
        markdown: "Use backticks to format file, directory, function, and class names",
        math: "Use \\( and \\) for inline math, \\[ and \\] for block math",
      },
    };
  },

  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const content = `<communication>
When using markdown in assistant messages, use backticks to format file, directory, function, and class names. Use \\( and \\) for inline math, \\[ and \\] for block math.
</communication>`;

    return {
      content,
      metadata: {
        componentId: "communication",
        tokenCount: content.length / 4, // Rough estimate
        sections: ["communication"],
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const inputs = await this.gatherInputs(input);
    return this.render(inputs, input);
  },
};
