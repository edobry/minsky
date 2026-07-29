/**
 * @fileoverview ESLint rule flagging `execSync(`/`spawnSync(`/`fetch(` call
 * sites that lack a timeout / AbortSignal argument (mt#3299, gate 2 of the
 * mt#3295 corpus-derived gate wave — the mechanizable slice of the
 * unguarded-edge-case class, 322 findings / 38%).
 *
 * Sibling of `no-unsafe-git-exec.js` (which covers `git`-specific
 * exec/execAsync calls and enforces the timeout-aware wrapper functions).
 * This rule is broader-but-shallower: it doesn't know about any specific
 * wrapper API, it just checks whether a `timeout`/`signal` option is present
 * inline. Example finding: "Unbounded execSync call in defaultRunGit can
 * hang the PreToolUse hook" (block-git-gh-cli.ts:126). Hooks
 * (.minsky/hooks/, .claude/hooks/) are the top concentration area for this
 * class (54 + 20 findings) and already have a per-hook timeout-budget
 * convention to lint against.
 *
 * Detection (permissive — false negatives preferred over false positives):
 *   - `execSync(cmd)` / `execSync(cmd, opts)` — flagged unless `opts` is an
 *     object literal containing a `timeout` property, OR `opts` is anything
 *     OTHER than an object literal (identifier, spread, etc. — can't
 *     statically verify, so skipped to avoid false positives).
 *   - `spawnSync(cmd, args, opts)` / `spawnSync(cmd, opts)` — same rule
 *     applied to whichever argument is an object literal in the timeout
 *     position (2nd or 3rd argument).
 *   - `fetch(url)` / `fetch(url, init)` — flagged unless `init` is an object
 *     literal containing a `signal` property, OR `init` is a non-literal
 *     (skipped, same permissive rule).
 *
 * Already-safe wrapper calls (`execGitWithTimeout`, `execAsync` from
 * `@minsky/shared/exec`, `gitPushWithTimeout` etc.) are skipped entirely —
 * they are the codebase's OWN timeout-enforcing primitives.
 *
 * Tracking task: mt#3299.
 */

const SAFE_WRAPPER_NAMES = new Set([
  "execGitWithTimeout",
  "execAsync",
  "gitPushWithTimeout",
  "gitPullWithTimeout",
  "gitFetchWithTimeout",
  "gitCloneWithTimeout",
]);

function calleeName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  return null;
}

/**
 * Classify whether `key` (e.g. "timeout"/"signal") is present on `arg`:
 *   - "absent"  — `arg` is undefined (no options argument at all) OR `arg` is
 *     an object literal that does NOT contain `key`. Both are clear
 *     violations — there is definitely no timeout/signal wired.
 *   - "present" — `arg` is an object literal that DOES contain `key`.
 *   - "unknown" — `arg` exists but isn't a literal (identifier, spread,
 *     etc.) — can't statically verify, so the caller should SKIP (permissive:
 *     false negatives preferred over false positives).
 */
function classifyOptionProperty(arg, key) {
  if (arg === undefined) return "absent";
  if (arg.type !== "ObjectExpression") return "unknown";
  const has = arg.properties.some((p) => {
    if (p.type !== "Property") return false;
    if (p.key.type === "Identifier") return p.key.name === key;
    if (p.key.type === "Literal") return p.key.value === key;
    return false;
  });
  return has ? "present" : "absent";
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Flag execSync/spawnSync/fetch call sites lacking a timeout/AbortSignal argument (mt#3299).",
      category: "Best Practices",
      recommended: true,
    },
    fixable: null,
    schema: [],
    messages: {
      missingTimeout:
        "{{callee}}(...) has no visible timeout/AbortSignal argument — an unbounded call here " +
        "can hang the calling process indefinitely. Pass a `timeout`/`signal` option, or use a " +
        "timeout-aware wrapper. See mt#3299.",
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (!name || SAFE_WRAPPER_NAMES.has(name)) return;

        if (name === "execSync") {
          const state = classifyOptionProperty(node.arguments[1], "timeout");
          if (state !== "absent") return; // "present" is safe; "unknown" is a permissive skip
          context.report({ node, messageId: "missingTimeout", data: { callee: name } });
          return;
        }

        if (name === "spawnSync") {
          // spawnSync(cmd, opts) or spawnSync(cmd, args, opts) — the options
          // object can be in either position. If EITHER position is a literal
          // WITH `timeout`, it's safe. If both positions are non-literals
          // (identifiers), skip (permissive — can't verify). Otherwise absent.
          const arg1State = classifyOptionProperty(node.arguments[1], "timeout");
          const arg2State = classifyOptionProperty(node.arguments[2], "timeout");
          if (arg1State === "present" || arg2State === "present") return;
          if (arg1State === "unknown" || arg2State === "unknown") return;
          context.report({ node, messageId: "missingTimeout", data: { callee: name } });
          return;
        }

        if (name === "fetch") {
          const state = classifyOptionProperty(node.arguments[1], "signal");
          if (state !== "absent") return;
          context.report({ node, messageId: "missingTimeout", data: { callee: name } });
        }
      },
    };
  },
};
