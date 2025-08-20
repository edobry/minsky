import type { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";

/**
 * Maximize Parallel Tool Calls Component
 *
 * Provides Cursor's parallel tool execution optimization guidelines.
 * This replicates the exact parallel tool calling instructions from Cursor's context.
 */
export const MaximizeParallelToolCallsComponent: ContextComponent = {
  id: "maximize-parallel-tool-calls",
  name: "Maximize Parallel Tool Calls",
  description: "Guidelines for efficient parallel tool execution and optimization",

  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    // Parallel tool calling guidelines are static content
    return {
      principles: [
        "Invoke all relevant tools simultaneously rather than sequentially",
        "Prioritize calling tools in parallel whenever possible",
        "Plan searches upfront and execute all tool calls together",
        "Default to parallel unless operations MUST be sequential",
      ],
    };
  },

  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const content = `<maximize_parallel_tool_calls>
CRITICAL INSTRUCTION: For maximum efficiency, whenever you perform multiple operations, invoke all relevant tools simultaneously rather than sequentially. Prioritize calling tools in parallel whenever possible. For example, when reading 3 files, run 3 tool calls in parallel to read all 3 files into context at the same time. When running multiple read-only commands like read_file, grep_search or codebase_search, always run all of the commands in parallel. Err on the side of maximizing parallel tool calls rather than running too many tools sequentially.

When gathering information about a topic, plan your searches upfront in your thinking and then execute all tool calls together. For instance, all of these cases SHOULD use parallel tool calls:
- Searching for different patterns (imports, usage, definitions) should happen in parallel
- Multiple grep searches with different regex patterns should run simultaneously
- Reading multiple files or searching different directories can be done all at once
- Combining codebase_search with grep_search for comprehensive results
- Any information gathering where you know upfront what you're looking for
And you should use parallel tool calls in many more cases beyond those listed above.

Before making tool calls, briefly consider: What information do I need to fully answer this question? Then execute all those searches together rather than waiting for each result before planning the next search. Most of the time, parallel tool calls can be used rather than sequential. Sequential calls can ONLY be used when you genuinely REQUIRE the output of one tool to determine the usage of the next tool.

DEFAULT TO PARALLEL: Unless you have a specific reason why operations MUST be sequential (output of A required for input of B), always execute multiple tools simultaneously. This is not just an optimization - it's the expected behavior. Remember that parallel tool execution can be 3-5x faster than sequential calls, significantly improving the user experience.
</maximize_parallel_tool_calls>`;

    return {
      content,
      metadata: {
        componentId: "maximize-parallel-tool-calls",
        tokenCount: content.length / 4, // Rough estimate
        sections: ["maximize_parallel_tool_calls"],
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const inputs = await this.gatherInputs(input);
    return this.render(inputs, input);
  },
};
