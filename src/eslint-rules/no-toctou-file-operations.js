/**
 * @fileoverview ESLint rule to prevent TOCTOU (Time-of-Check-Time-of-Use) race conditions
 *
 * This rule prevents TOCTOU race conditions where file existence is checked before
 * creating directories or files, which was identified in Task #294 Phase 2 audit.
 *
 * @author Minsky Concurrency Audit Task #294
 */

"use strict";

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "prevent TOCTOU race conditions in file operations",
      category: "Possible Errors",
      recommended: true,
      url: "https://github.com/minsky/eslint-rules/no-toctou-file-operations",
    },
    fixable: "code",
    schema: [],
    messages: {
      toctouPattern:
        "TOCTOU race condition detected: {{checkFunction}} followed by {{useFunction}}. Use idempotent operation instead.",
      unsafeExistsCheck:
        "Unsafe file existence check before {{operation}}. {{operation}} with recursive: true is idempotent.",
      missingRecursive:
        "mkdir operation should use recursive: true to be idempotent and avoid race conditions.",
    },
  },

  create(context) {
    const sourceCode = context.getSourceCode();

    return {
      // Check for TOCTOU patterns in if statements
      IfStatement(node) {
        const test = node.test;

        // Check for !existsSync(path) pattern
        if (
          test.type === "UnaryExpression" &&
          test.operator === "!" &&
          test.argument.type === "CallExpression"
        ) {
          const call = test.argument;
          if (call.callee.type === "Identifier" && call.callee.name === "existsSync") {
            // Check what's inside the if block
            const consequent = node.consequent;
            const bodyStatements =
              consequent.type === "BlockStatement" ? consequent.body : [consequent];

            for (const stmt of bodyStatements) {
              if (
                stmt.type === "ExpressionStatement" &&
                stmt.expression.type === "CallExpression"
              ) {
                const innerCall = stmt.expression;
                if (innerCall.callee.type === "Identifier") {
                  const functionName = innerCall.callee.name;

                  // Detect mkdir after existsSync check
                  if (functionName === "mkdirSync" || functionName === "mkdir") {
                    context.report({
                      node,
                      messageId: "toctouPattern",
                      data: {
                        checkFunction: "existsSync",
                        useFunction: functionName,
                      },
                      fix(fixer) {
                        return generateMkdirFix(fixer, node, innerCall, sourceCode);
                      },
                    });
                  }

                  // Detect writeFileSync after existsSync check
                  if (functionName === "writeFileSync" || functionName === "writeFile") {
                    context.report({
                      node,
                      messageId: "toctouPattern",
                      data: {
                        checkFunction: "existsSync",
                        useFunction: functionName,
                      },
                    });
                  }
                }
              }
            }
          }
        }
      },

      // Check mkdir calls for missing recursive option
      CallExpression(node) {
        const callee = node.callee;

        if (
          callee.type === "Identifier" &&
          (callee.name === "mkdir" || callee.name === "mkdirSync")
        ) {
          const args = node.arguments;
          if (args.length >= 2) {
            const optionsArg = args[1];

            // Check if recursive option is present and true
            if (optionsArg.type === "ObjectExpression") {
              const recursiveProp = optionsArg.properties.find(
                (prop) => prop.key && prop.key.name === "recursive"
              );

              if (!recursiveProp) {
                context.report({
                  node,
                  messageId: "missingRecursive",
                  fix(fixer) {
                    // Add recursive: true to options
                    const lastProp = optionsArg.properties[optionsArg.properties.length - 1];
                    const insertAfter = lastProp || optionsArg;

                    const recursiveText =
                      optionsArg.properties.length > 0 ? ", recursive: true" : "recursive: true";

                    return fixer.insertTextAfter(insertAfter, recursiveText);
                  },
                });
              } else if (
                recursiveProp.value.type === "Literal" &&
                recursiveProp.value.value !== true
              ) {
                context.report({
                  node,
                  messageId: "missingRecursive",
                  fix(fixer) {
                    return fixer.replaceText(recursiveProp.value, "true");
                  },
                });
              }
            }
          } else if (args.length === 1) {
            // No options provided, suggest adding recursive: true
            context.report({
              node,
              messageId: "missingRecursive",
              fix(fixer) {
                return fixer.insertTextAfter(args[0], ", { recursive: true }");
              },
            });
          }
        }
      },
    };
  },
};

//------------------------------------------------------------------------------
// Helper Functions
//------------------------------------------------------------------------------

function generateMkdirFix(fixer, ifNode, mkdirCall, sourceCode) {
  // Replace the entire if statement with just the mkdir call
  const mkdirText = sourceCode.getText(mkdirCall);

  // Ensure the mkdir call has recursive: true
  const args = mkdirCall.arguments;
  let fixedMkdirText = mkdirText;

  if (args.length >= 2 && args[1].type === "ObjectExpression") {
    const optionsArg = args[1];
    const recursiveProp = optionsArg.properties.find(
      (prop) => prop.key && prop.key.name === "recursive"
    );

    if (!recursiveProp) {
      // Add recursive: true to existing options
      const optionsText = sourceCode.getText(optionsArg);
      const modifiedOptions = optionsText.replace(
        /}$/,
        optionsArg.properties.length > 0 ? ", recursive: true }" : "recursive: true }"
      );
      fixedMkdirText = mkdirText.replace(optionsText, modifiedOptions);
    }
  } else if (args.length === 1) {
    // Add options with recursive: true
    fixedMkdirText = mkdirText.replace(/\)$/, ", { recursive: true })");
  }

  return fixer.replaceText(ifNode, `${fixedMkdirText};`);
}
