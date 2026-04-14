/**
 * GitHub Issues API operations for the GitHubIssuesTaskBackend
 *
 * Functions that interact directly with the GitHub REST API via Octokit.
 * Each function takes octokit, owner, repo and any required data as parameters.
 */

import { Octokit } from "@octokit/rest";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import type { TaskData } from "../../types/tasks/taskData";
import type { TaskReadOperationResult, TaskWriteOperationResult } from "../../types/tasks/taskData";
import type { Task } from "../tasks";
import { elementAt } from "../../utils/array-safety";
import {
  getLabelsForTaskStatus,
  buildSpecContentFromIssue,
  parseGitHubTaskSpec,
} from "./github-issues-mapping";
import { getTaskIdNumber } from "./task-id-utils";

/**
 * Fetch all issues for a repo and return them as a JSON string.
 */
export async function fetchIssuesData(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<TaskReadOperationResult> {
  try {
    log.debug("Fetching GitHub issues", { owner, repo });

    const response = await octokit.rest.issues.listForRepo({
      owner,
      repo,
      state: "all",
      per_page: 100,
    });

    const issues = response.data;
    log.debug(`Retrieved ${issues.length} issues from GitHub`, { owner, repo });

    return { success: true, content: JSON.stringify(issues) };
  } catch (error) {
    log.error("Failed to fetch GitHub issues", {
      owner,
      repo,
      error: getErrorMessage(error as Error),
    });
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Fetch spec content for a task by looking up the corresponding GitHub issue.
 */
export async function fetchTaskSpecData(
  octokit: Octokit,
  owner: string,
  repo: string,
  specPath: string,
  statusLabels: Record<string, string>
): Promise<TaskReadOperationResult> {
  try {
    const pathParts = specPath.split("/");
    const fileName = elementAt(pathParts, pathParts.length - 1, "github-issues-api specPath parts");

    // Only match legitimate task files: {1-4 digit ID}-{title}.md
    const taskIdMatch = fileName.match(/^(\d{1,4})-[^0-9]/);
    if (!taskIdMatch || !taskIdMatch[1]) {
      throw new Error(
        `Invalid spec path format: ${specPath}. Expected format: {taskId}-{title}.md`
      );
    }

    const taskId = `#${taskIdMatch[1]}`;

    const response = await octokit.rest.issues.listForRepo({
      owner,
      repo,
      labels: Object.values(statusLabels).join(","),
      state: "all",
    });

    const issue = response.data.find(
      (i) => i.title.includes(taskId) || (i.body ?? "").includes(taskId)
    );

    if (!issue) {
      return {
        success: false,
        error: new Error(`No GitHub issue found for task ${taskId}`),
      };
    }

    const specContent = buildSpecContentFromIssue(
      {
        title: issue.title,
        body: issue.body ?? null,
        number: issue.number,
        html_url: issue.html_url,
        state: issue.state,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        labels: issue.labels,
      },
      taskId,
      statusLabels
    );

    return { success: true, content: specContent };
  } catch (error) {
    log.error("Failed to get task spec data from GitHub", {
      specPath,
      error: getErrorMessage(error as Error),
    });
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Sync a list of task data objects back to GitHub by updating or creating issues.
 */
export async function syncTasksToGitHub(
  octokit: Octokit,
  owner: string,
  repo: string,
  content: string
): Promise<TaskWriteOperationResult> {
  try {
    const tasks: TaskData[] = JSON.parse(content);
    for (const taskData of tasks) {
      log.debug("Syncing task to GitHub", { taskData });
      // Placeholder: full sync logic would go here
    }
    return { success: true };
  } catch (error) {
    log.error("Failed to save tasks data to GitHub", {
      error: getErrorMessage(error as Error),
    });
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Update a GitHub issue's labels and state to reflect a new task status.
 */
export async function updateIssueStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  taskId: string,
  status: string,
  statusLabels: Record<string, string>
): Promise<void> {
  const issueNumber = getTaskIdNumber(taskId);
  if (!issueNumber) {
    throw new Error(`Could not extract issue number from task ID ${taskId}`);
  }

  // Fetch current labels to preserve non-status labels (tags)
  const issue = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const currentLabels = issue.data.labels
    .map((l) => (typeof l === "string" ? l : l.name || ""))
    .filter(Boolean);

  // Remove old status labels, add new status label, keep everything else
  const statusLabelValues = Object.values(statusLabels);
  const nonStatusLabels = currentLabels.filter((l) => !statusLabelValues.includes(l));
  const newLabels = [...nonStatusLabels, ...getLabelsForTaskStatus(status, statusLabels)];

  await octokit.rest.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    labels: newLabels,
    state: status === "DONE" ? "closed" : "open",
  });

  log.debug("Updated task status in GitHub", { taskId, status });
}

/**
 * Update the non-status labels (tags) on a GitHub issue.
 * Keeps status labels intact, replaces all non-status labels with the provided tags.
 */
export async function updateIssueLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
  taskId: string,
  tags: string[],
  statusLabels: Record<string, string>
): Promise<void> {
  const issueNumber = getTaskIdNumber(taskId);
  if (!issueNumber) {
    throw new Error(`Could not extract issue number from task ID ${taskId}`);
  }

  const issue = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const currentLabels = issue.data.labels
    .map((l) => (typeof l === "string" ? l : l.name || ""))
    .filter(Boolean);

  // Keep status labels, replace non-status labels with new tags
  const statusLabelValues = Object.values(statusLabels);
  const keptStatusLabels = currentLabels.filter((l) => statusLabelValues.includes(l));
  const newLabels = [...keptStatusLabels, ...tags];

  await octokit.rest.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    labels: newLabels,
  });

  log.debug("Updated task labels in GitHub", { taskId, tags });
}

/**
 * Create a new GitHub issue from a spec file path (reads spec via callback).
 */
export async function createIssueFromSpec(
  octokit: Octokit,
  owner: string,
  repo: string,
  specContent: string,
  specPath: string,
  statusLabels: Record<string, string>,
  tags?: string[]
): Promise<Task> {
  const spec = parseGitHubTaskSpec(specContent);

  const response = await octokit.rest.issues.create({
    owner,
    repo,
    title: spec.title,
    body: spec.description || "",
    labels: [...getLabelsForTaskStatus("TODO", statusLabels), ...(tags || [])],
  });

  const taskId = `gh#${response.data.number}`;

  return {
    id: taskId,
    title: spec.title,
    status: "TODO",
    specPath,
    description: spec.description || "",
  };
}

/**
 * Create a new GitHub issue directly from a title and description.
 */
export async function createIssueFromTitleAndDescription(
  octokit: Octokit,
  owner: string,
  repo: string,
  title: string,
  description: string,
  statusLabels: Record<string, string>,
  tags?: string[]
): Promise<Task> {
  const response = await octokit.rest.issues.create({
    owner,
    repo,
    title,
    body: description || "",
    labels: [...getLabelsForTaskStatus("TODO", statusLabels), ...(tags || [])],
  });

  const taskId = `gh#${response.data.number}`;

  log.debug("Created GitHub issue successfully", {
    taskId,
    issueNumber: response.data.number,
    title,
  });

  return {
    id: taskId,
    title,
    status: "TODO",
    description,
  };
}

/**
 * Create a new GitHub issue directly from a title and spec body.
 */
export async function createIssueFromTitleAndSpec(
  octokit: Octokit,
  owner: string,
  repo: string,
  title: string,
  spec: string,
  statusLabels: Record<string, string>,
  tags?: string[]
): Promise<Task> {
  const response = await octokit.rest.issues.create({
    owner,
    repo,
    title,
    body: spec || "",
    labels: [...getLabelsForTaskStatus("TODO", statusLabels), ...(tags || [])],
  });

  const taskId = `gh#${response.data.number}`;

  log.debug("Created GitHub issue successfully", {
    taskId,
    issueNumber: response.data.number,
    title,
  });

  return {
    id: taskId,
    title,
    status: "TODO",
    description: spec,
    specPath: undefined,
  };
}

/**
 * Close a GitHub issue (marking it as deleted) and remove it from the database.
 */
export async function deleteIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  taskId: string,
  statusLabels: Record<string, string>,
  persistenceProvider?: import("../persistence/types").PersistenceProvider
): Promise<boolean> {
  try {
    const issueNumber = getTaskIdNumber(taskId);
    if (!issueNumber) {
      throw new Error(`Could not extract issue number from task ID ${taskId}`);
    }

    // Attempt to remove from database
    try {
      let provider: import("../persistence/types").PersistenceProvider;
      if (persistenceProvider) {
        provider = persistenceProvider;
      } else {
        const { PersistenceService } = await import("../persistence/service");
        provider = PersistenceService.getProvider();
      }

      if (provider.capabilities.sql) {
        const db = (await provider.getDatabaseConnection?.()) as
          | import("drizzle-orm/postgres-js").PostgresJsDatabase
          | undefined;
        if (db) {
          const { tasksTable } = await import("../storage/schemas/task-embeddings");
          const { eq } = await import("drizzle-orm");
          const result = await db.delete(tasksTable).where(eq(tasksTable.id, taskId));
          log.debug(`Deleted task ${taskId} from database`, {
            rowCount: (result as { rowCount?: number }).rowCount,
          });
        } else {
          log.debug(`No database connection available for task ${taskId} deletion`);
        }
      } else {
        log.debug(`Database provider does not support SQL for task ${taskId} deletion`);
      }
    } catch (dbError) {
      log.debug(
        `Could not delete task ${taskId} from database: ${getErrorMessage(dbError as Error)}`
      );
    }

    // Close the issue and add a DELETED label
    await octokit.rest.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      state: "closed",
      labels: [...getLabelsForTaskStatus("CLOSED", statusLabels), "DELETED"],
    });

    log.debug("Marked task as deleted in GitHub", { taskId });
    return true;
  } catch (error) {
    log.error("Failed to delete task", { id: taskId, error: getErrorMessage(error as Error) });
    return false;
  }
}
