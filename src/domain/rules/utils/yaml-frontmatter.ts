/**
 * YAML Frontmatter Utility
 *
 * Shared utility for serializing metadata as YAML frontmatter and combining
 * it with rule content.
 */

import * as jsYaml from "js-yaml";

/**
 * Serialize metadata as YAML frontmatter and prepend it to content.
 *
 * Uses js-yaml with options that avoid unnecessary quoting, and post-processes
 * description fields with special characters to ensure they use double quotes.
 *
 * @param content - The rule body text (without frontmatter)
 * @param data - Metadata object to serialize as YAML frontmatter
 * @returns Combined string: `---\n<yaml>\n---\n<content>`
 */
export function serializeYamlFrontmatter(content: string, data: object): string {
  // Use js-yaml's dump function directly with options to control quoting behavior
  let yamlStr = jsYaml.dump(data, {
    lineWidth: -1, // Don't wrap lines
    noCompatMode: true, // Use YAML 1.2
    quotingType: '"', // Use double quotes when necessary
    forceQuotes: false, // Don't force quotes on all strings
  });

  // Post-process to ensure descriptions with special characters use double quotes
  // Replace single-quoted descriptions with double-quoted ones
  yamlStr = yamlStr.replace(/^description: '(.+)'$/gm, (match, description) => {
    // Check if description contains special characters that warrant quoting
    if (description.includes(":") || description.includes("!") || description.includes("?")) {
      return `description: "${description}"`;
    }
    return match;
  });

  return `---\n${yamlStr}---\n${content}`;
}
