/**
 * @fileoverview ESLint rule requiring every `catch` block to either rethrow,
 * log via the structured logger/console, or carry an explicit
 * `// intentional-swallow: <reason>` comment (mt#3299, gate 1 of the mt#3295
 * corpus-derived gate wave — silent-failure class, 47 findings / 5.6%).
 *
 * A catch block that does none of the three is a silent failure: the error
 * is discarded with no trace, no rethrow, and no documented reason it's safe
 * to discard. Example finding this class covers: "Latch still sets on
 * DB-insert failure because EventEmitter.emit() never signals failure"
 * (embeddings-health-tracker.ts:180).
 *
 * The three escape hatches, any ONE of which satisfies the rule:
 *   1. A `throw` statement anywhere in the catch block (rethrow, possibly
 *      wrapped/annotated).
 *   2. A call to a logger/console method (`log.error`, `logger.warn`,
 *      `console.error`, `this.logger.warn`, `req.log.error`,
 *      `getLogger().error`, `myLogger.warn`, `appLog.error`, etc.) — any
 *      `<receiver>.<level>(...)` where the level is one of
 *      error/warn/info/debug/log/fatal/trace and the receiver's name
 *      (the last property name in a member chain, a bare identifier, a
 *      computed string-literal key, or the callee name of a factory call
 *      like `getLogger()`) CONTAINS "log" or "console" as a substring,
 *      case-insensitively. Substring (not exact-name) matching is
 *      deliberate: a false NEGATIVE here (failing to recognize a real
 *      logging call under a locally-named variable like `myLogger`/`appLog`)
 *      causes a false POSITIVE at the rule level (a real log call wrongly
 *      flagged as "silent") — the failure mode reviewer feedback (PR #2392
 *      R1 BLOCKING #2) identified — so this favors recognizing too much
 *      over too little.
 *   3. A comment anywhere INSIDE the catch block's source range containing
 *      `intentional-swallow:`.
 *
 * Test files are excluded by default (`allowInTests`, default true) — a
 * catch block asserting "this does not throw" is a common, benign test
 * pattern distinct from the production silent-failure class this rule
 * targets.
 *
 * Tracking task: mt#3299.
 */

const LOG_METHOD_RE = /^(error|warn|info|debug|log|fatal|trace)$/;
// Substring match (not anchored to the whole name) — see the fileoverview
// doc comment above for why: a locally-aliased logger variable (`myLogger`,
// `appLog`, `reqLogger`) must still be recognized as a real logging call.
const LOG_RECEIVER_RE = /log|console/i;
const INTENTIONAL_SWALLOW_RE = /intentional-swallow:/;

/**
 * Extract a "name" to test against `LOG_RECEIVER_RE` from the receiver
 * expression of a `<receiver>.<method>(...)` call — the `callee.object` of
 * the CallExpression's MemberExpression callee. Handles:
 *   - a bare identifier (`logger`, `myLogger`, `console`)
 *   - a member-expression chain of any depth, taking the LAST property name
 *     (`this.logger`, `this.services.logger`, `req.log`)
 *   - a computed member expression with a static string-literal key
 *     (`obj["logger"]`)
 *   - a factory-call receiver (`getLogger()`, `createLogger()`) — uses the
 *     called function's own name
 *   - a `ChainExpression`-wrapped form of any of the above (optional
 *     chaining, e.g. `logger?.error(e)`)
 * Returns `null` for `ThisExpression` alone (`this.error()` is not a logger
 * call) and for any other shape this can't resolve to a name.
 */
function extractReceiverName(node) {
  if (!node) return null;
  switch (node.type) {
    case "Identifier":
      return node.name;
    case "MemberExpression":
      if (!node.computed && node.property.type === "Identifier") {
        return node.property.name;
      }
      if (
        node.computed &&
        node.property.type === "Literal" &&
        typeof node.property.value === "string"
      ) {
        return node.property.value;
      }
      // Computed with a non-literal key, or a non-identifier property —
      // fall back to the object side (rare shapes; best-effort).
      return extractReceiverName(node.object);
    case "CallExpression":
      // e.g. getLogger().error(e) — check the called function's own name.
      return extractReceiverName(node.callee);
    case "ChainExpression":
      return extractReceiverName(node.expression);
    default:
      return null;
  }
}

/** Recursively check whether any node in the subtree is a ThrowStatement. */
function containsThrow(node) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "ThrowStatement") return true;
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === "string" && containsThrow(child)) return true;
      }
    } else if (value && typeof value.type === "string") {
      if (containsThrow(value)) return true;
    }
  }
  return false;
}

/** Recursively check whether any node in the subtree is a qualifying logger call. */
function containsLoggerCall(node) {
  if (!node || typeof node !== "object") return false;
  // Unwrap a ChainExpression-wrapped call (optional chaining, e.g.
  // `logger?.error(e)`) to the CallExpression it wraps before the shape
  // check below, so the callee-inspection logic doesn't need its own
  // ChainExpression branch.
  const candidate = node.type === "ChainExpression" && node.expression ? node.expression : node;
  if (
    candidate.type === "CallExpression" &&
    candidate.callee &&
    candidate.callee.type === "MemberExpression"
  ) {
    const callee = candidate.callee;
    const methodName =
      callee.property && !callee.computed && callee.property.type === "Identifier"
        ? callee.property.name
        : callee.computed &&
            callee.property.type === "Literal" &&
            typeof callee.property.value === "string"
          ? callee.property.value
          : null;
    if (methodName && LOG_METHOD_RE.test(methodName)) {
      const receiverName = extractReceiverName(callee.object);
      if (receiverName && LOG_RECEIVER_RE.test(receiverName)) return true;
    }
  }
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === "string" && containsLoggerCall(child)) return true;
      }
    } else if (value && typeof value.type === "string") {
      if (containsLoggerCall(value)) return true;
    }
  }
  return false;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require every catch block to rethrow, log, or carry an " +
        "`// intentional-swallow: <reason>` comment (mt#3299).",
      category: "Best Practices",
      recommended: true,
    },
    fixable: null,
    schema: [
      {
        type: "object",
        properties: {
          allowInTests: {
            type: "boolean",
            default: true,
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      silentCatch:
        "catch block silently swallows the error — add a rethrow, a log.*/console.* call, " +
        "or an `// intentional-swallow: <reason>` comment explaining why discarding it is safe. " +
        "See mt#3299.",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const allowInTests = options.allowInTests !== false;
    const filename = context.getFilename();
    const isTestFile = /\.(test|spec)\.[jt]sx?$/.test(filename);
    if (allowInTests && isTestFile) return {};

    const sourceCode = context.getSourceCode();

    return {
      CatchClause(node) {
        if (containsThrow(node.body)) return;
        if (containsLoggerCall(node.body)) return;

        const commentsInside = sourceCode.getCommentsInside(node);
        const hasSwallowComment = commentsInside.some((c) => INTENTIONAL_SWALLOW_RE.test(c.value));
        if (hasSwallowComment) return;

        context.report({ node, messageId: "silentCatch" });
      },
    };
  },
};
