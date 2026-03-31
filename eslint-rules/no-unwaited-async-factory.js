/**
 * @fileoverview ESLint rule to detect async factory functions called without await
 * @author Task #555
 *
 * Prevents a class of runtime bugs where async factory functions (returning Promises)
 * are assigned to variables without being awaited, resulting in a Promise object
 * being used where the resolved value was expected.
 *
 * Example bug this catches:
 *   this.provider = createSessionProvider(); // Bug: assigns Promise, not provider
 *   this.provider = await createSessionProvider(); // Correct
 */

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "detect async factory functions called without await, preventing Promise-instead-of-value bugs",
      category: "Possible Errors",
      recommended: true,
    },
    schema: [
      {
        type: "object",
        properties: {
          asyncFactoryFunctions: {
            type: "array",
            items: { type: "string" },
            description: "List of known async factory function names that must be awaited",
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingAwait:
        "Async factory function '{{name}}' must be awaited. " +
        "Assign in an async method or use lazy initialization.",
      cannotAwaitInConstructor:
        "Async factory function '{{name}}' cannot be awaited in a constructor. " +
        "Use an async init() method or lazy initialization pattern instead.",
      cannotAwaitInNonAsync:
        "Async factory function '{{name}}' must be awaited, but the enclosing function " +
        "is not async. Move this call to an async method.",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const asyncFactoryFunctions = options.asyncFactoryFunctions || ["createSessionProvider"];

    /**
     * Walk up ancestor nodes to find the enclosing function context.
     * Returns an object describing whether we're in a constructor, async function, or neither.
     */
    function getEnclosingFunctionContext(node) {
      let current = node.parent;
      while (current) {
        // Class field initializer (PropertyDefinition) - no function context, can't await
        if (current.type === "PropertyDefinition") {
          return { type: "classField", async: false, node: current };
        }

        // Constructor
        if (current.type === "FunctionExpression" || current.type === "FunctionDeclaration") {
          const parent = current.parent;
          if (parent && parent.type === "MethodDefinition" && parent.kind === "constructor") {
            return { type: "constructor", async: false, node: current };
          }
          return { type: "function", async: current.async, node: current };
        }

        // Arrow function
        if (current.type === "ArrowFunctionExpression") {
          return { type: "function", async: current.async, node: current };
        }

        current = current.parent;
      }

      // Module-level (top-level code) - treat as non-async context
      return { type: "module", async: false, node: null };
    }

    /**
     * Check if a CallExpression is calling one of the known async factory functions.
     */
    function isAsyncFactoryCall(callNode) {
      // Direct call: createSessionProvider()
      if (
        callNode.callee.type === "Identifier" &&
        asyncFactoryFunctions.includes(callNode.callee.name)
      ) {
        return callNode.callee.name;
      }

      // Member expression: something.createSessionProvider()
      if (
        callNode.callee.type === "MemberExpression" &&
        callNode.callee.property.type === "Identifier" &&
        asyncFactoryFunctions.includes(callNode.callee.property.name)
      ) {
        return callNode.callee.property.name;
      }

      return null;
    }

    /**
     * Check if a node is already wrapped in an await expression.
     */
    function isAwaited(node) {
      return node.parent && node.parent.type === "AwaitExpression";
    }

    /**
     * Check if a node is inside a .then() chain (considered properly handled).
     */
    function isInThenChain(node) {
      let current = node.parent;
      while (current) {
        if (
          current.type === "CallExpression" &&
          current.callee.type === "MemberExpression" &&
          current.callee.property.name === "then"
        ) {
          return true;
        }
        // Stop searching once we hit a statement boundary
        if (current.type === "ExpressionStatement" || current.type === "VariableDeclaration") {
          break;
        }
        current = current.parent;
      }
      return false;
    }

    return {
      CallExpression(node) {
        const factoryName = isAsyncFactoryCall(node);
        if (!factoryName) return;

        // If already awaited, it's fine
        if (isAwaited(node)) return;

        // If used in a .then() chain, it's fine
        if (isInThenChain(node)) return;

        // Check the enclosing function context
        const fnContext = getEnclosingFunctionContext(node);

        if (fnContext.type === "constructor" || fnContext.type === "classField") {
          context.report({
            node,
            messageId: "cannotAwaitInConstructor",
            data: { name: factoryName },
          });
        } else if (!fnContext.async) {
          context.report({
            node,
            messageId: "cannotAwaitInNonAsync",
            data: { name: factoryName },
          });
        } else {
          // In an async function but missing await
          context.report({
            node,
            messageId: "missingAwait",
            data: { name: factoryName },
          });
        }
      },
    };
  },
};
