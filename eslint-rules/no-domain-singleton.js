/**
 * ESLint Rule: no-domain-singleton
 *
 * Prevents exporting singleton instances from domain code.
 * Domain classes should use @injectable() and be registered with the DI container.
 *
 * Catches patterns like:
 *   export const myService = new MyService(...)
 *
 * @see mt#916 — DI enforcement: prevent domain singleton exports
 */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Prevent exporting singleton instances in domain code. Use @injectable() and the DI container instead.",
    },
    messages: {
      noDomainSingleton:
        "Do not export singleton instances (`export const {{name}} = new ...`) in domain code. Use @injectable() and the DI container instead.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowedNames: {
            type: "array",
            items: { type: "string" },
            description: "Variable names that are exempt from this rule.",
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    // Only apply to domain layer files
    if (!filename.includes("/src/domain/")) return {};

    const options = context.options[0] || {};
    const allowedNames = new Set(options.allowedNames || []);

    return {
      ExportNamedDeclaration(node) {
        if (!node.declaration || node.declaration.type !== "VariableDeclaration") return;

        for (const declarator of node.declaration.declarations) {
          if (!declarator.init || declarator.init.type !== "NewExpression") continue;
          if (declarator.id.type !== "Identifier") continue;

          const name = declarator.id.name;
          if (allowedNames.has(name)) continue;

          context.report({
            node: declarator,
            messageId: "noDomainSingleton",
            data: { name },
          });
        }
      },
    };
  },
};
