/**
 * @fileoverview Shared logger-call detection for ESLint rules that need to know
 * whether an expression is (or reaches) a call into the structured logger.
 *
 * Extracted verbatim from `no-silent-catch.js` (mt#3299) by mt#4632, which needs
 * the same discrimination for the opposite question. The two rules form a ladder
 * on one axis:
 *
 *   no-silent-catch          — this catch logs NOTHING
 *   prefer-loggable-error-summary — this catch logs the WRONG THING
 *
 * Sharing the matcher is the point: a second, independently-written logger
 * matcher would drift from this one, and the drift would be invisible because
 * both rules would still look correct in isolation.
 *
 * ## Why substring matching on the receiver
 *
 * Carried over from the original, including its rationale (PR #2392 R1
 * BLOCKING #2): the receiver name is matched as a SUBSTRING, not an exact name,
 * so a locally-aliased logger (`myLogger`, `appLog`, `reqLogger`) is still
 * recognized. For `no-silent-catch` a missed logger produces a false POSITIVE
 * (a real log call reported as "silent"), so over-recognizing is the safe
 * direction there.
 *
 * **That asymmetry does NOT carry over to every consumer, and a new one must
 * decide for itself.** For `prefer-loggable-error-summary` the polarity is
 * inverted — it flags things that ARE log calls, so over-recognition produces a
 * false POSITIVE for it too, but by the opposite route (flagging a non-log call
 * that happens to have a `log`-ish receiver name). Same direction of caution,
 * different mechanism; noted here so a third consumer does not assume the
 * original rationale generalizes without checking.
 */

/** Logger method names: `log.error(...)`, `logger.warn(...)`, etc. */
export const LOG_METHOD_RE = /^(error|warn|info|debug|log|fatal|trace)$/;

/**
 * Receiver-name match, deliberately a SUBSTRING test — see the fileoverview.
 * Matches `log`, `logger`, `myLogger`, `appLog`, `console`, `reqLogger`, …
 */
export const LOG_RECEIVER_RE = /log|console/i;

/**
 * Extract a "name" to test against {@link LOG_RECEIVER_RE} from the receiver
 * expression of a `<receiver>.<method>(...)` call — the `callee.object` of the
 * CallExpression's MemberExpression callee. Handles:
 *   - a bare identifier (`logger`, `myLogger`, `console`)
 *   - a member-expression chain of any depth, taking the LAST property name
 *     (`this.logger`, `this.services.logger`, `req.log`)
 *   - a computed string-literal key (`obj["logger"]`)
 *   - a factory call (`getLogger().error(e)`) — checks the callee's own name
 *   - a `ChainExpression`-wrapped form of any of the above (optional chaining,
 *     e.g. `logger?.error(e)`)
 *
 * Returns `null` for `ThisExpression` alone (`this.error()` is not a logger
 * call) and for any other shape this cannot resolve to a name.
 */
export function extractReceiverName(node) {
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

/**
 * Is THIS node itself a qualifying logger call?
 *
 * The single-node half of {@link containsLoggerCall}, split out because a
 * consumer asking "is this expression an ARGUMENT to a log call" needs to test
 * one node rather than search a subtree. The recursion below is unchanged; this
 * is a decomposition, not a behaviour change.
 */
export function isLoggerCall(node) {
  if (!node || typeof node !== "object") return false;
  // Unwrap a ChainExpression-wrapped call (optional chaining, e.g.
  // `logger?.error(e)`) so the callee-inspection below needs no branch for it.
  const candidate = node.type === "ChainExpression" && node.expression ? node.expression : node;
  if (
    candidate.type !== "CallExpression" ||
    !candidate.callee ||
    candidate.callee.type !== "MemberExpression"
  ) {
    return false;
  }
  const callee = candidate.callee;
  const methodName =
    callee.property && !callee.computed && callee.property.type === "Identifier"
      ? callee.property.name
      : callee.computed &&
          callee.property.type === "Literal" &&
          typeof callee.property.value === "string"
        ? callee.property.value
        : null;
  if (!methodName || !LOG_METHOD_RE.test(methodName)) return false;
  const receiverName = extractReceiverName(callee.object);
  return Boolean(receiverName && LOG_RECEIVER_RE.test(receiverName));
}

/** Recursively check whether any node in the subtree is a qualifying logger call. */
export function containsLoggerCall(node) {
  if (!node || typeof node !== "object") return false;
  if (isLoggerCall(node)) return true;
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
