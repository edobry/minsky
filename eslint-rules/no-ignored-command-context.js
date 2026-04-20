/**
 * ESLint Rule: no-ignored-command-context
 *
 * Detects when shared command execute handlers ignore the context parameter
 * but the command's parameters include a DI-requiring field (e.g., `session`).
 *
 * Commands that accept `session` (or other DI-requiring params) need the
 * execution context to resolve dependencies via the lazy-deps closure pattern.
 * Ignoring context (_context, _ctx) in such commands causes runtime failures
 * when the DI container isn't wired through.
 *
 * The rule is self-maintaining: add a `session` param to any command and
 * the rule automatically requires context usage. No allowlist needed.
 *
 * @see mt#929 — Migrate shared commands to lazy-deps closure pattern
 */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow ignoring execution context in shared command handlers that accept DI-requiring parameters",
    },
    messages: {
      ignoredContext:
        "Shared command '{{commandId}}' accepts '{{diParam}}' parameter but ignores execution context (parameter '{{paramName}}'). Use the lazy-deps closure pattern for DI resolution.",
    },
    schema: [
      {
        type: "object",
        properties: {
          diRequiringParams: {
            type: "array",
            items: { type: "string" },
            description: "Parameter names that require DI resolution (default: ['session'])",
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    if (!filename.includes("/src/adapters/shared/commands/")) return {};

    const options = context.options[0] || {};
    const diRequiringParams = new Set(options.diRequiringParams || ["session"]);

    /**
     * Check if an AST node (object expression or variable reference) contains
     * any of the DI-requiring parameter keys.
     * Handles: inline objects, variable references, composeParams() calls,
     * and `satisfies` type assertions.
     */
    function findDiParam(node, scope) {
      if (!node) return null;

      // Direct object literal: { session: ..., repo: ... }
      if (node.type === "ObjectExpression") {
        for (const prop of node.properties) {
          const key = prop.key?.name || prop.key?.value;
          if (key && diRequiringParams.has(key)) return key;
        }
        return null;
      }

      // Variable reference: commitCommandParams
      if (node.type === "Identifier") {
        const variable = findVariableInScope(scope, node.name);
        if (variable?.defs?.[0]?.node?.init) {
          return findDiParam(variable.defs[0].node.init, scope);
        }
        return null;
      }

      // composeParams({ session: ... }, { message: ... })
      if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "composeParams"
      ) {
        for (const arg of node.arguments) {
          const found = findDiParam(arg, scope);
          if (found) return found;
        }
        return null;
      }

      // TSAsExpression or TSSatisfiesExpression (e.g., `... satisfies CommandParameterMap`)
      if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") {
        return findDiParam(node.expression, scope);
      }

      return null;
    }

    /**
     * Find a variable definition in the current or parent scopes.
     */
    function findVariableInScope(scope, name) {
      let current = scope;
      while (current) {
        const variable = current.variables?.find((v) => v.name === name);
        if (variable) return variable;
        current = current.upper;
      }
      return null;
    }

    return {
      CallExpression(node) {
        // Check callee is *.registerCommand
        if (node.callee.type !== "MemberExpression") return;
        if (node.callee.property.name !== "registerCommand") return;

        const arg = node.arguments[0];
        if (!arg || arg.type !== "ObjectExpression") return;

        // Find the 'parameters' property and check for DI-requiring params
        const paramsProp = arg.properties.find((p) => p.key?.name === "parameters");
        if (!paramsProp) return;

        const scope = context.sourceCode ? context.sourceCode.getScope(node) : context.getScope();
        const diParam = findDiParam(paramsProp.value, scope);
        if (!diParam) return; // No DI-requiring params — safe to ignore context

        // Find the 'id' property for the command name (for error message)
        const idProp = arg.properties.find((p) => p.key?.name === "id");
        const commandId = idProp?.value?.value || "unknown";

        // Find the 'execute' property
        const executeProp = arg.properties.find((p) => p.key?.name === "execute");
        if (!executeProp) return;

        const executeFn = executeProp.value;
        if (!executeFn.params || executeFn.params.length < 2) return;

        const contextParam = executeFn.params[1];
        const paramName = contextParam.name || contextParam.left?.name;
        if (paramName && paramName.startsWith("_")) {
          context.report({
            node: contextParam,
            messageId: "ignoredContext",
            data: { commandId, paramName, diParam },
          });
        }
      },
    };
  },
};
