/**
 * Tasks-specific formatters for similarity search results
 */

import type { EnhancedSearchResult } from "./similarity-command-factory";

/**
 * Task-style result formatter (shows title [id] [status])
 * Format: "1. Task Title [mt#123] [IN-PROGRESS]"
 */
export function taskStyleFormatter(
  result: EnhancedSearchResult,
  index: number,
  showScore: boolean
): string {
  const title = result.name || result.id;
  const id = (result as any).displayId || result.id;
  const status = (result as any).status || "";
  const statusPart = status ? ` [${status}]` : "";
  const scorePart =
    showScore && result.score !== undefined ? `\nScore: ${result.score.toFixed(3)}` : "";
  return `${index + 1}. ${title} [${id}]${statusPart}${scorePart}`;
}
