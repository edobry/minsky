/**
 * @fileoverview ESLint rule to prevent direct construction of domain services, and (mt#2642 /
 *   ADR-026) the more general "DI-fallback" shape repo-wide.
 * @author Task mt#911; DI-fallback-shape check added by mt#2642
 *
 * Two independent checks live in this rule, each with its own file scope:
 *
 * 1. Named-list check (original, mt#911) — adapter layer only (`/src/adapters/`). Prevents
 *    inline construction of specific task-service identifiers that should be resolved from the
 *    DI container:
 *    - new TaskGraphService(...)
 *    - new TaskRoutingService(...)
 *    - new TaskSimilarityService(...)
 *    - createConfiguredTaskService(...)
 *
 * 2. DI-fallback-shape check (mt#2642, generalizing ADR-026 rule 3) — all of `src/` and
 *    `packages/domain/src/`. Flags the shape `<identifier> ?? create<PascalCase>(...)` and
 *    `<identifier>?.<prop> ?? new <PascalCase>(...)` regardless of the specific identifier
 *    names involved: an optional override falling back to a live construction bypasses DI
 *    registration and hides missing wiring in new callers (project memory `021b612a`,
 *    promoted to ADR-026 — `docs/architecture/adr-026-dependency-injection-convention.md`).
 *
 * These services must be injected via the DI container, or the dependency must be a required
 * (non-optional, non-fallback) `deps` parameter. Direct construction in the adapter layer, or
 * an optional-fallback construction anywhere in scope, bypasses the container and creates
 * invisible singletons / untested wiring gaps.
 */

import { minimatch } from "minimatch";

const BANNED_CONSTRUCTORS = ["TaskGraphService", "TaskRoutingService", "TaskSimilarityService"];

const BANNED_FACTORIES = ["createConfiguredTaskService"];

// Shape 1: `<identifier> ?? create<PascalCase>(...)` — factory-function naming convention.
const CREATE_FACTORY_PATTERN = /^create[A-Z]/;

// Shape 2's `new <PascalCase>(...)` right-hand side — any capitalized constructor name...
const PASCAL_CASE_CTOR_PATTERN = /^[A-Z]/;

// ...EXCEPT these well-known JS/TS built-in value constructors. `x?.y ?? new Date()` /
// `?? new Map()` / `?? new Set()` etc. are ordinary default-value idioms (e.g. "current time
// unless overridden for a test"), not the service-construction anti-pattern ADR-026 targets —
// flagging them would require allowlisting every such site for no architectural benefit
// (mt#2642 PR review: found via packages/domain/src/detectors/epic-decomposition-staleness.ts's
// `options?.now ?? new Date()`).
const BUILTIN_VALUE_CONSTRUCTORS = new Set([
  "Date",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "Promise",
  "Array",
  "Object",
  "Number",
  "String",
  "Boolean",
  "URL",
  "URLSearchParams",
  "Headers",
  "AbortController",
  "TextEncoder",
  "TextDecoder",
]);

/**
 * True for `x?.y` — a MemberExpression with optional chaining, wrapped in a ChainExpression
 * because it terminates a chain at the `??` boundary (verified against
 * @typescript-eslint/parser's actual AST output for `x?.y ?? new Z()`, mt#2642).
 */
function isOptionalMemberChain(node) {
  return (
    node.type === "ChainExpression" &&
    node.expression.type === "MemberExpression" &&
    node.expression.optional === true
  );
}

/**
 * DI-fallback-shape check's scope (mt#2642 / ADR-026): repo-root `src/` and
 * `packages/domain/src/` specifically — NOT sibling packages/services that also happen to
 * have their own `src/` directory (`packages/shared/src/`, `services/reviewer/src/`,
 * `cockpit-tray/src/`, etc.), which are out of this task's scope.
 */
