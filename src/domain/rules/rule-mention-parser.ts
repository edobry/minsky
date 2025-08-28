/**
 * Utilities for parsing @ruleName mentions from user queries
 */

/**
 * Extracts @ruleName mentions from a query string
 * 
 * @param query - User query that may contain @ruleName syntax
 * @returns Array of rule names mentioned with @ syntax
 */
export function extractRuleMentions(query: string): string[] {
  if (!query || typeof query !== 'string') {
    return [];
  }

  // Match @ruleName pattern
  // - Must start with @ at word boundary (not in middle of email)
  // - Followed by word characters, hyphens, or underscores
  // - Ends at word boundary, space, or end of string
  const mentionPattern = /(?:^|[\s])@([a-zA-Z0-9_-]+)(?=[\s]|$)/g;
  const mentions: string[] = [];
  
  let match;
  while ((match = mentionPattern.exec(query)) !== null) {
    mentions.push(match[1]);
  }
  
  return [...new Set(mentions)]; // Remove duplicates
}

/**
 * Checks if a query contains any @ruleName mentions
 * 
 * @param query - User query to check
 * @returns True if query contains @ruleName syntax
 */
export function hasRuleMentions(query: string): boolean {
  return extractRuleMentions(query).length > 0;
}

/**
 * Removes @ruleName mentions from a query, leaving the rest of the text
 * for semantic similarity search
 * 
 * @param query - Original query with @ruleName mentions  
 * @returns Query with @mentions removed and cleaned up
 */
export function stripRuleMentions(query: string): string {
  if (!query || typeof query !== 'string') {
    return '';
  }

  // Remove @ruleName patterns and clean up extra whitespace
  const cleaned = query
    .replace(/(?:^|[\s])@[a-zA-Z0-9_-]+(?=[\s]|$)/g, ' ') // Remove @mentions (replace with space to avoid word joining)
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();

  return cleaned;
}
