/**
 * ESLint rule to prevent non-ASCII characters in identifier names
 *
 * Enforces the ensure-ascii-code-symbols rule at the linter level.
 * Non-ASCII characters in identifier names (variable names, function names,
 * class names, method names, etc.) are flagged as errors.
 *
 * String literals and comments are NOT flagged — intentional non-ASCII
 * content is allowed in those contexts.
 */

// Matches any character with code point U+0080 or above (non-ASCII).
// Uses \u{...} escapes with the `u` flag so the source file contains only
// printable ASCII, avoiding the no-control-regex lint error.
const NON_ASCII_RE = /[\u{0080}-\u{10FFFF}]/u;

/**
 * Check if a name contains non-ASCII characters and report if so.
 * The `reported` WeakSet prevents double-reporting when a parser shares
 * the same Identifier node for both ImportSpecifier.imported and
 * ImportSpecifier.local (no "as" rename), yet ESLint traverses both slots
 * and fires the Identifier visitor twice.
 *
 * @param {import('eslint').Rule.RuleContext} context
 * @param {WeakSet<object>} reported  Nodes already reported this file
 * @param {import('estree').Node} node  The AST node to attach the report to
 * @param {string} name  The identifier name to check
 */
function checkName(context, reported, node, name) {
  if (name && NON_ASCII_RE.test(name) && !reported.has(node)) {
    reported.add(node);
    context.report({
      node,
      messageId: "nonAsciiIdentifier",
      data: { name },
    });
  }
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow non-ASCII characters in identifier names",
    },
    schema: [],
    messages: {
      nonAsciiIdentifier:
        "Identifier '{{name}}' contains non-ASCII characters. Use ASCII-only names for code symbols.",
    },
  },

  create(context) {
    // Track nodes already reported to prevent double-reporting.
    const reported = new WeakSet();

    return {
      // Check Identifiers that appear in declaration / binding positions.
      // Plain reference usages (e.g., reading a variable) are skipped so that
      // a violation is reported exactly once, at the declaration site.
      Identifier(node) {
        const parent = node.parent;
        if (!parent) return;

        const isDeclarationId =
          // const/let/var name
          (parent.type === "VariableDeclarator" && parent.id === node) ||
          // named function / function expression
          (parent.type === "FunctionDeclaration" && parent.id === node) ||
          (parent.type === "FunctionExpression" && parent.id === node) ||
          // class name
          (parent.type === "ClassDeclaration" && parent.id === node) ||
          (parent.type === "ClassExpression" && parent.id === node) ||
          // object property key (non-computed): const obj = { grussen() {} }
          (parent.type === "Property" && parent.key === node && !parent.computed) ||
          // method definition key (non-computed): class C { grussen() {} }
          (parent.type === "MethodDefinition" && parent.key === node && !parent.computed) ||
          // class field (PropertyDefinition): class C { café = 1 }
          (parent.type === "PropertyDefinition" && parent.key === node && !parent.computed) ||
          // destructuring rest: const { ...cafe } = obj
          (parent.type === "RestElement" && parent.argument === node) ||
          // default-value pattern left side: function f(cafe = 1) {}
          (parent.type === "AssignmentPattern" && parent.left === node) ||
          // array destructuring element: const [café] = arr
          (parent.type === "ArrayPattern" && parent.elements.includes(node)) ||
          // import bindings: import { cafe } from "m"  /  import cafe from "m"
          (parent.type === "ImportSpecifier" && parent.local === node) ||
          (parent.type === "ImportDefaultSpecifier" && parent.local === node) ||
          (parent.type === "ImportNamespaceSpecifier" && parent.local === node) ||
          // export specifiers: export { cafe }  /  export { foo as café }
          (parent.type === "ExportSpecifier" &&
            (parent.local === node || parent.exported === node)) ||
          // TypeScript: type alias, interface, enum declarations
          (parent.type === "TSTypeAliasDeclaration" && parent.id === node) ||
          (parent.type === "TSInterfaceDeclaration" && parent.id === node) ||
          (parent.type === "TSEnumDeclaration" && parent.id === node) ||
          // TypeScript: enum members
          (parent.type === "TSEnumMember" && parent.id === node) ||
          // TypeScript: type parameter (generic T in <T>).
          // @typescript-eslint/parser represents TSTypeParameter.name as an
          // Identifier node, so this Identifier's parent will be TSTypeParameter
          // and parent.name will be this node.
          (parent.type === "TSTypeParameter" && parent.name === node) ||
          // TypeScript: interface property / method signatures (non-computed)
          (parent.type === "TSPropertySignature" && parent.key === node && !parent.computed) ||
          (parent.type === "TSMethodSignature" && parent.key === node && !parent.computed);

        if (isDeclarationId) {
          checkName(context, reported, node, node.name);
        }
      },

      // Catch clause binding: catch (erreur) {}
      CatchClause(node) {
        if (node.param && node.param.type === "Identifier") {
          checkName(context, reported, node.param, node.param.name);
        }
      },

      // Plain function parameters: function f(cafe) {} / (cafe) => {}
      // These Identifiers have the function as their parent, which is not
      // covered by the VariableDeclarator / AssignmentPattern checks above.
      "FunctionDeclaration, FunctionExpression, ArrowFunctionExpression"(node) {
        for (const param of node.params) {
          if (param.type === "Identifier") {
            checkName(context, reported, param, param.name);
          }
        }
      },
    };
  },
};
