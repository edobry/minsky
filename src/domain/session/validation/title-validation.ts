/**
 * PR Title Validation
 *
 * Validates PR titles to prevent body content from being accidentally placed in titles
 */

import { ValidationError } from "../../../errors/index.js";

export interface TitleValidationResult {
  isValid: boolean;
  errors: string[];
}

export interface TitleValidationRules {
  maxLength: number;
  noNewlines: boolean;
  noMarkdown: boolean;
  noMultiSentences: boolean;
}

export const DEFAULT_TITLE_VALIDATION_RULES: TitleValidationRules = {
  maxLength: 80,
  noNewlines: true,
  noMarkdown: true,
  noMultiSentences: true,
};

/**
 * Validates a PR title against the specified rules
 */
export function validatePrTitle(
  title: string,
  rules: TitleValidationRules = DEFAULT_TITLE_VALIDATION_RULES
): TitleValidationResult {
  const errors: string[] = [];

  // Check length
  if (title.length > rules.maxLength) {
    errors.push(
      `Title is too long (${title.length} characters, max ${rules.maxLength}). Use --body-path for detailed descriptions.`
    );
  }

  // Check for newlines
  if (rules.noNewlines && title.includes("\n")) {
    errors.push("Title contains newlines. Use --body-path for multi-line descriptions.");
  }

  // Check for markdown formatting
  if (rules.noMarkdown) {
    const markdownPatterns = [
      /^#+\s/, // Headers (# ## ###)
      /\*\*.*?\*\*/, // Bold text
      /\*.*?\*/, // Italic text
      /`.*?`/, // Code blocks
      /\[.*?\]\(.*?\)/, // Links
      /^\s*[-*+]\s/, // Bullet points
      /^\s*\d+\.\s/, // Numbered lists
      /^>\s/, // Blockquotes
    ];

    for (const pattern of markdownPatterns) {
      if (pattern.test(title)) {
        errors.push(
          "Title contains markdown formatting. Use plain text for titles and --body-path for formatted content."
        );
        break;
      }
    }
  }

  // Check for multiple sentences (multiple periods, question marks, or exclamation marks)
  if (rules.noMultiSentences) {
    // Count sentence enders but exclude common abbreviations and version numbers
    const cleanTitle = title
      .replace(/\bv?\d+\.\d+(\.\d+)?\b/g, "") // Remove version numbers like v2.0, 1.2.3
      .replace(/\b(etc|e\.g|i\.e|vs|Mr|Mrs|Dr)\./gi, ""); // Remove common abbreviations

    const sentenceEnders = cleanTitle.match(/[.!?]/g);
    if (sentenceEnders && sentenceEnders.length > 1) {
      errors.push(
        "Title appears to contain multiple sentences. Use --body-path for detailed PR descriptions."
      );
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Throws a ValidationError if the title is invalid
 */
export function assertValidPrTitle(
  title: string,
  rules: TitleValidationRules = DEFAULT_TITLE_VALIDATION_RULES
): void {
  const result = validatePrTitle(title, rules);
  if (!result.isValid) {
    throw new ValidationError(
      `Invalid PR title:\n${result.errors.map((error) => `  • ${error}`).join("\n")}`
    );
  }
}

/**
 * Detects if a title appears to contain body content (detailed implementation descriptions)
 */
export function titleAppearsToBeBodyContent(title: string): boolean {
  // Keywords that suggest implementation details rather than concise descriptions
  const bodyContentIndicators = [
    /\b(implementing|implementation|comprehensive|detailed|extensive|thorough)\b/i,
    /\b(includes?|including|contains?|containing|features?|adds?\s+support\s+for)\b/i,
    /\b(with\s+(secure|proper|comprehensive|full|complete|advanced))\b/i,
    /\b(by\s+(adding|creating|implementing|building|developing))\b/i,
    /\b(ensures?|provides?|allows?|enables?|supports?)\s+\w+\s+\w+/i, // Multi-word explanations
    /\b(storage|encryption|validation|authentication|authorization)\s+(including|with|using|via)\b/i,
  ];

  // Length-based heuristics
  if (title.length > 100) {
    return true;
  }

  // Check for implementation detail patterns
  return bodyContentIndicators.some((pattern) => pattern.test(title));
}

/**
 * Suggests improvements for a given title
 */
export function suggestTitleImprovements(title: string): string[] {
  const suggestions: string[] = [];
  const result = validatePrTitle(title);

  if (!result.isValid) {
    if (title.length > DEFAULT_TITLE_VALIDATION_RULES.maxLength) {
      suggestions.push("Consider using conventional commit format: type(scope): brief description");
      suggestions.push("Move implementation details to PR body using --body-path");
    }

    if (title.includes("\n")) {
      suggestions.push("Remove line breaks from title");
    }

    if (titleAppearsToBeBodyContent(title)) {
      suggestions.push("Use a concise action-oriented title instead of implementation details");
      suggestions.push(
        "Example: 'feat(auth): Add JWT token validation' instead of detailed explanations"
      );
    }
  }

  return suggestions;
}
