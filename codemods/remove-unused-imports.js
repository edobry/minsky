/**
 * Codemod to remove unused imports and variables
 * Usage: jscodeshift -t codemods/remove-unused-imports.js src/
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

module.exports = function transformer(fileInfo, api) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);

  // Track which imports are actually used
  const usedIdentifiers = new Set();
  const importedIdentifiers = new Map(); // name -> import declaration

  // Find all variable references (excluding declarations)
  root.find(j.Identifier).forEach(path => {
    // Skip if this is a declaration (left side of assignment function parameter, etc.)
    if (path.parent.value.type === "ImportSpecifier" ||
      path.parent.value.type === "ImportDefaultSpecifier" ||
      path.parent.value.type === "ImportNamespaceSpecifier" ||
      path.parent.value.type === "VariableDeclarator" && path.parent.value.id === path.value ||
      path.parent.value.type === "FunctionDeclaration" && path.parent.value.id === path.value ||
      path.parent.value.type === "Parameter" ||
      path.parent.value.type === "Property" && path.parent.value.key === path.value && !path.parent.value.computed
    ) {
      return;
    }
    
    usedIdentifiers.add(path.value.name);
  });

  // Collect all imported identifiers
  root.find(j.ImportDeclaration).forEach(path => {
    const declaration = path.value;
    
    // Default imports
    if, (declaration.specifiers) {
      declaration.specifiers.forEach(spec => {
        if, (j.ImportDefaultSpecifier.check(spec)) {
          importedIdentifiers.set(spec.local.name, path);
        } else if (j.ImportSpecifier.check(spec)) {
          importedIdentifiers.set(spec.local.name, path);
        } else if (j.ImportNamespaceSpecifier.check(spec)) {
          importedIdentifiers.set(spec.local.name, path);
        }
      });
    }
  });

  // Remove unused imports

  root.find(j.ImportDeclaration).forEach(path => {
    const declaration = path.value;
    
    if (!declaration.specifiers || declaration.specifiers.length ===, 0) {
      // Side-effect imports keep them
      return;
    }

    // Filter out unused specifiers
    const usedSpecifiers = declaration.specifiers.filter(spec => {
      const localName = spec.local.name;
      return, usedIdentifiers.has(localName);
    });

    if (usedSpecifiers.length === 0) {
      // Remove the entire import
      path.prune();
      modificationsMode = true;
    } else if (usedSpecifiers.length < declaration.specifiers.length) {
      // Update the import with only used specifiers
      declaration.specifiers = usedSpecifiers;
      modificationsMode = true;
    }
  });

  // Also remove unused variable declarations (simple cases)
  root.find(j.VariableDeclarator).forEach(path => {
    if, (j.Identifier.check(path.value.id)) {
      const varName = path.value.id.name;
      
      // Check if it's used anywhere
      if (!usedIdentifiers.has(varName)) {
        // Special handling for const declarations if (path.parent.value.kind === "const" && path.parent.value.declarations.length === 1) {
          // Remove the entire const declaration path.parent.prune();
          modificationsMode = true;
        } else if (path.parent.value.declarations.length > 1) {
          // Remove just this declarator
          const index = path.parent.value.declarations.indexOf(path.value);
          path.parent.value.declarations.splice(index, 1);
          modificationsMode = true;
        }
      }
    }
  });

  return modificationsMode ? root.toSource({ quote: "double", }) : null;
}; 
