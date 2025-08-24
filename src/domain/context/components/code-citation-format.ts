import type { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";

/**
 * Code Citation Format Component
 *
 * Provides Cursor's code citation format requirements.
 * This replicates the exact code citation instructions from Cursor's context.
 */
export const CodeCitationFormatComponent: ContextComponent = {
  id: "code-citation-format",
  name: "Code Citation Format",
  description: "Required format for citing code regions and blocks",

  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    // Code citation format is static content
    return {
      format: "```startLine:endLine:filepath",
      example: "```12:15:app/components/Todo.tsx\n// ... existing code ...\n```",
    };
  },

  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const content = `You MUST use the following format when citing code regions or blocks:
\`\`\`12:15:app/components/Todo.tsx
// ... existing code ...
\`\`\`
This is the ONLY acceptable format for code citations. The format is \`\`\`startLine:endLine:filepath where startLine and endLine are line numbers.

<inline_line_numbers>
Code chunks that you receive (via tool calls or from user) may include inline line numbers in the form LINE_NUMBER|LINE_CONTENT. Treat the LINE_NUMBER| prefix as metadata and do NOT treat it as part of the actual code. LINE_NUMBER is right-aligned number padded with spaces to 6 characters.
</inline_line_numbers>`;

    return {
      content,
      metadata: {
        componentId: "code-citation-format",
        tokenCount: content.length / 4, // Rough estimate
        sections: ["code_citation", "inline_line_numbers"],
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const inputs = await this.gatherInputs(input);
    return this.render(inputs, input);
  },
};
