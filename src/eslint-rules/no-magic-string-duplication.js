/**
 * @fileoverview ESLint rule to detect magic string duplication in tests
 * @author Task #332 - Refactored from no-jest-patterns for proper separation of concerns
 */

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

export default {
  meta: {
    type: "suggestion",
    docs: {
      description: "detect duplicated magic strings that should be extracted to constants",
      category: "Best Practices",
      recommended: true,
    },
    fixable: null,
    schema: [
      {
        type: "object",
        properties: {
          minLength: {
            type: "number",
            default: 15,
            description: "Minimum string length to check for duplication",
          },
          minOccurrences: {
            type: "number",
            default: 3,
            description: "Minimum number of occurrences to report as duplication",
          },
          skipPatterns: {
            type: "array",
            items: { type: "string" },
            description: "Regex patterns for strings to skip checking",
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      magicStringDuplication:
        "Magic string '{{value}}' appears to be duplicated. Extract to shared constants or test-utils to prevent inconsistencies.",
    },
  },

  create(context) {
    // Check if current file is a test file
    const filename = context.getFilename();
    const isTestFile =
      /\.(test|spec)\.(js|ts|jsx|tsx)$/.test(filename) ||
      /\/(tests?|__tests__|spec)\//i.test(filename);

    if (!isTestFile) {
      return {}; // Only apply to test files
    }

    // Get configuration options
    const options = context.options[0] || {};
    const minLength = options.minLength || 15;
    const minOccurrences = options.minOccurrences || 3;
    const userSkipPatterns = options.skipPatterns || [];

    // Track magic strings for duplication detection
    const magicStrings = new Map(); // string -> array of locations

    // Default skip patterns for common test strings
    const defaultSkipPatterns = [
      /^test.*$/i,
      /^should.*$/i,
      /^expect.*$/i,
      /^describe.*$/i,
      /^it .*$/i,
      /^Error.*$/i,
      /^Mock.*$/i,
      /^\/.*\/$/, // paths
      /^http.*$/i, // URLs
      /^TODO$/i,
      /^IN-PROGRESS$/i,
      /^DONE$/i,
      /^BLOCKED$/i,
      /^IN_PROGRESS$/i,
      /^\/test\/workspace$/i,
      /^\/mock\/.*$/i,
      /^minsky:.*$/i,
      /^github-issues$/i,
      /^session\..*$/i,
      /^custom-session$/i,
      /^local-minsky$/i,
      /^task-.*$/i,
      /^md#.*$/i,
      /^gh#.*$/i,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*$/i, // ISO dates
      /^#\d+$/i, // ID patterns
    ];

    // Combine default and user skip patterns
    const allSkipPatterns = [
      ...defaultSkipPatterns,
      ...userSkipPatterns.map((pattern) => new RegExp(pattern)),
    ];

    return {
      // Check string literals for duplication
      Literal(node) {
        if (typeof node.value === "string" && node.value.length > minLength) {
          // Check if this string should be skipped
          const shouldSkip = allSkipPatterns.some((pattern) => pattern.test(node.value));
          if (shouldSkip) return;

          // Track this string
          if (!magicStrings.has(node.value)) {
            magicStrings.set(node.value, []);
          }

          magicStrings.get(node.value).push({
            node,
            line: node.loc.start.line,
            column: node.loc.start.column,
          });
        }
      },

      // Report duplications at end of file
      "Program:exit"() {
        for (const [stringValue, locations] of magicStrings.entries()) {
          // Only report if there are enough duplicates
          if (locations.length >= minOccurrences) {
            // Report all but the first occurrence as duplications
            for (let i = 1; i < locations.length; i++) {
              context.report({
                node: locations[i].node,
                messageId: "magicStringDuplication",
                data: {
                  value: stringValue.substring(0, 50) + (stringValue.length > 50 ? "..." : ""),
                },
              });
            }
          }
        }
      },
    };
  },
};
