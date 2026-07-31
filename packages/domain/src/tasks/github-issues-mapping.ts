/**
 * Mapping and conversion utilities for GitHub Issues task backend
 *
 * Pure functions for converting between GitHub Issues data and Minsky task data.
 */

import type { TaskData, TaskSpecData } from "../../../../src/types/tasks/taskData";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "../errors/index";
import { TASK_STATUS, TaskStatus } from "./taskConstants";
import { validateGitHubIssues, type GitHubIssue } from "../schemas/storage";

/**
 * Parse raw JSON content (GitHub issues) into TaskData array.
 */
export function parseGitHubIssues(
  content: string,
  statusLabels: Record<string, string>
): TaskData[] {
  try {
    const rawIssues = JSON.parse(content);
    const validatedIssues = validateGitHubIssues(rawIssues);

    // Filter for issues that have Minsky status labels
    const minskyStatusLabels = Object.values(statusLabels);
    const minskyIssues = validatedIssues.filter((issue) => {
      const issueLabels = issue.labels.map((label) =>
        typeof label === "string" ? label : (label.name ?? "")
      );
      return issueLabels.some((label) => label && minskyStatusLabels.includes(label));
    });

    log.debug(
      `Filtered ${minskyIssues.length} Minsky issues from ${validatedIssues.length} total issues`
    );

    return minskyIssues.map((issue) => convertIssueToTaskData(issue, statusLabels));
  } catch (error) {
    log.error("Failed to parse GitHub issues data", {
      error: getErrorMessage(error),
    });
    return [];
  }
}

/**
 * Format TaskData array back into a JSON string suitable for syncing to GitHub.
 */
export function formatGitHubTasks(tasks: TaskData[], statusLabels: Record<string, string>): string {
  return JSON.stringify(tasks.map((task) => convertTaskDataToIssueFormat(task, statusLabels)));
}

/**
 * Parse markdown spec content into a TaskSpecData object.
 */
export function parseGitHubTaskSpec(content: string): TaskSpecData {
  const lines = content.toString().split("\n");
  let title = "";
  const metadata: Record<string, unknown> = {};
  let currentSection = "";
  const descriptionLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("# ")) {
      title = trimmed.substring(2).trim();
      const taskIdMatch = title.match(/^Task (#\d+):/);
      if (taskIdMatch) {
        metadata.taskId = taskIdMatch[1] || "";
        title = title.substring(taskIdMatch[0].length).trim();
      }
    } else if (trimmed.startsWith("## ")) {
      currentSection = trimmed.substring(3).trim().toLowerCase();
      if (currentSection === "description") {
        descriptionLines.length = 0;
      }
    } else if (currentSection === "description" && trimmed) {
      descriptionLines.push(trimmed);
    }
  }

  return {
    title,
    body: descriptionLines.join("\n"),
    metadata,
  };
}

/**
 * Format a TaskSpecData object into markdown content.
 */
export function formatGitHubTaskSpec(spec: TaskSpecData): string {
  const { title, body, metadata } = spec;

  let content = `# Task ${metadata?.taskId || "#000"}: ${title}\n\n`;

  if (body) {
    content += `## Description\n${body}\n\n`;
  }

  if (metadata?.githubIssue) {
    const githubIssue = metadata.githubIssue as Record<string, unknown>;
    content += "## GitHub Issue\n";
    content += `- Issue: #${githubIssue.number}\n`;
    content += `- URL: ${githubIssue.html_url}\n`;
    content += `- State: ${githubIssue.state}\n\n`;
  }

  return content;
}

/**
 * Convert a validated GitHubIssue to a Minsky TaskData object.
 */
export function convertIssueToTaskData(
  issue: GitHubIssue,
  statusLabels: Record<string, string>
): TaskData {
  const taskId = extractTaskIdFromIssue(issue);
  const status = getTaskStatusFromIssue(issue, statusLabels);

  // Extract non-status labels as tags
  const statusLabelValues = Object.values(statusLabels);
  const tags = issue.labels
    .map((label) => (typeof label === "string" ? label : label.name || ""))
    .filter((name) => name && !statusLabelValues.includes(name));

  return {
    id: taskId,
    title: issue.title,
    spec: issue.body || "",
    status,
    tags,
  };
}

/**
 * Map a Minsky task status to the GitHub issue `state` + `state_reason` pair
 * per the projection contract defined by the mt#2310 RFC (GitHub Issues
 * backend section, Notion `3a4937f0-3cb4-81f2-8953-d148a63eba1a`):
 *
 * - DONE   -> closed, state_reason "completed"
 * - CLOSED -> closed, state_reason "not_planned"
 * - every non-terminal status -> open, state_reason null
 *
 * Both terminal statuses close the mirrored GitHub issue. Previously only
 * DONE did — a task cancelled/superseded via CLOSED left its GitHub issue
 * open indefinitely (mt#3012).
 */
