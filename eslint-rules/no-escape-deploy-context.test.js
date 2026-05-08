/**
 * @fileoverview Tests for no-escape-deploy-context ESLint rule.
 *
 * Covers the six cases enumerated in mt#1680's success criterion #4:
 *   (a) intra-package import → ALLOWED
 *   (b) escape-up import (the mt#1679 case) → FLAGGED
 *   (c) sibling-package import → FLAGGED
 *   (d) bare-package import (zod) → ALLOWED
 *   (e) parent-relative inside same package (../utils) → ALLOWED
 *   (f) workspace alias (@minsky/shared/...) → ALLOWED
 *
 * Plus: file outside any configured root → silently skipped (rule does not fire),
 * and a smoke pair for require() calls.
 *
 * @see mt#1680 (this rule)
 * @see mt#1679 (originating crash)
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule from "./no-escape-deploy-context.js";
import { RuleTester } from "eslint";
import * as tsParser from "@typescript-eslint/parser";
import path from "node:path";

const MSG_ESCAPE = "escapeDeployContext";

const repoRoot = process.cwd();

const REVIEWER_ROOT = "services/reviewer";
const MCP_ROOT = "services/minsky-mcp";

const PACKAGE_ROOTS = [REVIEWER_ROOT, MCP_ROOT];

const RULE_OPTIONS = [{ packageRoots: PACKAGE_ROOTS }];

function f(...parts) {
  return path.join(repoRoot, ...parts);
}

const tsTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

tsTester.run("no-escape-deploy-context", rule, {
  valid: [
    // (a) intra-package — same directory
    {
      code: 'import { B } from "./B";',
      filename: f("services", "reviewer", "src", "A.ts"),
      options: RULE_OPTIONS,
    },
    {
      code: 'import { Y } from "./utils/Y";',
      filename: f("services", "reviewer", "src", "A.ts"),
      options: RULE_OPTIONS,
    },

    // (d) bare-package — node_modules
    {
      code: 'import { z } from "zod";',
      filename: f("services", "reviewer", "src", "A.ts"),
      options: RULE_OPTIONS,
    },
    {
      code: 'import * as fs from "node:fs";',
      filename: f("services", "reviewer", "src", "A.ts"),
      options: RULE_OPTIONS,
    },

    // (e) parent-relative inside same package
    {
      code: 'import { Y } from "../utils/Y";',
      filename: f("services", "reviewer", "src", "sub", "X.ts"),
      options: RULE_OPTIONS,
    },

    // (f) workspace alias — bare specifier with scope
    {
      code: 'import { safeTruncate } from "@minsky/shared/safe-truncate";',
      filename: f("services", "reviewer", "src", "A.ts"),
      options: RULE_OPTIONS,
    },

    // File outside any configured package root — rule must not fire
    {
      code: 'import { Y } from "../../utils/Y";',
      filename: f("src", "domain", "foo", "bar.ts"),
      options: RULE_OPTIONS,
    },

    // require() smoke — intra-package
    {
      code: 'const B = require("./B");',
      filename: f("services", "reviewer", "src", "A.ts"),
      options: RULE_OPTIONS,
    },

    // excludeGlobs — file matching the glob is exempt even if its import escapes.
    // Mirrors the real-world case: services/*/railway.config.ts is deploy-config
    // consumed by scripts/railway/apply.ts on the host, not packaged into the image.
    {
      code: 'import { defineRailwayConfig } from "../../scripts/railway/lib";',
      filename: f("services", "minsky-mcp", "railway.config.ts"),
      options: [{ packageRoots: PACKAGE_ROOTS, excludeGlobs: ["services/*/railway.config.ts"] }],
    },
  ],

  invalid: [
    // (b) escape-up — exact mt#1679 shape
    {
      code: 'import { safeTruncate } from "../../../src/utils/safe-truncate";',
      filename: f("services", "reviewer", "src", "A.ts"),
      options: RULE_OPTIONS,
      errors: [
        {
          messageId: MSG_ESCAPE,
          data: { spec: "../../../src/utils/safe-truncate", packageRoot: REVIEWER_ROOT },
        },
      ],
    },

    // (c) sibling-package import
    {
      code: 'import { Y } from "../../minsky-mcp/src/Y";',
      filename: f("services", "reviewer", "src", "A.ts"),
      options: RULE_OPTIONS,
      errors: [
        {
          messageId: MSG_ESCAPE,
          data: { spec: "../../minsky-mcp/src/Y", packageRoot: REVIEWER_ROOT },
        },
      ],
    },

    // require() escape-up smoke
    {
      code: 'const safeTruncate = require("../../../src/utils/safe-truncate");',
      filename: f("services", "reviewer", "src", "A.ts"),
      options: RULE_OPTIONS,
      errors: [{ messageId: MSG_ESCAPE }],
    },

    // Same rule fires for the other configured package (services/minsky-mcp)
    {
      code: 'import { foo } from "../../../src/foo";',
      filename: f("services", "minsky-mcp", "src", "B.ts"),
      options: RULE_OPTIONS,
      errors: [
        {
          messageId: MSG_ESCAPE,
          data: { spec: "../../../src/foo", packageRoot: MCP_ROOT },
        },
      ],
    },
  ],
});
