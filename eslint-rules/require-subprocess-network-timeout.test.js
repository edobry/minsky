/**
 * @fileoverview Tests for require-subprocess-network-timeout ESLint rule (mt#3299).
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule from "./require-subprocess-network-timeout.js";
import { RuleTester } from "eslint";
import * as tsParser from "@typescript-eslint/parser";

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

tester.run("require-subprocess-network-timeout", rule, {
  valid: [
    // execSync with a timeout option literal.
    { code: 'execSync("ls", { timeout: 5000 });' },
    // spawnSync with a timeout option literal in the 2nd position.
    { code: 'spawnSync("ls", { timeout: 5000 });' },
    // spawnSync with a timeout option literal in the 3rd position (cmd, args, opts).
    { code: 'spawnSync("git", ["status"], { timeout: 5000 });' },
    // fetch with an AbortSignal.
    { code: "fetch(url, { signal: controller.signal });" },
    // Non-literal options object — can't statically verify, so skipped (permissive).
    { code: "execSync(cmd, opts);" },
    // Already-safe wrapper functions are skipped entirely.
    { code: 'execGitWithTimeout("status", "git status", { workdir, timeout: 5000 });' },
    { code: 'await execAsync("git status");' },
    // Unrelated function calls are ignored.
    { code: 'doSomethingElse("x", { timeout: 5000 });' },
  ],
  invalid: [
    // execSync with no second argument at all.
    {
      code: 'execSync("ls");',
      errors: [{ messageId: "missingTimeout", data: { callee: "execSync" } }],
    },
    // execSync with an options literal missing `timeout`.
    {
      code: 'execSync("ls", { encoding: "utf8" });',
      errors: [{ messageId: "missingTimeout", data: { callee: "execSync" } }],
    },
    // spawnSync with no options at all.
    {
      code: 'spawnSync("ls");',
      errors: [{ messageId: "missingTimeout", data: { callee: "spawnSync" } }],
    },
    // fetch with no second argument.
    {
      code: "fetch(url);",
      errors: [{ messageId: "missingTimeout", data: { callee: "fetch" } }],
    },
    // fetch with an init literal missing `signal`.
    {
      code: 'fetch(url, { method: "POST" });',
      errors: [{ messageId: "missingTimeout", data: { callee: "fetch" } }],
    },
    // member-expression form (child_process.execSync) is also covered.
    {
      code: 'child_process.execSync("ls");',
      errors: [{ messageId: "missingTimeout", data: { callee: "execSync" } }],
    },
  ],
});

console.log("require-subprocess-network-timeout: all rule-tester cases pass");
