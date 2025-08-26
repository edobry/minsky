/**
 * Task Edit Commands
 *
 * Commands for editing existing tasks (title and specification content).
 * Supports multi-backend editing with proper delegation to backend implementations.
 */
import { type CommandExecutionContext } from "../../command-registry";
import { ValidationError, ResourceNotFoundError } from "../../../../errors/index";
import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import { tasksEditParams } from "./task-parameters";
import { getTaskFromParams, updateTaskFromParams } from "../../../../domain/tasks";
import { log } from "../../../../utils/logger";
import { promises as fs } from "fs";
import { spawn } from "child_process";

/**
 * Parameters for tasks edit command
 */
interface TasksEditParams extends BaseTaskParams {
  taskId: string;
  title?: string;
  spec?: boolean;
  specFile?: string;
  specContent?: string;
  specAppend?: string;
  specPrepend?: string;
  specInsertAfter?: string;
  specInsertBefore?: string;
}

/**
 * Task edit command implementation
 */
export class TasksEditCommand extends BaseTaskCommand {
  readonly id = "tasks.edit";
  readonly name = "edit";
  readonly description = "Edit task title and/or specification content";
  readonly parameters = tasksEditParams;

  async execute(params: TasksEditParams, ctx: CommandExecutionContext) {
    this.debug("Starting tasks.edit execution");

    // Validate required parameters
    const taskId = this.validateRequired(params.taskId, "taskId");
    const validatedTaskId = this.validateAndNormalizeTaskId(taskId);

    // Validate that at least one edit operation is specified
    const hasSpecOperation = !!(params.spec || params.specFile || params.specContent || 
                               params.specAppend || params.specPrepend || 
                               params.specInsertAfter || params.specInsertBefore);
    
    if (!params.title && !hasSpecOperation) {
      throw new ValidationError(
        "At least one edit operation must be specified:\\n" +
          "  --title <text>              Update task title\\n" +
          "  --spec                      Edit specification content interactively\\n" +
          "  --spec-file <path>          Update specification from file\\n" +
          "  --spec-content <text>       Replace specification content\\n" +
          "  --spec-append <text>        Append to existing specification\\n" +
          "  --spec-prepend <text>       Prepend to existing specification\\n" +
          "  --spec-insert-after <text>  Insert after pattern (format: 'pattern|||content')\\n" +
          "  --spec-insert-before <text> Insert before pattern (format: 'pattern|||content')\\n\\n" +
          "Examples:\\n" +
          '  minsky tasks edit mt#123 --title "New Title"\\n' +
          "  minsky tasks edit mt#123 --spec-file /path/to/spec.md\\n" +
          '  minsky tasks edit mt#123 --spec-append "## New Section"\\n' +
          '  minsky tasks edit mt#123 --spec-insert-after "## Overview|||\\n\\nNew content here"'
      );
    }

    // Validate that only one spec operation is specified at a time
    const specOperations = [params.spec, params.specFile, params.specContent, 
                           params.specAppend, params.specPrepend, 
                           params.specInsertAfter, params.specInsertBefore].filter(Boolean);
    
    if (specOperations.length > 1) {
      throw new ValidationError(
        "Only one specification editing operation can be specified at a time"
      );
    }

    // Verify the task exists and get current data
    this.debug("Verifying task exists");
    const currentTask = await getTaskFromParams({
      ...this.createTaskParams(params),
      taskId: validatedTaskId,
    });

    if (!currentTask) {
      throw new ResourceNotFoundError(
        `Task "${validatedTaskId}" not found`,
        "task",
        validatedTaskId
      );
    }

    this.debug("Task found, preparing updates");

    // Prepare the updates object
    const updates: { title?: string; spec?: string } = {};

    // Handle title update
    if (params.title) {
      updates.title = params.title;
      this.debug(`Title update: "${params.title}"`);
    }

    // Handle spec content update
    if (params.specContent) {
      // Complete replacement
      updates.spec = params.specContent;
      this.debug("Using direct spec content (replace)");
    } else if (params.specFile) {
      // Complete replacement from file
      try {
        updates.spec = await fs.readFile(params.specFile, "utf-8");
        this.debug(`Read spec content from file: ${params.specFile}`);
      } catch (error) {
        throw new ValidationError(
          `Failed to read spec file "${params.specFile}": ${error.message}`
        );
      }
    } else if (params.specAppend || params.specPrepend || params.specInsertAfter || params.specInsertBefore) {
      // In-memory editing operations - need current spec content
      this.debug("Performing in-memory spec editing");
      const specResult = await import("../../../../domain/tasks").then(m => 
        m.getTaskSpecContentFromParams({
          ...this.createTaskParams(params),
          taskId: validatedTaskId,
        })
      );
      
      const currentSpec = specResult?.content || "";
      updates.spec = await this.performInMemorySpecEdit(currentSpec, params);
      this.debug("Completed in-memory spec editing");
    }

    // Apply the updates using the real persistence function
    this.debug("Applying updates to task");
    
    try {
      const updatedTask = await updateTaskFromParams({
        taskId: validatedTaskId,
        title: updates.title,
        spec: updates.spec,
        ...this.createTaskParams(params),
      });

      const message = this.buildUpdateMessage(updates, validatedTaskId);
      this.debug("Task edit completed successfully");

      return this.formatResult(
        this.createSuccessResult(validatedTaskId, message, {
          updates,
          task: updatedTask,
        }),
        params.json
      );
    } catch (error) {
      this.debug(`Task edit failed: ${error.message}`);
      throw error;
    }
  }

