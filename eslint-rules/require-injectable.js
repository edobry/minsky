/**
 * ESLint Rule: require-injectable
 *
 * Requires domain classes with names ending in Service, Storage, or Adapter
 * to have the @injectable() decorator for DI container registration.
 *
 * Catches patterns like:
 *   export class MyService { ... }  // missing @injectable()
 *
 * @see mt#916 — DI enforcement: require @injectable() on domain service classes
 */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require @injectable() decorator on domain Service/Storage/Adapter classes for DI container registration.",
    },
    messages: {
      requireInjectable:
        "Domain class '{{name}}' must have @injectable() decorator for DI container registration.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowedClasses: {
            type: "array",
            items: { type: "string" },
            description: "Class names that are exempt from this rule.",
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
    const allowedClasses = new Set(options.allowedClasses || []);

    const CLASS_NAME_PATTERN = /(Service|Storage|Adapter)$/;

    return {
      ExportNamedDeclaration(node) {
        if (!node.declaration || node.declaration.type !== "ClassDeclaration") return;

        const classDecl = node.declaration;
        if (!classDecl.id) return;

        const name = classDecl.id.name;
        if (!CLASS_NAME_PATTERN.test(name)) return;
        if (allowedClasses.has(name)) return;

        // Check if the class has an @injectable() decorator
        const decorators = classDecl.decorators || [];
        const hasInjectable = decorators.some((decorator) => {
          // @injectable() — CallExpression where callee is Identifier named "injectable"
          if (
            decorator.expression &&
            decorator.expression.type === "CallExpression" &&
            decorator.expression.callee &&
            decorator.expression.callee.type === "Identifier" &&
            decorator.expression.callee.name === "injectable"
          ) {
            return true;
          }
          // @injectable — bare identifier (no call)
          if (
            decorator.expression &&
            decorator.expression.type === "Identifier" &&
            decorator.expression.name === "injectable"
          ) {
            return true;
          }
          return false;
        });

        if (!hasInjectable) {
          context.report({
            node: classDecl,
            messageId: "requireInjectable",
            data: { name },
          });
        }
      },
    };
  },
};
