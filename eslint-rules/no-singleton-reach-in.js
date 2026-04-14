/**
 * @fileoverview ESLint rule to prevent singleton reach-in from non-composition-root files
 * @author Task #691
 *
 * Prevents singleton provider access from non-composition-root files:
 * - PersistenceService.getProvider() — static method call
 * - getSharedSessionProvider() — cached session provider singleton
 * - getPersistenceProvider() — direct import (not DI parameter usage)
 * - createSessionProvider() — factory that creates providers
 *
 * This enforces the architectural boundary that only composition roots
 * should wire up singleton providers.
 */

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

import { minimatch } from "minimatch";

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "prevent singleton provider reach-in (PersistenceService.getProvider, getSharedSessionProvider, getPersistenceProvider, createSessionProvider) outside composition root files",
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
      return minimatch(normalizedFilename, pattern, { dot: true });
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

        // Detect getSharedSessionProvider()
        if (node.callee.type === "Identifier" && node.callee.name === "getSharedSessionProvider") {
          context.report({
            node,
            messageId: "singletonReachIn",
            data: { call: "getSharedSessionProvider()" },
          });
        }

        // Detect getPersistenceProvider() — but only when called as a standalone function,
        // not when used as a parameter name in function definitions
        if (node.callee.type === "Identifier" && node.callee.name === "getPersistenceProvider") {
          context.report({
            node,
            messageId: "singletonReachIn",
            data: { call: "getPersistenceProvider()" },
          });
        }
      },
    };
  },
};
