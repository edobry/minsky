import { TaskService } from "./src/domain/tasks";
import { resolveWorkspacePath } from "./src/domain/workspace";

async function testTasksInSessionRepo() {
  try {
    console.log("Testing workspace detection from session repository...");
    
    // Get the workspace path using our new utility
    const workspacePath = await resolveWorkspacePath();
    console.log(`Resolved workspace path: ${workspacePath}`);
    
    // Create a TaskService with the detected workspace
    const taskService = new TaskService({
      workspacePath,
    });
    
    // Get the current task status
    const taskId = "#016";
    const beforeStatus = await taskService.getTaskStatus(taskId);
    console.log(`Current status of task ${taskId}: ${beforeStatus}`);
    
    // Update the status
    const newStatus = "IN-REVIEW";
    await taskService.setTaskStatus(taskId, newStatus);
    console.log(`Updated status of task ${taskId} to: ${newStatus}`);
    
    // Get the updated status to verify
    const afterStatus = await taskService.getTaskStatus(taskId);
    console.log(`New status of task ${taskId}: ${afterStatus}`);
    
    // Print where the operation was actually performed
    console.log(`Task operations were performed in workspace: ${taskService.getWorkspacePath()}`);
  } catch (error) {
    console.error("Error:", error);
  }
}

testTasksInSessionRepo(); 
