/**
 * @fileoverview ESLint rule banning direct in-place collaborator patching (`spyOn`) in test
 * files, with a companion check that any spy which does slip through (e.g. via a documented
 * eslint-disable) is paired with a restore.
 *
 * Naming is principal-reserved (mt#3565) — this file name and the `custom/no-spy-patching`
 * rule id are a descriptive working name, not a final decision; treat as renameable.
 *
 * @see docs/architecture/adr-036-testing-doubles-mechanism-and-patching-ban.md
 * @author mt#3565
 */

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "ban in-place collaborator patching (spyOn) in test files; require a paired restore for any spy that survives via a documented exception",
      category: "Best Practices",
      recommended: true,
    },
    schema: [],
    messages: {
      spyOnBanned:
        "In-place patching via spyOn(...) is banned (ADR-036: docs/architecture/adr-036-" +
        "testing-doubles-mechanism-and-patching-ban.md). Extract the decision into a function " +
        "that returns the observable and inject the collaborator instead of patching it " +
        "(testing-standards.mdc §Testable Design) — functional core, imperative shell, one " +
        "wiring test per shell. If a seam is genuinely impossible for this site, get explicit " +
        "reviewer sign-off and mark it inline: " +
        "// eslint-disable-next-line custom/no-spy-patching -- <reason>.",
      spyOnUnrestored:
        "spyOn(...) result '{{name}}' has no paired .mockRestore() (or restoreAllMocks()) in " +
        "this file. Bun shares one module registry across every test file in a run and has no " +
        "restoreMocks-equivalent config (ADR-036) — an unrestored spy leaks its call history " +
        "into whichever test runs next against the same collaborator. Restore it in afterEach, " +
        "or call restoreAllMocks().",
    },
  },

  create(context) {
    const filename = context.getFilename();
    const isTestFile =
      /\.(test|spec)\.(js|ts|jsx|tsx)$/.test(filename) ||
      /\/(tests?|__tests__|spec)\//i.test(filename);

    if (!isTestFile) {
      return {};
    }

    // Track spyOn-derived variables (VariableDeclarator name -> the CallExpression node) so we
    // can check, at Program:exit, whether each was ever restored.
    const spyVariables = new Map();
    let sawRestoreAll = false;

    function isSpyOnCall(node) {
      return (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "spyOn"
      );
    }

    return {
      CallExpression(node) {
        if (isSpyOnCall(node)) {
          context.report({ node, messageId: "spyOnBanned" });

          // Record the holder variable, if this spyOn(...) call is the direct initializer of a
          // variable declarator (`const spy = spyOn(x, "y")`), for the restore-protocol check.
          const parent = node.parent;
          if (
            parent &&
            parent.type === "VariableDeclarator" &&
            parent.id.type === "Identifier" &&
            parent.init === node
          ) {
            spyVariables.set(parent.id.name, node);
          }
          return;
        }

        // restoreAllMocks() (bare or bun:test-namespaced) discharges every recorded spy in this
        // file — a simple, deliberately coarse heuristic matching the other rules in this
        // directory (see no-real-fs-in-tests.js's similarly heuristic global-counter tracking).
        if (
          (node.callee.type === "Identifier" && node.callee.name === "restoreAllMocks") ||
          (node.callee.type === "MemberExpression" &&
            !node.callee.computed &&
            node.callee.property.type === "Identifier" &&
            node.callee.property.name === "restoreAllMocks")
        ) {
          sawRestoreAll = true;
          return;
        }

        // <name>.mockRestore() or <name>.restore() discharges that one spy variable.
        if (
          node.callee.type === "MemberExpression" &&
          !node.callee.computed &&
          node.callee.object.type === "Identifier" &&
          node.callee.property.type === "Identifier" &&
          (node.callee.property.name === "mockRestore" || node.callee.property.name === "restore")
        ) {
          spyVariables.delete(node.callee.object.name);
        }
      },

      "Program:exit"() {
        if (sawRestoreAll) {
          return;
        }
        for (const [name, node] of spyVariables) {
          context.report({ node, messageId: "spyOnUnrestored", data: { name } });
        }
      },
    };
  },
};
