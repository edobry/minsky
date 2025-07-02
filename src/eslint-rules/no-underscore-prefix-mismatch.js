/**
 * ESLint rule to prevent underscore prefix variable declaration/usage mismatches
 * 
 * This rule detects when variables are declared with underscore prefixes (e.g., const _variable = ...)
 * but then used without the underscore prefix (e.g., variable.something), which causes "not defined" errors.
 * 
 * This addresses the critical variable naming protocol violations encountered in Task 209.
 */

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow underscore prefix variables being declared but used without underscores",
      category: "Possible Errors",
      recommended: true,
    },
    fixable: "code",
    schema: [],
    messages: {
      underscorePrefixMismatch: "Variable '{{name}}' is declared with underscore prefix but used without underscore. Either remove underscore from declaration or use '{{prefixedName}}' consistently.",
      declarationShouldNotHaveUnderscore: "Variable '{{name}}' is used without underscore but declared with underscore prefix. Remove underscore from declaration: '{{unprefixedName}}'.",
    },
  },

  create(context) {
    // Track variables declared with underscore prefixes
    const underscorePrefixedVars = new Map();
    
    return {
      // Track variable declarations with underscore prefixes
      VariableDeclarator(node) {
        if (node.id.type === "Identifier" && node.id.name.startsWith("_")) {
          const varName = node.id.name;
          const unprefixedName = varName.slice(1);
          
          // Skip if it's intentionally marked as unused (common patterns)
          if (varName.startsWith("_unused") || varName.startsWith("_ignore")) {
            return;
          }
          
          underscorePrefixedVars.set(varName, {
            node: node.id,
            unprefixedName,
            scope: context.sourceCode.getScope(node),
          });
        }
      },

      // Check identifier usage for underscore prefix mismatches
      Identifier(node) {
        // Skip if this is a declaration, property key, or method name
        if (
          node.parent.type === "VariableDeclarator" && node.parent.id === node ||
          node.parent.type === "Property" && node.parent.key === node ||
          node.parent.type === "MethodDefinition" && node.parent.key === node ||
          node.parent.type === "FunctionDeclaration" && node.parent.id === node ||
          node.parent.type === "FunctionExpression" && node.parent.id === node
        ) {
          return;
        }

        const varName = node.name;
        
        // Check if this usage matches an underscore-prefixed declaration
        const prefixedName = `_${varName}`;
        
        if (underscorePrefixedVars.has(prefixedName)) {
          const declaration = underscorePrefixedVars.get(prefixedName);
          
          // Check if they're in the same scope or the declaration is in an outer scope
          let currentScope = context.sourceCode.getScope(node);
          let foundInScope = false;
          
          while (currentScope) {
            if (currentScope === declaration.scope) {
              foundInScope = true;
              break;
            }
            currentScope = currentScope.upper;
          }
          
          if (foundInScope) {
            context.report({
              node,
              messageId: "declarationShouldNotHaveUnderscore",
              data: {
                name: varName,
                unprefixedName: varName,
              },
              fix(fixer) {
                // Provide a fix to remove the underscore from the declaration
                return fixer.replaceText(declaration.node, varName);
              },
            });
          }
        }
      },
    };
  },
}; 
