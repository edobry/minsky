#!/usr/bin/env bun

import { program } from "commander";
import { createGitCommand } from "./commands/git";
import { createSessionCommand } from "./commands/session";
import { createTasksCommand } from "./commands/tasks";
import { createInitCommand } from "./commands/init";

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
