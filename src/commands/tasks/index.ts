import { Command } from "commander";
import { createListCommand } from "./list";
import { createGetCommand } from "./get";
import { createStatusCommand } from "./status";
import { createCommand } from "./create";

export function createTasksCommand(): Command {
  const tasks = new Command("tasks").description("Task management operations");

  tasks.addCommand(createListCommand());
  tasks.addCommand(createGetCommand());
  tasks.addCommand(createStatusCommand());
  tasks.addCommand(createCommand());

  return tasks;
}
