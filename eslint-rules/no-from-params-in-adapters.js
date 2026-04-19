/**
 * ESLint Rule: no-from-params-in-adapters
 *
 * Prevents importing *FromParams functions in adapter layer files.
 * These convenience functions create ad-hoc providers that bypass the DI container.
 * Command handlers must use getDeps() + SessionService instead.
 *
 * Catches both static imports:
 *   import { listSessionsFromParams } from "..."
 * and dynamic imports:
 *   const { listSessionsFromParams } = await import("...")
 *
 * @see mt#788 — MCP session_list empty after /mcp reconnect (root cause: DI bypass)
 */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Ban *FromParams imports in adapter layer to enforce DI usage (mt#788)",
    },
    messages: {
      noFromParamsInAdapters:
        "Do not import '{{name}}' in adapter layer. Use getDeps() and SessionService instead — ad-hoc provider creation bypasses the DI container (mt#788).",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    // Only apply to adapter layer files
    if (!filename.includes("/src/adapters/")) return {};

    // Only flag FromParams imports from session-related domain modules
    const SESSION_IMPORT_PATTERNS = [/domain\/session/, /domain\/session\//];

    function isSessionImport(source) {
      return SESSION_IMPORT_PATTERNS.some((pattern) => pattern.test(source));
    }

    function checkName(node, name) {
      if (name.endsWith("FromParams")) {
        context.report({
          node,
          messageId: "noFromParamsInAdapters",
          data: { name },
        });
      }
    }

    return {
      // Static imports: import { listSessionsFromParams } from "...domain/session..."
      ImportDeclaration(node) {
        if (!isSessionImport(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier") {
            checkName(specifier, specifier.imported.name);
          }
        }
      },

      // Dynamic imports: const { listSessionsFromParams } = await import("...domain/session...")
      VariableDeclarator(node) {
        if (
          node.id.type !== "ObjectPattern" ||
          !node.init ||
          node.init.type !== "AwaitExpression" ||
          !node.init.argument ||
          node.init.argument.type !== "ImportExpression"
        ) {
          return;
        }

        const source = node.init.argument.source;
        if (!source || source.type !== "Literal" || !isSessionImport(source.value)) {
          return;
        }

        for (const prop of node.id.properties) {
          if (prop.type === "Property" && prop.key.type === "Identifier") {
            checkName(prop.key, prop.key.name);
          }
        }
      },
    };
  },
};
