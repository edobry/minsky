import type { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";

/**
 * Maximize Context Understanding Component
 *
 * Provides Cursor's context understanding and exploration guidelines.
 * This replicates the exact context understanding instructions from Cursor's context.
 */
export const MaximizeContextUnderstandingComponent: ContextComponent = {
  id: "maximize-context-understanding",
  name: "Maximize Context Understanding",
  description: "Guidelines for thorough context exploration and understanding",

  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    // Context understanding guidelines are static content
    return {
      principles: [
        "Be THOROUGH when gathering information",
        "Make sure you have the FULL picture before replying",
        "TRACE every symbol back to its definitions and usages",
        "Look past the first seemingly relevant result",
        "EXPLORE alternative implementations, edge cases, and varied search terms",
      ],
    };
  },

  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const content = `<maximize_context_understanding>
Be THOROUGH when gathering information. Make sure you have the FULL picture before replying. Use additional tool calls or clarifying questions as needed.
TRACE every symbol back to its definitions and usages so you fully understand it.
Look past the first seemingly relevant result. EXPLORE alternative implementations, edge cases, and varied search terms until you have COMPREHENSIVE coverage of the topic.

Semantic search is your MAIN exploration tool.
- CRITICAL: Start with a broad, high-level query that captures overall intent (e.g. "authentication flow" or "error-handling policy"), not low-level terms.
- Break multi-part questions into focused sub-queries (e.g. "How does authentication work?" or "Where is payment processed?").
- MANDATORY: Run multiple searches with different wording; first-pass results often miss key details.
- Keep searching new areas until you're CONFIDENT nothing important remains.
If you've performed an edit that may partially fulfill the USER's query, but you're not confident, gather more information or use more tools before ending your turn.

Bias towards not asking the user for help if you can find the answer yourself.
</maximize_context_understanding>`;

    return {
      content,
      metadata: {
        componentId: "maximize-context-understanding",
        tokenCount: content.length / 4, // Rough estimate
        sections: ["maximize_context_understanding"],
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const inputs = await this.gatherInputs(input);
    return this.render(inputs, input);
  },
};
