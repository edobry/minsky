import type { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";

/**
 * Task Management Component
 *
 * Provides Cursor's task management guidelines and todo system usage.
 * This replicates the exact task management instructions from Cursor's context.
 */
export const TaskManagementComponent: ContextComponent = {
  id: "task-management",
  name: "Task Management",
  description: "Guidelines for using todo tools and managing complex tasks",

  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    // Task management guidelines are static content
    return {
      guidelines: [
        "Use todo_write tool VERY frequently for task planning and tracking",
        "Break down larger complex tasks into smaller steps",
        "Mark todos as completed as soon as tasks are done",
        "Use todos for planning tasks and breaking down complex work",
        "Always use todo_write tool unless request is too simple",
      ],
    };
  },

  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const content = `<task_management>
You have access to the todo_write tool to help you manage and plan tasks. Use these tools VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress. These tools are also EXTREMELY helpful for planning tasks, and for breaking down larger complex tasks into smaller steps. If you do not use this tool when planning, you may forget to do important tasks - and that is unacceptable.
It is critical that you mark todos as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as completed.
IMPORTANT: Always use the todo_write tool to plan and track tasks throughout the conversation unless the request is too simple.
</task_management>`;

    return {
      content,
      metadata: {
        componentId: "task-management",
        tokenCount: content.length / 4, // Rough estimate
        sections: ["task_management"],
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const inputs = await this.gatherInputs(input);
    return this.render(inputs, input);
  },
};
