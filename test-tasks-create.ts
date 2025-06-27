#!/usr/bin/env bun

import { createTaskFromTitleAndDescription } from "./src/domain/tasks/taskCommands.js";

async function testTasksCreate() {
  console.log("Testing tasks create with title and description...");

  try {
    const result = await createTaskFromTitleAndDescription({
      title: "Test Task from Session Workspace",
      description:
        "This is a test task created directly from the session workspace to verify the new title/description interface works correctly.",
      force: false,
    });

    console.log("✅ Task created successfully:");
    console.log("Task ID:", result.id);
    console.log("Title:", result.title);
    console.log("Status:", result.status);
  } catch (error) {
    console.error("❌ Error creating task:", error.message);
    if (error.stack) {
      console.error("Stack trace:", error.stack);
    }
  }
}

testTasksCreate();
