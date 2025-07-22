/**
 * @fileoverview Tests for no-unsafe-git-network-operations ESLint rule
 */

"use strict";

const rule = require("./no-unsafe-git-network-operations");
const { RuleTester } = require("eslint");

const ruleTester = new RuleTester({
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

//------------------------------------------------------------------------------
// Tests
//------------------------------------------------------------------------------

ruleTester.run("no-unsafe-git-network-operations", rule, {
  valid: [
    // Safe timeout wrapper functions
    'await gitPushWithTimeout("origin", "main", { workdir: "/path" });',
    'await gitPullWithTimeout("origin", "main", { workdir: "/path" });',
    'await gitFetchWithTimeout("origin", "main", { workdir: "/path" });',
    'await gitCloneWithTimeout("repo", "/path");',
    'await execGitWithTimeout("push", "push origin main", { workdir: "/path" });',

    // Local git operations (safe)
    'await execAsync("git status");',
    'await execAsync("git branch");',
    'await execAsync("git log");',
    'await execAsync("git diff");',
    'await execAsync("git add .");',
    'await execAsync("git commit -m \\"message\\"");',

    // Non-git commands
    'await execAsync("npm install");',
    'await execAsync("echo hello");',

    // Already using timeout wrapper
    'await execGitWithTimeout("fetch", "fetch origin", { workdir });',
  ],

  invalid: [
    // Basic unsafe patterns
    {
      code: 'await execAsync("git push origin main");',
      errors: [
        {
          messageId: "unsafeExecAsync",
          data: { command: "push", suggestion: "gitPushWithTimeout" },
        },
      ],
      output: 'await execGitWithTimeout("push", "push origin main", {});',
    },
    {
      code: 'await execAsync("git pull origin main");',
      errors: [
        {
          messageId: "unsafeExecAsync",
          data: { command: "pull", suggestion: "gitPullWithTimeout" },
        },
      ],
      output: 'await execGitWithTimeout("pull", "pull origin main", {});',
    },
    {
      code: 'await execAsync("git fetch origin");',
      errors: [
        {
          messageId: "unsafeExecAsync",
          data: { command: "fetch", suggestion: "gitFetchWithTimeout" },
        },
      ],
      output: 'await execGitWithTimeout("fetch", "fetch origin", {});',
    },
    {
      code: 'await execAsync("git clone https://github.com/user/repo.git /path");',
      errors: [
        {
          messageId: "unsafeExecAsync",
          data: { command: "clone", suggestion: "gitCloneWithTimeout" },
        },
      ],
      output:
        'await execGitWithTimeout("clone", "clone https://github.com/user/repo.git /path", {});',
    },

    // With working directory
    {
      code: 'await execAsync("git -C /repo push origin main");',
      errors: [
        {
          messageId: "unsafeExecAsync",
          data: { command: "push", suggestion: "gitPushWithTimeout" },
        },
      ],
      output: 'await execGitWithTimeout("push", "push origin main", { workdir: "/repo" });',
    },
    {
      code: 'await execAsync("git -C /repo fetch origin");',
      errors: [
        {
          messageId: "unsafeExecAsync",
          data: { command: "fetch", suggestion: "gitFetchWithTimeout" },
        },
      ],
      output: 'await execGitWithTimeout("fetch", "fetch origin", { workdir: "/repo" });',
    },

    // Template literals
    {
      code: "await execAsync(`git push origin ${branch}`);",
      errors: [
        {
          messageId: "unsafeGitNetworkOp",
          data: { command: "push", suggestion: "gitPushWithTimeout" },
        },
      ],
    },
    {
      code: "await execAsync(`git -C ${workdir} fetch ${remote}`);",
      errors: [
        {
          messageId: "unsafeGitNetworkOp",
          data: { command: "fetch", suggestion: "gitFetchWithTimeout" },
        },
      ],
    },

    // Missing await on timeout functions
    {
      code: 'gitPushWithTimeout("origin", "main", { workdir });',
      errors: [
        {
          messageId: "missingAwait",
          data: { functionName: "gitPushWithTimeout" },
        },
      ],
      output: 'await gitPushWithTimeout("origin", "main", { workdir });',
    },
    {
      code: 'execGitWithTimeout("fetch", "fetch origin", { workdir });',
      errors: [
        {
          messageId: "missingAwait",
          data: { functionName: "execGitWithTimeout" },
        },
      ],
      output: 'await execGitWithTimeout("fetch", "fetch origin", { workdir });',
    },

    // Edge cases
    {
      code: 'await execAsync("git ls-remote origin");',
      errors: [
        {
          messageId: "unsafeExecAsync",
          data: { command: "ls-remote", suggestion: "execGitWithTimeout" },
        },
      ],
      output: 'await execGitWithTimeout("ls-remote", "ls-remote origin", {});',
    },
  ],
});