function isInFallbackScope(normalizedFilename) {
  // `(^|\/)` (not a bare leading `/`) so this matches both absolute ESLint-runtime paths
  // (`/Users/.../minsky/src/foo.ts`) and the repo-root-relative paths RuleTester uses in
  // tests (`src/foo.ts`, with no leading slash).
  if (/(^|\/)packages\/domain\/src\//.test(normalizedFilename)) return true;
  if (/(^|\/)(packages|services|cockpit-tray)\//.test(normalizedFilename)) return false;
  return /(^|\/)src\//.test(normalizedFilename);
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "prevent direct construction of domain services (TaskGraphService, TaskRoutingService, TaskSimilarityService, createConfiguredTaskService) in the adapter layer, and the generalized DI-fallback shape (`x ?? createY(...)` / `x?.y ?? new Z(...)`) across src/ and packages/domain/src/ — use the DI container or a required deps parameter instead",
      category: "Architecture",
      recommended: false,
    },
    fixable: null,
    schema: [
      {
        type: "object",
        properties: {
          allowedFiles: {
            type: "array",
            items: { type: "string" },
            description:
              "Glob patterns for files where direct construction (the original named-list check) is permitted (e.g., composition roots, migration commands)",
          },
          allowedFallbackFiles: {
            type: "array",
            items: { type: "string" },
            description:
              "Glob patterns for files where the generalized DI-fallback shape (mt#2642) is permitted. Each entry in eslint.config.js must carry a one-line justification comment.",
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      directConstruction:
        "'new {{name}}(...)' directly constructs a domain service. " +
        "Resolve it from the DI container instead (container.get('{{token}}')).",
      directFactoryCall:
        "'{{name}}(...)' creates a service outside the DI container. " +
        "Use the container-provided taskService instead (container.get('taskService')).",
      diFallbackCreate:
        "'{{expr}}' is the banned DI-fallback shape (ADR-026): an optional value falling back " +
        "to '{{name}}(...)' bypasses the DI container and hides missing wiring from new " +
        "callers. Make the dependency a required parameter instead, or resolve it from the " +
        "DI container.",
      diFallbackNew:
        "'{{expr}}' is the banned DI-fallback shape (ADR-026): an optional value falling back " +
        "to 'new {{name}}(...)' bypasses the DI container and hides missing wiring from new " +
        "callers. Make the dependency a required parameter instead, or resolve it from the " +
        "DI container.",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const allowedFiles = options.allowedFiles || [];
    const allowedFallbackFiles = options.allowedFallbackFiles || [];

    const filename = context.getFilename();
    const normalizedFilename = filename.replace(/\\/g, "/");

    // Skip test files (both checks)
    const isTestFile =
      /\.(test|spec)\.(js|ts|jsx|tsx)$/.test(normalizedFilename) ||
      /\/(tests?|__tests__|spec)\//i.test(normalizedFilename);

    // Skip ESLint rule files (both checks) — they reference these names as string identifiers
    const isEslintRuleFile = normalizedFilename.includes("/eslint-rules/");

    if (isTestFile || isEslintRuleFile) {
      return {};
    }

    const visitors = {};

    // --- Check 1 (mt#911): named BANNED_CONSTRUCTORS/BANNED_FACTORIES, adapter-layer only ---
    const isAdapterLayer = normalizedFilename.includes("/src/adapters/");
    const isNamedCheckAllowed = allowedFiles.some((pattern) =>
      minimatch(normalizedFilename, pattern, { dot: true })
    );

    if (isAdapterLayer && !isNamedCheckAllowed) {
      visitors.NewExpression = (node) => {
        if (node.callee.type === "Identifier" && BANNED_CONSTRUCTORS.includes(node.callee.name)) {
          const tokenMap = {
            TaskGraphService: "taskGraphService",
            TaskRoutingService: "taskRoutingService",
            TaskSimilarityService: "taskSimilarityService",
          };
          context.report({
            node,
            messageId: "directConstruction",
            data: {
              name: node.callee.name,
              token: tokenMap[node.callee.name] || node.callee.name,
            },
          });
        }
      };

      visitors.CallExpression = (node) => {
        if (node.callee.type === "Identifier" && BANNED_FACTORIES.includes(node.callee.name)) {
          context.report({
            node,
            messageId: "directFactoryCall",
            data: { name: node.callee.name },
          });
        }
      };
    }

    // --- Check 2 (mt#2642 / ADR-026): generalized DI-fallback shape ---
    const isFallbackScope = isInFallbackScope(normalizedFilename);
    const isFallbackCheckAllowed = allowedFallbackFiles.some((pattern) =>
      minimatch(normalizedFilename, pattern, { dot: true })
    );

    if (isFallbackScope && !isFallbackCheckAllowed) {
      visitors.LogicalExpression = (node) => {
        if (node.operator !== "??") return;
        const { left, right } = node;

        // Shape 1: `<identifier> ?? create<PascalCase>(...)`
        if (
          left.type === "Identifier" &&
          right.type === "CallExpression" &&
          right.callee.type === "Identifier" &&
          CREATE_FACTORY_PATTERN.test(right.callee.name)
        ) {
          context.report({
            node,
            messageId: "diFallbackCreate",
            data: {
              expr: context.getSourceCode().getText(node),
              name: right.callee.name,
            },
          });
          return;
        }

        // Shape 2: `<identifier>?.<prop> ?? new <PascalCase>(...)`
        if (
          isOptionalMemberChain(left) &&
          right.type === "NewExpression" &&
          right.callee.type === "Identifier" &&
          PASCAL_CASE_CTOR_PATTERN.test(right.callee.name) &&
          !BUILTIN_VALUE_CONSTRUCTORS.has(right.callee.name)
        ) {
          context.report({
            node,
            messageId: "diFallbackNew",
            data: {
              expr: context.getSourceCode().getText(node),
              name: right.callee.name,
            },
          });
        }
      };
    }

    return visitors;
  },
};
