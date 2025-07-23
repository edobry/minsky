/**
 * @fileoverview ESLint rule to prevent __tests__ directories and encourage co-located test files
 * @author Task #270 follow-up
 */

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

export default {
  meta: {
    type: "suggestion",
    docs: {
      description: "prevent __tests__ directories and encourage co-located test files",
      category: "Best Practices",
      recommended: true,
    },
    fixable: null, // This rule doesn't provide automatic fixes
    schema: [],
    messages: {
      testDirectoryFound:
        "Avoid __tests__ directories. Use co-located test files instead (e.g., 'module.test.ts' next to 'module.ts').",
      testFileInTestDirectory:
        "Move test file '{{filename}}' to be co-located with its module. Replace '__tests__/{{testFile}}' with '{{suggestedPath}}'.",
    },
  },

  create(context) {
    const filename = context.getFilename();

    // Check if we're in a __tests__ directory
    const isInTestsDirectory =
      filename.includes("/__tests__/") || filename.includes("\\__tests__\\");

    if (!isInTestsDirectory) {
      return {}; // No violations to report
    }

    // Extract information for helpful suggestions
    const parts = filename.split(/[/\\]/);
    const testsIndex = parts.findIndex((part) => part === "__tests__");
    const testFileName = parts[parts.length - 1];

    // Generate suggested co-located path
    let suggestedPath;
    if (testsIndex >= 0) {
      const beforeTests = parts.slice(0, testsIndex);
      const afterTests = parts.slice(testsIndex + 1);

      // Simple heuristic: if test file is module.test.ts, suggest module.test.ts in parent dir
      if (testFileName.endsWith(".test.ts") || testFileName.endsWith(".spec.ts")) {
        suggestedPath = [...beforeTests, testFileName].join("/");
      } else {
        suggestedPath = [...beforeTests, ...afterTests].join("/");
      }
    } else {
      suggestedPath = testFileName;
    }

    return {
      Program(node) {
        // Report the violation at the top of the file
        context.report({
          node,
          messageId: "testFileInTestDirectory",
          data: {
            filename: testFileName,
            testFile: testFileName,
            suggestedPath: suggestedPath,
          },
        });
      },
    };
  },
};
