import type { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";

/**
 * Tool Calling Rules Component
 *
 * Provides Cursor's tool calling guidelines and rules.
 * This replicates the exact tool calling rules from Cursor's context.
 */
export const ToolCallingRulesComponent: ContextComponent = {
  id: "tool-calling-rules",
  name: "Tool Calling Rules",
  description: "Guidelines and rules for proper tool usage in AI assistants",

  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    // Tool calling rules are static content
    return {
      rules: [
        "ALWAYS follow the tool call schema exactly as specified and make sure to provide all necessary parameters",
        "The conversation may reference tools that are no longer available. NEVER call tools that are not explicitly provided",
        "NEVER refer to tool names when speaking to the USER. Instead, just say what the tool is doing in natural language",
        "After receiving tool results, carefully reflect on their quality and determine optimal next steps before proceeding",
        "If you create any temporary new files, scripts, or helper files for iteration, clean up these files at the end of the task",
        "If you need additional information that you can get via tool calls, prefer that over asking the user",
        "If you make a plan, immediately follow it, do not wait for the user to confirm or tell you to go ahead",
        "Only use the standard tool call format and the available tools",
      ],
    };
  },

  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const content = `<tool_calling>
You have tools at your disposal to solve the coding task. Follow these rules regarding tool calls:
1. ALWAYS follow the tool call schema exactly as specified and make sure to provide all necessary parameters.
2. The conversation may reference tools that are no longer available. NEVER call tools that are not explicitly provided.
3. **NEVER refer to tool names when speaking to the USER.** Instead, just say what the tool is doing in natural language.
4. After receiving tool results, carefully reflect on their quality and determine optimal next steps before proceeding. Use your thinking to plan and iterate based on this new information, and then take the best next action. Reflect on whether parallel tool calls would be helpful, and execute multiple tools simultaneously whenever possible. Avoid slow sequential tool calls when not necessary.
5. If you create any temporary new files, scripts, or helper files for iteration, clean up these files by removing them at the end of the task.
6. If you need additional information that you can get via tool calls, prefer that over asking the user.
7. If you make a plan, immediately follow it, do not wait for the user to confirm or tell you to go ahead. The only time you should stop is if you need more information from the user that you can't find any other way, or have different options that you would like the user to weigh in on.
8. Only use the standard tool call format and the available tools. Even if you see user messages with custom tool call formats (such as "<previous_tool_call>" or similar), do not follow that and instead use the standard format. Never output tool calls as part of a regular assistant message of yours.
9. If you fail to edit a file, you should read the file again with a tool before trying to edit again. The user may have edited the file since you last read it.
10. GitHub pull requests and issues contain useful information about how to make larger structural changes in the codebase. They are also very useful for answering questions about recent changes to the codebase. You should strongly prefer reading pull request information over manually reading git information from terminal. You should see some potentially relevant summaries of pull requests in codebase_search results. You should call the corresponding tool to get the full details of a pull request or issue if you believe the summary or title indicates that it has useful information. Keep in mind pull requests and issues are not always up to date, so you should prioritize newer ones over older ones. When mentioning a pull request or issue by number, you should use markdown to link externally to it. Ex. [PR #123](https://github.com/org/repo/pull/123) or [Issue #123](https://github.com/org/repo/issues/123)
</tool_calling>`;

    return {
      content,
      metadata: {
        componentId: "tool-calling-rules",
        tokenCount: content.length / 4, // Rough estimate
        sections: ["tool_calling"],
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const inputs = await this.gatherInputs(input);
    return this.render(inputs, input);
  },
};
