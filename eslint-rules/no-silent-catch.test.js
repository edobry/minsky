/**
 * @fileoverview Tests for no-silent-catch ESLint rule (mt#3299).
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule from "./no-silent-catch.js";
import { RuleTester } from "eslint";
import * as tsParser from "@typescript-eslint/parser";
import path from "node:path";

const repoRoot = process.cwd();

function srcFile(...parts) {
  return path.join(repoRoot, "src", ...parts);
}

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

tester.run("no-silent-catch", rule, {
  valid: [
    // Rethrow satisfies the rule.
    {
      code: "try { doThing(); } catch (e) { throw e; }",
      filename: srcFile("utils", "a.ts"),
    },
    // Wrapped rethrow also satisfies the rule.
    {
      code: 'try { doThing(); } catch (e) { throw new Error("wrapped", { cause: e }); }',
      filename: srcFile("utils", "a.ts"),
    },
    // Logger call satisfies the rule.
    {
      code: 'try { doThing(); } catch (e) { log.error("failed", e); }',
      filename: srcFile("utils", "b.ts"),
    },
    // console.error also satisfies the rule.
    {
      code: 'try { doThing(); } catch (e) { console.error("failed", e); }',
      filename: srcFile("utils", "b.ts"),
    },
    // this.logger.warn satisfies the rule.
    {
      code: 'try { doThing(); } catch (e) { this.logger.warn("failed", e); }',
      filename: srcFile("utils", "b.ts"),
    },
    // intentional-swallow comment inside the block satisfies the rule.
    {
      code: "try { doThing(); } catch (e) { /* intentional-swallow: best-effort cleanup */ }",
      filename: srcFile("utils", "c.ts"),
    },
    // Logger call nested inside an if-block still satisfies the rule.
    {
      code: 'try { doThing(); } catch (e) { if (verbose) { log.warn("failed", e); } }',
      filename: srcFile("utils", "d.ts"),
    },
    // Test files are excluded by default.
    {
      code: "try { risky(); } catch (e) {}",
      filename: srcFile("utils", "e.test.ts"),
    },
  ],
  invalid: [
    // Empty catch block.
    {
      code: "try { doThing(); } catch (e) {}",
      filename: srcFile("utils", "f.ts"),
      errors: [{ messageId: "silentCatch" }],
    },
    // Catch block that only assigns a variable — no throw/log/comment.
    {
      code: "let result; try { result = doThing(); } catch (e) { result = null; }",
      filename: srcFile("utils", "g.ts"),
      errors: [{ messageId: "silentCatch" }],
    },
    // Catch with no binding, still silent.
    {
      code: "try { doThing(); } catch { fallback(); }",
      filename: srcFile("utils", "h.ts"),
      errors: [{ messageId: "silentCatch" }],
    },
    // A comment that mentions something else (not the exact marker) doesn't count.
    {
      code: "try { doThing(); } catch (e) { /* ignoring this for now */ }",
      filename: srcFile("utils", "i.ts"),
      errors: [{ messageId: "silentCatch" }],
    },
  ],
});

console.log("no-silent-catch: all rule-tester cases pass");
