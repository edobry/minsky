#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

async function fixSpecPaths() {
  // Read the tasks file
  const tasksFilePath = "process/tasks.json";
  let tasksData;

  try {
    const tasksContent = fs.readFileSync(tasksFilePath, "utf8");
    tasksData = JSON.parse(tasksContent);
  } catch (error) {
    console.error("Could not read tasks.json:", error.message);
    return;
  }

  // Get list of actual spec files
  const tasksDir = "process/tasks";
  const files = fs.readdirSync(tasksDir);
  const specFiles = files.filter((f) => f.endsWith(".md") && f.startsWith("md#"));

  console.log("Found spec files:", specFiles.slice(0, 5), "...");

  // Update tasks with correct spec paths
  let updatedCount = 0;
  for (const task of tasksData.tasks) {
    if (task.id && task.id.startsWith("md#")) {
      // Find matching spec file
      const taskIdNum = task.id.split("#")[1];
      const matchingFile = specFiles.find((f) => f.startsWith(`md#${taskIdNum}-`));

      if (matchingFile) {
        const correctSpecPath = `process/tasks/${matchingFile}`;
        if (task.specPath !== correctSpecPath) {
          console.log(`Updating ${task.id}: ${task.specPath} -> ${correctSpecPath}`);
          task.specPath = correctSpecPath;
          updatedCount++;
        }
      } else {
        console.log(`No spec file found for task ${task.id}`);
      }
    }
  }

  if (updatedCount > 0) {
    // Write back the updated tasks
    fs.writeFileSync(tasksFilePath, JSON.stringify(tasksData, null, 2));
    console.log(`Updated ${updatedCount} tasks with correct spec paths`);
  } else {
    console.log("No tasks needed updating");
  }
}

fixSpecPaths().catch(console.error);
