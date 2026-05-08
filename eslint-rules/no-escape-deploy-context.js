/**
 * @fileoverview ESLint rule that flags relative imports escaping a separately-deployed
 * package's directory tree.
 *
 * Some Minsky packages (services/reviewer, services/minsky-mcp) are built and deployed
 * in isolation — their Dockerfiles only copy that package's directory into the build
 * context. A relative import like `../../../src/utils/safe-truncate` from inside such a
 * package resolves correctly during local development (because the parent `src/` exists
 * in the monorepo) but crashes at runtime in the deployed container with
 * `Cannot find module '...'`.
 *
 * This rule prevents that regression class. For files inside a configured `packageRoots`
 * entry, it flags any relative import (or `require()`) whose resolved path leaves the
 * package directory.
 *
 * Bare specifiers (`zod`, `@minsky/shared/...`) are allowed — those go through
 * `node_modules` or a workspace alias and resolve correctly in the deployed container.
 *
 * Reference: mt#1680 (this rule), mt#1679 (originating crash), mt#1626 (sibling
 * contract-propagation gate), mt#1681 (workspace shared-package extraction).
 */

import path from "node:path";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * True if `child` is the same as or under `parent` (both absolute, normalized).
 * Uses `path.relative`; if the relative path starts with `..` or is absolute,
 * `child` is outside `parent`.
 */
function isPathInside(parent, child) {
  const rel = path.relative(parent, child);
  if (rel === "") return true; // same directory
  if (rel === "..") return false;
  if (rel.startsWith("..")) {
    // Must not match e.g. "..a/b" — only true ".." segments
    const sep = path.sep;
    return !(rel === ".." || rel.startsWith(`..${sep}`));
  }
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * True if the import literal is a relative path (starts with "." or "..").
 * Bare specifiers (package names, workspace aliases, absolute paths) are not
 * relative imports and should not be checked by this rule.
 */
function isRelativeImport(spec) {
  if (typeof spec !== "string" || spec.length === 0) return false;
  return spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..";
}

/**
 * Convert a simple glob pattern to an anchored RegExp. Supports `*` (match
 * any characters except `/`) and `**` (match any characters including `/`).
 * Other regex-meaningful characters are escaped.
 */
function globToRegExp(glob) {
  const specials = /[.+^${}()|[\]\\]/g;
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 2;
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else {
      out += c.replace(specials, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

// ── Rule definition ──────────────────────────────────────────────────────────

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow relative imports that escape a separately-deployed package's directory tree",
      category: "Possible Errors",
      recommended: false,
      url: "https://github.com/edobry/minsky/blob/main/eslint-rules/no-escape-deploy-context.js",
    },
    schema: [
      {
        type: "object",
        properties: {
          packageRoots: {
            type: "array",
            items: { type: "string" },
            description:
              "Repo-root-relative paths whose contents are deployed in isolation (e.g., 'services/reviewer').",
          },
          excludeGlobs: {
            type: "array",
            items: { type: "string" },
            description:
              "Repo-root-relative path patterns (simple `*` and `**` globs) for files inside a package root that are NOT runtime-deployed and should be exempt (e.g., 'services/*/railway.config.ts', 'services/*/scripts/**').",
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      escapeDeployContext:
        "Import '{{spec}}' escapes deploy boundary '{{packageRoot}}'. The package at '{{packageRoot}}' is built and deployed in isolation; relative imports outside its tree won't resolve at runtime. Vendor the dependency into the package, or use a workspace-shared module (e.g., @minsky/shared — see mt#1681).",
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const packageRoots = Array.isArray(options.packageRoots) ? options.packageRoots : [];
    const excludeGlobs = Array.isArray(options.excludeGlobs) ? options.excludeGlobs : [];

    if (packageRoots.length === 0) {
      return {};
    }

    const repoRoot = context.cwd ?? process.cwd();
    const absoluteRoots = packageRoots.map((p) => ({
      configured: p,
      absolute: path.resolve(repoRoot, p),
    }));
    const excludeRegexps = excludeGlobs.map(globToRegExp);

    const sourceFile = context.physicalFilename ?? context.filename ?? "";
    if (!sourceFile || !path.isAbsolute(sourceFile)) {
      return {};
    }

    // Find the package root containing this source file (if any).
    const matchingRoot = absoluteRoots.find((r) => isPathInside(r.absolute, sourceFile));
    if (!matchingRoot) {
      // File is not under a configured deploy boundary; rule does not apply.
      return {};
    }

    // Check excludeGlobs against the repo-root-relative path. Use forward slashes
    // so the same patterns work cross-platform.
    const relPath = path.relative(repoRoot, sourceFile).split(path.sep).join("/");
    if (excludeRegexps.some((r) => r.test(relPath))) {
      return {};
    }

    const sourceDir = path.dirname(sourceFile);

    function checkImport(node, spec) {
      if (!isRelativeImport(spec)) return;
      const resolvedImport = path.resolve(sourceDir, spec);
      if (isPathInside(matchingRoot.absolute, resolvedImport)) return;
      context.report({
        node,
        messageId: "escapeDeployContext",
        data: { spec, packageRoot: matchingRoot.configured },
      });
    }

    return {
      ImportDeclaration(node) {
        if (node.source && typeof node.source.value === "string") {
          checkImport(node, node.source.value);
        }
      },
      ImportExpression(node) {
        // Dynamic imports — only check string-literal arguments.
        if (
          node.source &&
          node.source.type === "Literal" &&
          typeof node.source.value === "string"
        ) {
          checkImport(node, node.source.value);
        }
      },
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments.length >= 1 &&
          node.arguments[0].type === "Literal" &&
          typeof node.arguments[0].value === "string"
        ) {
          checkImport(node, node.arguments[0].value);
        }
      },
    };
  },
};
