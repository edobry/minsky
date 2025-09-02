/**
 * PR Title/Body Validation Utilities
 * Prevents title duplication patterns in session PR workflow
 */

import { log } from "../../utils/logger";

/**
 * Validates PR title and body to prevent duplication patterns
 */
export function validatePrContent(
  title: string,
  body?: string
): {
  isValid: boolean;
  errors: string[];
  sanitizedBody?: string;
} {
  const errors: string[] = [];
  let sanitizedBody = body;

  if (!title.trim()) {
    errors.push("PR title cannot be empty");
    return { isValid: false, errors };
  }

  // Check if body starts with the title (duplication pattern)
  if (body && body.trim()) {
    const bodyLines = body.trim().split("\n");
    const firstBodyLine = bodyLines[0]?.trim();

    if (firstBodyLine && isDuplicateContent(title.trim(), firstBodyLine)) {
      // Remove the duplicated title from body and mark as validation error
      sanitizedBody = bodyLines.slice(1).join("\n").trim();
      const message = `PR body must not repeat the title as the first line`;
      errors.push(message);
      log.warn("Detected duplicate title in PR body", {
        originalTitle: title,
        duplicatedLine: firstBodyLine,
        originalBodyLength: body.length,
        sanitizedBodyLength: sanitizedBody.length,
      });
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    sanitizedBody,
  };
}

/**
 * Checks if a string appears to be a duplicate of another string
 * with different formatting (useful for detecting various duplication patterns)
 */
export function isDuplicateContent(content1: string, content2: string): boolean {
  if (!content1 || !content2) return false;

  // Normalize both strings for comparison
  const normalize = (str: string) => {
    return (
      str
        .trim()
        .toLowerCase()
        // Remove markdown header prefixes (# ## ### etc.)
        .replace(/^#+\s*/, "")
        // Remove conventional commit prefixes (feat:, feat(scope):, etc.)
        .replace(/^[a-z]+!?\([^)]*\):\s*/i, "")
        .replace(/^[a-z]+!?:\s*/i, "")
        // Normalize task ID formats: md#123 -> #123, task-md-123 -> #123
        .replace(/(?:task-)?md[#-](\d+)/g, "#$1")
        // Normalize whitespace
        .replace(/\s+/g, " ")
        .trim()
    );
  };

  const norm1 = normalize(content1);
  const norm2 = normalize(content2);

  // Check if one is a substring of the other (handles "Implement X" vs "X" cases)
  return norm1.includes(norm2) || norm2.includes(norm1);
}

/**
 * Sanitizes PR body to remove common duplication patterns
 */
export function sanitizePrBody(title: string, body: string): string {
  if (!body.trim()) return body;

  const lines = body.split("\n");
  const filteredLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip lines that duplicate the title (handle undefined case)
    if (line && isDuplicateContent(line, title)) {
      log.debug("Skipping duplicate title line in PR body", {
        title,
        duplicateLine: line,
        lineIndex: i,
      });
      continue;
    }

    filteredLines.push(line || "");
  }

  return filteredLines.join("\n").trim();
}

/**
 * Comprehensive PR content validation and sanitization
 */
export function preparePrContent(
  title?: string,
  body?: string
): {
  title: string;
  body: string;
  warnings: string[];
} {
  const warnings: string[] = [];

  if (!title?.trim()) {
    throw new Error("PR title is required and cannot be empty");
  }

  let sanitizedBody = body || "";

  // Sanitize body to remove title duplication
  if (sanitizedBody.trim()) {
    const originalBodyLength = sanitizedBody.length;
    sanitizedBody = sanitizePrBody(title, sanitizedBody);

    if (sanitizedBody.length !== originalBodyLength) {
      warnings.push("Removed duplicate title content from PR body");
    }
  }

  return {
    title: title.trim(),
    body: sanitizedBody,
    warnings,
  };
}
