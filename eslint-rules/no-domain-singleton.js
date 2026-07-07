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
 * @see ADR-026 — DI convention decision; mt#2623 fixed this rule's path filter after
 *      mt#2108's domain-package extraction (src/domain/ -> packages/domain/src/) silently
 *      turned it into a no-op for all post-extraction domain code.
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
    // Only apply to domain layer files. Matches both the legacy `src/domain/` location
    // and the post-mt#2108 `packages/domain/src/` location — see ADR-026 / the sibling
    // fix in require-injectable.js for the same path-filter staleness.
    const DOMAIN_PATH_PATTERN = /\/(src\/domain|packages\/domain\/src)\//;
    if (!DOMAIN_PATH_PATTERN.test(filename)) return {};

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
