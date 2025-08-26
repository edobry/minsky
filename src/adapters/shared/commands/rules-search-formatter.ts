/**
 * Rules-specific formatters for similarity search results
 */

import type { EnhancedSearchResult } from "./similarity-command-factory";

/**
 * Rule-style result formatter (shows name [format] - description)
 * Format: "1. rule-name [cursor] - Description of the rule"
 */
export function ruleStyleFormatter(
  result: EnhancedSearchResult,
  index: number,
  showScore: boolean
): string {
  const name = result.name || result.id;
  const format = (result as any).format;
  const formatPart = format ? ` [${format}]` : "";
  const desc = result.description ? ` - ${result.description}` : "";
  const scorePart =
    showScore && result.score !== undefined ? `\nScore: ${result.score.toFixed(3)}` : "";
  return `${index + 1}. ${name}${formatPart}${desc}${scorePart}`;
}
