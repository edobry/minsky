#!/usr/bin/env bun
// Tests for the post-merge deploy-verification reminder (mt#2353).

import { describe, expect, test } from "bun:test";
import {
  parsePrUrl,
  extractMergedPrRef,
  buildDeployVerificationReminder,
  buildTrayReinstallReminder,
  decideDeployReminder,
  type PostMergeDeps,
} from "./deploy-verification-after-merge";
import type { ToolHookInput } from "./types";
import type { PrFile } from "./require-execution-evidence-before-merge";

const MERGE_TOOL = "mcp__minsky__session_pr_merge";
const PR_URL = "https://github.com/edobry/minsky/pull/1741";
const REPO = "edobry/minsky";
const INFRA_INDEX = "infra/index.ts";
const TRAY_FILE = "cockpit-tray/src-tauri/src/menu.rs";
const DEPLOY_WAIT = "deployment_wait-for-latest";
const INSTALL_LOCAL = "install-local.sh";
const f = (filename: string): PrFile => ({ filename, status: "modified" });

/** A merge tool_result carrying the given metadata. */
const mergeResult = (metadata: Record<string, unknown>): Record<string, unknown> => ({
  success: true,
  result: { mergeInfo: { metadata } },
});

/** A ToolHookInput for a successful merge with the given metadata. */
const mergeInput = (metadata: Record<string, unknown>): ToolHookInput => ({
  session_id: "s",
  cwd: "/repo",
  hook_event_name: "PostToolUse",
  tool_name: MERGE_TOOL,
  tool_input: { task: "mt#2353" },
  tool_result: mergeResult(metadata),
});

describe("parsePrUrl (mt#2353)", () => {
  test("parses owner/repo + number from a PR URL", () => {
    expect(parsePrUrl(PR_URL)).toEqual({ repo: REPO, prNumber: 1741 });
  });

  test("tolerates a trailing path/query/fragment", () => {
    expect(parsePrUrl(`${PR_URL}/files`)).toEqual({ repo: REPO, prNumber: 1741 });
  });

  test("returns null for a non-PR URL", () => {
    expect(parsePrUrl("https://github.com/edobry/minsky/issues/10")).toBeNull();
    expect(parsePrUrl("not a url")).toBeNull();
  });
});

describe("extractMergedPrRef (mt#2353)", () => {
  const failDerive = (): string | null => null;
  const stubDerive = (): string => REPO;

  test("prefers pr_url", () => {
    expect(extractMergedPrRef(mergeResult({ pr_url: PR_URL }), "/repo", failDerive)).toEqual({
      repo: REPO,
      prNumber: 1741,
    });
  });

  test("falls back to pr_number + derived repo when no pr_url", () => {
    expect(extractMergedPrRef(mergeResult({ pr_number: 1741 }), "/repo", stubDerive)).toEqual({
      repo: REPO,
      prNumber: 1741,
    });
  });

  test("null when pr_number present but repo cannot be derived", () => {
    expect(extractMergedPrRef(mergeResult({ pr_number: 1741 }), "/repo", failDerive)).toBeNull();
  });

  test("null when neither pr_url nor pr_number is present", () => {
    expect(extractMergedPrRef(mergeResult({}), "/repo", stubDerive)).toBeNull();
  });
});

describe("buildDeployVerificationReminder (mt#2353)", () => {
  test("names the files and the mandatory verify action + flake-is-blocker rule", () => {
    const r = buildDeployVerificationReminder([INFRA_INDEX]);
    expect(r).toContain(INFRA_INDEX);
    expect(r).toContain(DEPLOY_WAIT);
    expect(r).toContain("BLOCKER");
    expect(r).toContain("not the OUTCOME");
  });
});

describe("buildTrayReinstallReminder (mt#2976)", () => {
  test("names the tray files + the install-local.sh reinstall (agent, not operator)", () => {
    const r = buildTrayReinstallReminder([TRAY_FILE]);
    expect(r).toContain(TRAY_FILE);
    expect(r).toContain(INSTALL_LOCAL);
    expect(r).toContain("NOT the operator");
    expect(r).not.toContain(DEPLOY_WAIT);
  });
});

describe("decideDeployReminder (mt#2353)", () => {
  const depsReturning = (files: PrFile[]): PostMergeDeps => ({
    deriveRepo: () => REPO,
    fetchPrFiles: () => ({ files }),
  });

  test("reminds when the merged PR touched a deploy surface", () => {
    const reminder = decideDeployReminder(
      mergeInput({ pr_url: PR_URL }),
      depsReturning([f(INFRA_INDEX), f("src/app.ts")])
    );
    expect(reminder).not.toBeNull();
    expect(reminder).toContain(INFRA_INDEX);
  });

  test("silent when the merged PR touched no deploy surface", () => {
    const reminder = decideDeployReminder(
      mergeInput({ pr_url: PR_URL }),
      depsReturning([f("src/app.ts")])
    );
    expect(reminder).toBeNull();
  });

  test("silent for a non-merge tool", () => {
    const input: ToolHookInput = { ...mergeInput({ pr_url: PR_URL }), tool_name: "other" };
    expect(decideDeployReminder(input, depsReturning([f(INFRA_INDEX)]))).toBeNull();
  });

  test("silent when the merge did not succeed", () => {
    const input: ToolHookInput = {
      ...mergeInput({ pr_url: PR_URL }),
      tool_result: { success: false },
    };
    expect(decideDeployReminder(input, depsReturning([f(INFRA_INDEX)]))).toBeNull();
  });

  test("silent when the PR ref cannot be resolved", () => {
    const input = mergeInput({}); // no pr_url, no pr_number
    expect(decideDeployReminder(input, depsReturning([f(INFRA_INDEX)]))).toBeNull();
  });

  test("reminds to reinstall for a cockpit-tray merge — not deployment_wait-for-latest (mt#2976)", () => {
    const reminder = decideDeployReminder(
      mergeInput({ pr_url: PR_URL }),
      depsReturning([f(TRAY_FILE), f("cockpit-tray/README.md")])
    );
    expect(reminder).not.toBeNull();
    expect(reminder).toContain(INSTALL_LOCAL);
    expect(reminder).toContain(TRAY_FILE);
    expect(reminder).not.toContain(DEPLOY_WAIT);
  });

  test("emits BOTH reminders for a mixed Railway + tray merge (mt#2976)", () => {
    const reminder = decideDeployReminder(
      mergeInput({ pr_url: PR_URL }),
      depsReturning([f(INFRA_INDEX), f(TRAY_FILE)])
    );
    expect(reminder).toContain(DEPLOY_WAIT);
    expect(reminder).toContain(INSTALL_LOCAL);
  });

  test("silent for a cockpit-web change (not the tray binary) (mt#2976)", () => {
    const reminder = decideDeployReminder(
      mergeInput({ pr_url: PR_URL }),
      depsReturning([f("src/cockpit/web/App.tsx")])
    );
    expect(reminder).toBeNull();
  });
});
