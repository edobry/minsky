/**
 * @fileoverview ESLint rule to prevent real filesystem operations and other pathological patterns in tests
 * @author Task #332
 */

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

export default {
  meta: {
    type: "problem",
    docs: {
      description: "prevent real filesystem operations and pathological patterns in tests",
      category: "Best Practices",
      recommended: true,
    },
    fixable: "code",
    schema: [
      {
        type: "object",
        properties: {
          allowedModules: {
            type: "array",
            items: { type: "string" },
          },
          testPatterns: {
            type: "array",
            items: { type: "string" },
          },
          strictMode: { type: "boolean" },
          allowTimestamps: { type: "boolean" },
          allowGlobalCounters: { type: "boolean" },
          allowDynamicImports: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      fsImport:
        "Real filesystem imports are forbidden in tests. Use mock.module() to mock filesystem operations instead.",
      fsOperation:
        "Real filesystem operation '{{operation}}' is forbidden in tests. Use in-memory mocks or test utilities instead.",
      tmpDirUsage:
        "tmpdir() usage detected. Use fixed mock directories like '/mock/tmp' to prevent race conditions.",
      globalCounter:
        "Global counter '{{name}}' detected in test file. Use test-scoped variables or mocks instead.",
      timestampUniqueness:
        "{{operation}} used for 'unique' path creation. This causes race conditions in parallel tests. Use mock paths like '/mock/test-123' instead.",
      dynamicImport:
        "Dynamic import() detected in test file. Use static imports to prevent infinite loops and timing issues.",
      realFsInHook:
        "Real filesystem operation '{{operation}}' in test hook. Use mock.module() to mock filesystem operations instead.",
      processCwdInTest:
        "process.cwd() detected in test file for path creation. Use mock paths to prevent environment dependencies.",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const allowedModules = options.allowedModules || ["mock"];
    const strictMode = options.strictMode !== false; // Default to true
    const allowTimestamps = options.allowTimestamps === true; // Default to false
    const allowGlobalCounters = options.allowGlobalCounters === true; // Default to false
    const allowDynamicImports = options.allowDynamicImports === true; // Default to false

    // Check if current file is a test file
    const filename = context.getFilename();
    const isTestFile =
      /\.(test|spec)\.(js|ts|jsx|tsx)$/.test(filename) ||
      /\/(tests?|__tests__|spec)\//i.test(filename);

    // Exclude ESLint rule test files from this rule (they intentionally contain violations)
    // Using multiple patterns to ensure all eslint rule test files are excluded
    const isEslintRuleTest = 
      filename.includes("eslint-rules") && filename.includes(".test.js") ||
      filename.endsWith("no-real-fs-in-tests.test.js") ||
      filename.endsWith("no-unsafe-git-network-operations.test.js");

    if (!isTestFile || isEslintRuleTest) {
      return {}; // Only apply to test files, but exclude ESLint rule tests
    }

    // Track global variable declarations
    const globalCounters = new Set();
    let isInTestHook = false;
    let currentHookName = null;

    // Forbidden filesystem imports
    const forbiddenFsImports = ["fs", "fs/promises", "node:fs", "node:fs/promises"];

    // Forbidden filesystem functions
    const forbiddenFsFunctions = [
      "mkdirSync",
      "mkdir",
      "rmSync",
      "rm",
      "rmdirSync",
      "rmdir",
      "writeFileSync",
      "writeFile",
      "readFileSync",
      "readFile",
      "existsSync",
      "exists",
      "statSync",
      "stat",
      "lstatSync",
      "lstat",
      "copyFileSync",
      "copyFile",
      "renameSync",
      "rename",
      "unlinkSync",
      "unlink",
      "readdirSync",
      "readdir",
      "createReadStream",
      "createWriteStream",
    ];

    return {
      // Check import statements for forbidden filesystem imports
      ImportDeclaration(node) {
        const source = node.source.value;

        if (forbiddenFsImports.includes(source)) {
          context.report({
            node,
            messageId: "fsImport",
            fix(fixer) {
              // Suggest mock module approach
              const comment = "// Use mock.module() to mock filesystem operations";
              return fixer.insertTextBefore(node, `${comment}\n// `);
            },
          });
        }

        // Check for os module tmpdir import
        if (source === "os" || source === "node:os") {
          const tmpDirImport = node.specifiers.find(
            (spec) => spec.imported && spec.imported.name === "tmpdir"
          );
          if (tmpDirImport) {
            context.report({
              node: tmpDirImport,
              messageId: "tmpDirUsage",
            });
          }
        }
      },

      // Check for filesystem function calls
      CallExpression(node) {
        // Check for filesystem operations
        if (node.callee.type === "Identifier" && forbiddenFsFunctions.includes(node.callee.name)) {
          const messageId = isInTestHook ? "realFsInHook" : "fsOperation";
          context.report({
            node,
            messageId,
            data: { operation: node.callee.name },
          });
        }

        // Check for member expressions like fs.mkdirSync
        if (node.callee.type === "MemberExpression") {
          const objectName = node.callee.object.name;
          const propertyName = node.callee.property.name;

          if (objectName === "fs" && forbiddenFsFunctions.includes(propertyName)) {
            const messageId = isInTestHook ? "realFsInHook" : "fsOperation";
            context.report({
              node,
              messageId,
              data: { operation: `${objectName}.${propertyName}` },
            });
          }

          // Check for tmpdir() calls
          if (propertyName === "tmpdir") {
            context.report({
              node,
              messageId: "tmpDirUsage",
            });
          }

          // Check for process.cwd() in path creation context
          if (objectName === "process" && propertyName === "cwd") {
            context.report({
              node,
              messageId: "processCwdInTest",
            });
          }

          // Check for timestamp-based uniqueness patterns
          if (!allowTimestamps && objectName === "Date" && propertyName === "now") {
            // Look for usage in path creation context
            const parent = node.parent;
            if (
              parent &&
              (parent.type === "TemplateLiteral" ||
                parent.type === "BinaryExpression" ||
                (parent.type === "CallExpression" && parent.callee.name === "join"))
            ) {
              context.report({
                node,
                messageId: "timestampUniqueness",
                data: { operation: "Date.now()" },
              });
            }
          }

          // Check for Math.random() in identifier context
          if (!allowTimestamps && objectName === "Math" && propertyName === "random") {
            const parent = node.parent;
            if (
              parent &&
              (parent.type === "TemplateLiteral" || parent.type === "BinaryExpression")
            ) {
              context.report({
                node,
                messageId: "timestampUniqueness",
                data: { operation: "Math.random()" },
              });
            }
          }
        }

        // Check for dynamic imports
        if (!allowDynamicImports && node.callee.type === "Import") {
          context.report({
            node,
            messageId: "dynamicImport",
          });
        }

        // Track test hooks
        if (
          node.callee.type === "Identifier" &&
          ["beforeEach", "afterEach", "beforeAll", "afterAll"].includes(node.callee.name)
        ) {
          isInTestHook = true;
          currentHookName = node.callee.name;
        }
      },

      // Track global variable declarations for counter patterns
      VariableDeclaration(node) {
        // Only check top-level declarations (outside describe blocks)
        // Use a simple heuristic: check if the declaration is at the top level of the program
        let parent = node.parent;
        let isTopLevel = true;

        while (parent) {
          if (
            parent.type === "CallExpression" &&
            parent.callee &&
            parent.callee.name &&
            ["describe", "it", "test", "beforeEach", "afterEach"].includes(parent.callee.name)
          ) {
            isTopLevel = false;
            break;
          }
          parent = parent.parent;
        }

        if (isTopLevel) {
          node.declarations.forEach((declarator) => {
            if (declarator.id.type === "Identifier") {
              const name = declarator.id.name;

              // Check for counter-like variable names
              if (!allowGlobalCounters && /(?:counter|sequence|number|count|index)$/i.test(name)) {
                globalCounters.add(name);
                context.report({
                  node: declarator,
                  messageId: "globalCounter",
                  data: { name },
                });
              }
            }
          });
        }
      },

      // Check for increment operations on global counters
      UpdateExpression(node) {
        if (!allowGlobalCounters && node.operator === "++" && node.argument.type === "Identifier") {
          const name = node.argument.name;
          if (globalCounters.has(name)) {
            context.report({
              node,
              messageId: "globalCounter",
              data: { name },
            });
          }
        }
      },

      // Reset test hook tracking
      "CallExpression:exit"(node) {
        if (
          node.callee.type === "Identifier" &&
          ["beforeEach", "afterEach", "beforeAll", "afterAll"].includes(node.callee.name)
        ) {
          isInTestHook = false;
          currentHookName = null;
        }
      },
    };
  },
};
