/**
 * @fileoverview ESLint rule to prevent direct construction of domain services in adapter layer
 * @author Task mt#911
 *
 * Prevents inline construction of services that should be resolved from the DI container:
 * - new TaskGraphService(...)
 * - new TaskRoutingService(...)
 * - new TaskSimilarityService(...)
 * - createConfiguredTaskService(...)
 *
 * These services must be injected via the DI container. Direct construction
 * in the adapter layer bypasses the container and creates invisible singletons.
 */

import { minimatch } from "minimatch";

const BANNED_CONSTRUCTORS = ["TaskGraphService", "TaskRoutingService", "TaskSimilarityService"];

const BANNED_FACTORIES = ["createConfiguredTaskService"];

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "prevent direct construction of domain services (TaskGraphService, TaskRoutingService, TaskSimilarityService, createConfiguredTaskService) in the adapter layer — use DI container instead",
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
              "Glob patterns for files where direct construction is permitted (e.g., composition roots, migration commands)",
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      directConstruction:
        "'new {{name}}(...)' directly constructs a domain service. " +
        "Resolve it from the DI container instead (container.get('{{token}}')).",
      directFactoryCall:
        "'{{name}}(...)' creates a service outside the DI container. " +
        "Use the container-provided taskService instead (container.get('taskService')).",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const allowedFiles = options.allowedFiles || [];

    const filename = context.getFilename();
    const normalizedFilename = filename.replace(/\\/g, "/");

    // Only apply to adapter layer files
    if (!normalizedFilename.includes("/src/adapters/")) {
      return {};
    }

    // Skip test files
    const isTestFile =
      /\.(test|spec)\.(js|ts|jsx|tsx)$/.test(normalizedFilename) ||
      /\/(tests?|__tests__|spec)\//i.test(normalizedFilename);

    if (isTestFile) {
      return {};
    }

    // Skip ESLint rule files
    if (normalizedFilename.includes("/eslint-rules/")) {
      return {};
    }

    // Check allowlist
    const isAllowed = allowedFiles.some((pattern) => {
      return minimatch(normalizedFilename, pattern, { dot: true });
    });

    if (isAllowed) {
      return {};
    }

    return {
      NewExpression(node) {
        if (node.callee.type === "Identifier" && BANNED_CONSTRUCTORS.includes(node.callee.name)) {
          const tokenMap = {
            TaskGraphService: "taskGraphService",
            TaskRoutingService: "taskRoutingService",
            TaskSimilarityService: "taskSimilarityService",
          };
          context.report({
            node,
            messageId: "directConstruction",
            data: {
              name: node.callee.name,
              token: tokenMap[node.callee.name] || node.callee.name,
            },
          });
        }
      },

      CallExpression(node) {
        if (node.callee.type === "Identifier" && BANNED_FACTORIES.includes(node.callee.name)) {
          context.report({
            node,
            messageId: "directFactoryCall",
            data: { name: node.callee.name },
          });
        }
      },
    };
  },
};
