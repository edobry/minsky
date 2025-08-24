import type { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";

/**
 * Making Code Changes Component
 *
 * Provides Cursor's code change guidelines and best practices.
 * This replicates the exact code change instructions from Cursor's context.
 */
export const MakingCodeChangesComponent: ContextComponent = {
  id: "making-code-changes",
  name: "Making Code Changes",
  description: "Guidelines for implementing code changes and ensuring runnable code",

  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    // Code change guidelines are static content
    return {
      guidelines: [
        "NEVER output code to the USER, unless requested",
        "Generated code must be runnable immediately",
        "Add all necessary import statements and dependencies",
        "Create appropriate dependency management files",
        "Give web apps beautiful and modern UI with best UX practices",
        "NEVER generate extremely long hash or non-textual code",
      ],
    };
  },

  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const content = `<making_code_changes>
When making code changes, NEVER output code to the USER, unless requested. Instead use one of the code edit tools to implement the change.

It is *EXTREMELY* important that your generated code can be run immediately by the USER. To ensure this, follow these instructions carefully:
1. Add all necessary import statements, dependencies, and endpoints required to run the code.
2. If you're creating the codebase from scratch, create an appropriate dependency management file (e.g. requirements.txt) with package versions and a helpful README.
3. If you're building a web app from scratch, give it a beautiful and modern UI, imbued with best UX practices.
4. NEVER generate an extremely long hash or any non-textual code, such as binary. These are not helpful to the USER and are very expensive.
5. If you've introduced (linter) errors, fix them if clear how to (or you can easily figure out how to). Do not make uneducated guesses. And DO NOT loop more than 3 times on fixing linter errors on the same file. On the third time, you should stop and ask the user what to do next.
</making_code_changes>`;

    return {
      content,
      metadata: {
        componentId: "making-code-changes",
        tokenCount: content.length / 4, // Rough estimate
        sections: ["making_code_changes"],
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const inputs = await this.gatherInputs(input);
    return this.render(inputs, input);
  },
};
