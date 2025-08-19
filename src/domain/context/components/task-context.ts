import { type ContextComponent, type ComponentInput, type ComponentOutput, type ComponentInputs } from "./types";

interface TaskContextInputs {
  hasTask: boolean;
  taskId?: string;
  taskTitle?: string;
  taskStatus?: string;
  taskDescription?: string;
  userQuery: string;
}

export const TaskContextComponent: ContextComponent = {
  id: "task-context",
  name: "Task Context",
  description: "Current task and user query information",

  // Phase 1: Async input gathering (task-specific data collection)
  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    const task = context.task;
    const userQuery = context.userQuery || "No specific query provided";

    return {
      hasTask: !!task,
      taskId: task?.id,
      taskTitle: task?.title,
      taskStatus: task?.status,
      taskDescription: task?.description,
      userQuery,
    } as TaskContextInputs;
  },

  // Phase 2: Pure rendering using template approach
  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const taskInputs = inputs as TaskContextInputs;
    
    let content = `## Task Context\n\n`;
    
    if (taskInputs.hasTask) {
      content += `### Current Task
- Task ID: ${taskInputs.taskId}
- Title: ${taskInputs.taskTitle}
- Status: ${taskInputs.taskStatus}
- Description: ${taskInputs.taskDescription}

`;
    } else {
      content += `### Current Task
No active task specified.

`;
    }

    content += `### User Query
${taskInputs.userQuery}`;

    return {
      content,
      metadata: { 
        componentId: this.id, 
        generatedAt: new Date().toISOString() 
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const gatheredInputs = await this.gatherInputs(input);
    return this.render(gatheredInputs, input);
  },
};

export function createTaskContextComponent(): ContextComponent { 
  return TaskContextComponent; 
}