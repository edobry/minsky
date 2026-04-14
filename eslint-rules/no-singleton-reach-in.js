/**
 * @fileoverview ESLint rule to prevent singleton reach-in from non-composition-root files
 * @author Task #691
 *
 * Prevents PersistenceService.getProvider() and createSessionProvider() from being called
 * outside of explicitly allowlisted composition root files. This enforces the architectural
 * boundary that only composition roots should wire up singleton providers.
 */

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

/**
 * Convert a glob-style pattern to a regex.
 * Supports ** (any path segment), * (within a segment), and ? (single char).
 */
function globToRegex(pattern) {
  // Handle ** before * to avoid double-substitution
  // Split on **, replace *, then rejoin with .*
  const parts = pattern.replace(/\./g, "\\.").split("**");
  const withStarReplaced = parts.map((p) => p.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"));
  return new RegExp(withStarReplaced.join(".*"));
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "prevent PersistenceService.getProvider() and createSessionProvider() calls outside composition root files",
      category: "Architecture",
      recommended: false,
    },
    fixable: null,
    schema: [
      {
        type: "object",
        properties: {
          allowedFiles: {
            type: "array",
            items: { type: "string" },
            description:
              "Glob patterns for composition root files where singleton access is permitted",
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      singletonReachIn:
        "'{{call}}' is a singleton reach-in and may only be called from composition root files. " +
        "Pass the provider via dependency injection instead, or add this file to the allowedFiles list if it is a legitimate composition root.",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const allowedFiles = options.allowedFiles || [];

    const filename = context.getFilename();

    // Normalize path separators for cross-platform compatibility
    const normalizedFilename = filename.replace(/\\/g, "/");

    // Always skip test files — tests may call singletons to test them directly
    const isTestFile =
      /\.(test|spec)\.(js|ts|jsx|tsx)$/.test(normalizedFilename) ||
      /\/(tests?|__tests__|spec)\//i.test(normalizedFilename);

    if (isTestFile) {
      return {};
    }

    // Skip ESLint rule files — they reference these names as string identifiers
    if (normalizedFilename.includes("/eslint-rules/")) {
      return {};
    }

    // Check if the current file matches any of the allowlist patterns
    const isAllowed = allowedFiles.some((pattern) => {
      const regex = globToRegex(pattern);
      return regex.test(normalizedFilename);
    });

    if (isAllowed) {
      return {}; // File is a composition root — allow all calls
    }

    return {
      CallExpression(node) {
        // Detect PersistenceService.getProvider()
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === "PersistenceService" &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "getProvider"
        ) {
          context.report({
            node,
            messageId: "singletonReachIn",
            data: { call: "PersistenceService.getProvider()" },
          });
        }

        // Detect createSessionProvider()
        if (node.callee.type === "Identifier" && node.callee.name === "createSessionProvider") {
          context.report({
            node,
            messageId: "singletonReachIn",
            data: { call: "createSessionProvider()" },
          });
        }
      },
    };
  },
};