  private async performInMemorySpecEdit(currentSpec: string, params: TasksEditParams): Promise<string> {
    let editedSpec = currentSpec;

    if (params.specAppend) {
      // Append to the end
      editedSpec = editedSpec + (editedSpec.endsWith('\n') ? '' : '\n') + params.specAppend;
      this.debug("Applied spec append operation");
    } else if (params.specPrepend) {
      // Prepend to the beginning
      editedSpec = params.specPrepend + (params.specPrepend.endsWith('\n') ? '' : '\n') + editedSpec;
      this.debug("Applied spec prepend operation");
    } else if (params.specInsertAfter) {
      // Insert after a pattern: "pattern|||content"
      const [pattern, content] = params.specInsertAfter.split('|||');
      if (!pattern || !content) {
        throw new ValidationError("spec-insert-after format must be 'pattern|||content'");
      }
      
      const lines = editedSpec.split('\n');
      const insertIndex = lines.findIndex(line => line.includes(pattern));
      
      if (insertIndex === -1) {
        throw new ValidationError(`Pattern "${pattern}" not found in specification`);
      }
      
      lines.splice(insertIndex + 1, 0, content);
      editedSpec = lines.join('\n');
      this.debug(`Applied spec insert-after operation at line ${insertIndex + 1}`);
    } else if (params.specInsertBefore) {
      // Insert before a pattern: "pattern|||content"  
      const [pattern, content] = params.specInsertBefore.split('|||');
      if (!pattern || !content) {
        throw new ValidationError("spec-insert-before format must be 'pattern|||content'");
      }
      
      const lines = editedSpec.split('\n');
      const insertIndex = lines.findIndex(line => line.includes(pattern));
      
      if (insertIndex === -1) {
        throw new ValidationError(`Pattern "${pattern}" not found in specification`);
      }
      
      lines.splice(insertIndex, 0, content);
      editedSpec = lines.join('\n');
      this.debug(`Applied spec insert-before operation at line ${insertIndex}`);
    }

    return editedSpec;
  }

  private buildUpdateMessage(updates: { title?: string; spec?: string }, taskId: string): string {
    const parts: string[] = [];

    if (updates.title && updates.spec) {
      parts.push("title and specification");
    } else if (updates.title) {
      parts.push("title");
    } else if (updates.spec) {
      parts.push("specification");
    }

    return `Task ${taskId} ${parts.join(" and ")} updated successfully`;
  }
}

/**
 * Factory function for creating the edit command
 */
export function createTasksEditCommand(): TasksEditCommand {
  return new TasksEditCommand();
}
