/**
 * ESLint Rule: no-ignored-command-context
 *
 * Detects when shared command execute handlers ignore the context parameter
 * (using `_context`, `_ctx`, or similar underscore-prefixed names).
 *
 * Commands that accept session-related params should use the lazy-deps closure
 * pattern for DI resolution rather than ignoring context entirely.
 *
 * Commands that genuinely don't need context (e.g., git.log, git.diff) can be
 * exempted via the `allowedCommands` option.
 *
 * @see mt#929 — Migrate shared commands to lazy-deps closure pattern
 */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow ignoring execution context in shared command handlers",
    },
    messages: {
      ignoredContext:
        "Shared command '{{commandId}}' ignores execution context (parameter '{{paramName}}'). Use the lazy-deps closure pattern for DI resolution.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowedCommands: {
            type: "array",
            items: { type: "string" },
            description:
              "Command IDs that are allowed to ignore context (e.g., commands without session params)",
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
    const allowedCommands = new Set(options.allowedCommands || []);

    return {
      CallExpression(node) {
        // Check callee is *.registerCommand
        if (node.callee.type !== "MemberExpression") return;
        if (node.callee.property.name !== "registerCommand") return;

        const arg = node.arguments[0];
        if (!arg || arg.type !== "ObjectExpression") return;

        // Find the 'id' property for the command name
        const idProp = arg.properties.find((p) => p.key?.name === "id");
        const commandId = idProp?.value?.value || "unknown";

        // Skip allowed commands (those that genuinely don't need context)
        if (allowedCommands.has(commandId)) return;

        // Find the 'execute' property
        const executeProp = arg.properties.find((p) => p.key?.name === "execute");
        if (!executeProp) return;

        const executeFn = executeProp.value;
        // Handle arrow functions and function expressions
        if (!executeFn.params || executeFn.params.length < 2) return;

        const contextParam = executeFn.params[1];
        const paramName = contextParam.name || contextParam.left?.name;
        if (paramName && paramName.startsWith("_")) {
          context.report({
            node: contextParam,
            messageId: "ignoredContext",
            data: { commandId, paramName },
          });
        }
      },
    };
  },
};
