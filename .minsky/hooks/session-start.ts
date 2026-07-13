#!/usr/bin/env bun
// SessionStart hook: bootstrap remote session environment
// Only runs in remote (web) sessions

import { existsSync } from "fs";
import { execSync } from "./types";

// Only run in remote (web) sessions
if (process.env.CLAUDE_CODE_REMOTE !== "true") {
  process.exit(0);
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
process.chdir(process.env.CLAUDE_PROJECT_DIR!);

// Install Node dependencies if node_modules is missing or incomplete
// Uses bun install (not bun install --frozen-lockfile) to leverage cached container state
if (!existsSync("node_modules") || !existsSync("node_modules/winston")) {
  execSync(["bun", "install"]);
}

// Install gitleaks for secret scanning (required by pre-commit hook)
const whichResult = execSync(["which", "gitleaks"]);
if (whichResult.exitCode !== 0) {
  const GITLEAKS_VERSION = "8.21.2";
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`;
  execSync(["curl", "-sSL", "-o", "/tmp/gitleaks.tar.gz", url]);
  execSync(["tar", "xzf", "/tmp/gitleaks.tar.gz", "-C", "/tmp", "gitleaks"]);
  execSync(["mv", "/tmp/gitleaks", "/usr/local/bin/gitleaks"]);
  execSync(["rm", "-f", "/tmp/gitleaks.tar.gz"]);
}
