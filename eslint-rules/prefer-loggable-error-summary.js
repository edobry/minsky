/**
 * @fileoverview Flag a caught error rendered as `err.message` (or
 * `getErrorMessage(err)`) when that value is written into a LOG record, and
 * recommend `getLoggableErrorSummary` instead (mt#4632).
 *
 * ## What it catches, and why it matters
 *
 * `DrizzleQueryError.message` is built as `Failed query: <sql>\nparams: <params>`
 * and the real driver error is on `.cause`. So a log site rendering `err.message`
 * around a database call records the SQL and every bound parameter — and none of
 * the diagnosis. Measured during a 2026-08-25 degradation window: 4,685
 * characters of SELECT text plus 148 bound parameter values, with no Postgres
 * error anywhere in the line. A statement timeout, a severed socket, a pooler
 * rejection and a genuine SQL error all rendered identically.
 *
 * `getLoggableErrorSummary` (mt#2903) walks the `.cause` chain and truncates each
 * level INDEPENDENTLY, so the driver error survives however large the wrapper's
 * message is. Its own docblock states the policy this rule enforces:
 *
 *   > Use this instead of `getErrorMessage(err)` wherever a caught error is
 *   > written into a log record, ESPECIALLY around database calls.
 *
 * That policy shipped as prose and did not hold: 878 non-test sites still use the
 * bare form, and the count grew by 4 in `src/cockpit` over 17 hours while mt#4597
 * was converting 8 of them.
 *
 * ## What it deliberately does NOT catch
 *
 * A `throw` re-wrapping with `{ cause: err }`. `getLoggableErrorSummary`'s own
 * docblock is explicit that those propagate the chain intact and must not be
 * truncated at the throw — whatever eventually LOGS them bounds them there.
 * Flagging a throw site would push authors to discard detail, which is the
 * opposite of this rule's purpose.
 *
 * Logger detection is shared with `no-silent-catch` via `./logger-detection.js`
 * rather than reimplemented — see that module's fileoverview for why, and for the
 * receiver-matching caveat a consumer must decide for itself.
 */
// eslint-disable-next-line no-restricted-imports -- ESLint loads rule modules through Node's ESM loader, which requires the explicit .js extension; extensionless resolves under Bun but breaks `eslint` itself (verified mt#4632)
import { isLoggerCall } from "./logger-detection.js";

/**
 * Does this node render a caught error the bare way?
 *
 * Two forms, both extremely stable in this corpus:
 *   - `err instanceof Error ? err.message : String(err)`
 *   - `getErrorMessage(err)`
 */
function isBareErrorRendering(node) {
  if (!node || typeof node !== "object") return false;

  if (node.type === "ConditionalExpression") {
    const { test, consequent, alternate } = node;
    const testsInstanceofError =
      test &&
      test.type === "BinaryExpression" &&
      test.operator === "instanceof" &&
      test.right &&
      test.right.type === "Identifier" &&
      test.right.name === "Error";
    const takesDotMessage =
      consequent &&
      consequent.type === "MemberExpression" &&
      !consequent.computed &&
      consequent.property &&
      consequent.property.type === "Identifier" &&
      consequent.property.name === "message";
    const fallsBackToString =
      alternate &&
      alternate.type === "CallExpression" &&
      alternate.callee &&
      alternate.callee.type === "Identifier" &&
      alternate.callee.name === "String";
    return Boolean(testsInstanceofError && takesDotMessage && fallsBackToString);
  }

  return Boolean(
    node.type === "CallExpression" &&
      node.callee &&
      node.callee.type === "Identifier" &&
      node.callee.name === "getErrorMessage"
  );
}

/**
 * Is this expression inside an error-handling context?
 *
 * Two shapes count, and the second is why this is not a bare `CatchClause`
 * check (PR #3380 R1):
 *   1. A `catch (err) { … }` block — the spec's literal wording.
 *   2. A promise rejection handler — `.catch((err) => …)` and
 *      `.then(onOk, (err) => …)`. Semantically identical to (1): a caught error
 *      being rendered. Excluding it would leave the same defect unflagged purely
 *      because of which syntax the author reached for.
 *
 * Anything else — a bare value that merely happens to be `instanceof Error`-tested
 * outside any handler — is out of scope, which is what the reviewer's finding
 * asked for and what the measurement below confirmed is worth having.
 */
function isInErrorHandlingContext(node) {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "CatchClause") return true;
    if (
      (parent.type === "ArrowFunctionExpression" || parent.type === "FunctionExpression") &&
      parent.parent &&
      parent.parent.type === "CallExpression" &&
      parent.parent.callee &&
      parent.parent.callee.type === "MemberExpression" &&
      !parent.parent.callee.computed &&
      parent.parent.callee.property.type === "Identifier"
    ) {
      const method = parent.parent.callee.property.name;
      const args = parent.parent.arguments;
      // `.catch(fn)` — any position; `.then(onFulfilled, onRejected)` — the
      // SECOND argument only, since the first is the success path.
      if (method === "catch") return true;
      if (method === "then" && args.length > 1 && args[1] === parent) return true;
    }
    parent = parent.parent;
  }
  return false;
}

/**
 * Walk up from `node` looking for an enclosing logger call it feeds.
 *
 * Ascends rather than matching a fixed shape because the value is usually nested:
 * `log.warn("msg", { error: <expr> })` puts it two levels down, inside an object
 * property. Returns the logger CallExpression, or null.
 *
 * Two stops:
 *   - a `ThrowStatement` — the documented carve-out above; a value on its way
 *     into a throw is not a log site, even if a log call encloses the whole
 *     statement somehow.
 *   - a function boundary — a value inside a callback is evaluated in that
 *     callback's own context, not as an argument to the outer call.
 */
function enclosingLoggerCall(node) {
  let child = node;
  let parent = node.parent;
  while (parent) {
    if (parent.type === "ThrowStatement") return null;
    if (
      parent.type === "FunctionExpression" ||
      parent.type === "ArrowFunctionExpression" ||
      parent.type === "FunctionDeclaration"
    ) {
      return null;
    }
    // Reached a logger call — but only count it if we arrived through its
    // ARGUMENTS. Arriving via `callee` means the expression IS the callee, not
    // a value being logged.
    if (isLoggerCall(parent) && parent.callee !== child) return parent;
    child = parent;
    parent = parent.parent;
  }
  return null;
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer getLoggableErrorSummary over a bare err.message when writing a " +
        "caught error into a log record, so the error's cause survives",
    },
    schema: [],
    messages: {
      preferLoggableErrorSummary:
        "This logs `{{rendering}}`, which drops the error's `.cause` — for a wrapped " +
        "error (drizzle, fetch, spawn) that records the wrapper and none of the " +
        "diagnosis. Use `getLoggableErrorSummary(err)` from " +
        "`@minsky/domain/errors/index` instead. It walks the cause chain and bounds " +
        "each level independently. (mt#4632)",
    },
  },

  create(context) {
    function check(node) {
      if (!isBareErrorRendering(node)) return;
      // Scope to error handling (PR #3380 R1) — the spec says "catch-block
      // expressions", and without this the rule fired on any log-bound bare
      // rendering anywhere.
      if (!isInErrorHandlingContext(node)) return;
      if (!enclosingLoggerCall(node)) return;
      context.report({
        node,
        messageId: "preferLoggableErrorSummary",
        data: {
          rendering:
            node.type === "ConditionalExpression"
              ? "err instanceof Error ? err.message : String(err)"
              : "getErrorMessage(err)",
        },
      });
    }

    return {
      ConditionalExpression: check,
      CallExpression: check,
    };
  },
};
