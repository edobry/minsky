#!/usr/bin/env bun

import { program } from "commander";
import { createGitCommand } from "./src/commands/git";
import { createSessionCommand } from "./src/commands/session";
import { createTasksCommand } from "./src/commands/tasks";
import { createInitCommand } from "./src/commands/init";

program
  .name("minsky")
  .description("A CLI tool for Minsky")
  .version("0.1.0");

program
  .command("hello")
  .description("Say hello")
  .action(() => {
    console.log("Hello from Minsky!");
  });

program.addCommand(createGitCommand());
program.addCommand(createSessionCommand());
program.addCommand(createTasksCommand());
program.addCommand(createInitCommand());

program.parse(); 