export function getIssueStateForTaskStatus(status: TaskStatus | string): {
  state: "open" | "closed";
  state_reason: "completed" | "not_planned" | null;
} {
  if (status === TASK_STATUS.DONE) {
    return { state: "closed", state_reason: "completed" };
  }
  if (status === TASK_STATUS.CLOSED) {
    return { state: "closed", state_reason: "not_planned" };
  }
  return { state: "open", state_reason: null };
}

/**
 * Convert a TaskData object into the shape used to update/create a GitHub issue.
 */
export function convertTaskDataToIssueFormat(
  task: TaskData,
  statusLabels: Record<string, string>
): Record<string, unknown> {
  return {
    title: task.title,
    body: task.spec || "",
    labels: getLabelsForTaskStatus(task.status, statusLabels),
    ...getIssueStateForTaskStatus(task.status),
  };
}

/**
 * Extract a qualified Minsky task ID from a GitHub issue.
 *
 * Always uses `issue.number` as the canonical ID. Title/body extraction was
 * removed because it caused two critical bugs (mt#2572):
 *
 * 1. **Wrong id→content mapping** — if an issue title contains a reference like
 *    "Re-attempt task from gh#1762", extracting from the title would map the NEW
 *    issue (e.g. #1765) to gh#1762, so `tasks_get gh#1765` returned gh#1762's content.
 * 2. **Create-then-not-found** — the newly created issue was stored under the wrong
 *    ID (extracted from title), so looking it up by its real number returned nothing.
 *
 * The GitHub issue number is the immutable, unambiguous identifier assigned by
 * GitHub at creation time. All Minsky gh# IDs are `gh#<issue.number>`.
 */
export function extractTaskIdFromIssue(issue: {
  title: string;
  body: string | null;
  number: number;
}): string {
  return `gh#${issue.number}`;
}

/**
 * Derive a Minsky TaskStatus from the labels attached to a GitHub issue.
 *
 * Status labels take priority when present. When no configured status label
 * matches — e.g. an issue closed directly on GitHub without a corresponding
 * Minsky label update — a closed issue falls back to its native
 * `state_reason` rather than silently reverting to TODO: "completed" maps to
 * DONE, and any other value maps to CLOSED (the safe "closed, but not
 * specifically DONE" bucket). This includes `state_reason` values GitHub
 * adds later (e.g. `duplicate`, added Dec 2024) or a missing/null reason —
 * this function never throws on an unrecognized `state_reason` (mt#3012).
 */
export function getTaskStatusFromIssue(
  issue: {
    labels: Array<string | { name?: string | null }>;
    state?: string;
    state_reason?: string | null;
  },
  statusLabels: Record<string, string>
): TaskStatus {
  for (const [status, label] of Object.entries(statusLabels)) {
    if (issue.labels.some((l) => (typeof l === "string" ? l : l.name) === label)) {
      return status as TaskStatus;
    }
  }

  if (issue.state === "closed") {
    return issue.state_reason === "completed"
      ? (TASK_STATUS.DONE as TaskStatus)
      : (TASK_STATUS.CLOSED as TaskStatus);
  }

  return TASK_STATUS.TODO as TaskStatus;
}

/**
 * Return the GitHub label(s) that correspond to a given task status.
 */
export function getLabelsForTaskStatus(
  status: string,
  statusLabels: Record<string, string>
): string[] {
  return [(statusLabels[status] || statusLabels["TODO"]) as string];
}

/**
 * Generate a standard task specification document from title and description.
 */
export function generateTaskSpecification(title: string, description: string): string {
  return `# ${title}

## Context

${description}

## Requirements

## Solution

## Notes
`;
}

/**
 * Build a spec content string from a GitHub issue.
 */
export function buildSpecContentFromIssue(
  issue: {
    title: string;
    body: string | null;
    number: number;
    html_url: string;
    state: string;
    created_at: string;
    updated_at: string;
    labels: Array<string | { name?: string | null }>;
  },
  taskId: string,
  statusLabels: Record<string, string>
): string {
  const status = getTaskStatusFromIssue(issue, statusLabels);
  return `# Task ${taskId}: ${issue.title}

## Status
${status}

## Description
${issue.body || "No description provided"}

## GitHub Issue
- Issue: #${issue.number}
- URL: ${issue.html_url}
- State: ${issue.state}
- Created: ${issue.created_at}
- Updated: ${issue.updated_at}

## Labels
${issue.labels.map((label) => `- ${typeof label === "string" ? label : (label.name ?? "")}`).join("\n")}
`;
}
