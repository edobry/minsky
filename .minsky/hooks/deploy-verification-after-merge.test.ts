#!/usr/bin/env bun
// Tests for the post-merge deploy-verification reminder (mt#2353).

import { describe, expect, test } from "bun:test";
import {
  parsePrUrl,
  extractMergedPrRef,
  buildDeployVerificationReminder,
  buildTrayReinstallReminder,
  decideDeployReminder,
  renderAffectedServicesLine,
  type PostMergeDeps,
} from "./deploy-verification-after-merge";
import { findAffectedServices } from "./deploy-surface-detector";
import type { ToolHookInput } from "./types";
import type { PrFile } from "./require-execution-evidence-before-merge";

const MERGE_TOOL = "mcp__minsky__session_pr_merge";
const PR_URL = "https://github.com/edobry/minsky/pull/1741";
const REPO = "edobry/minsky";
const INFRA_INDEX = "infra/index.ts";
const TRAY_FILE = "cockpit-tray/src-tauri/src/menu.rs";
// mt#5002's originating file: consumed by the cockpit at build time, but attributed
// to minsky-mcp by DEPLOY_SURFACE_SERVICE_MAP's `/^src\//` entry (mt#4013).
const CATALOG_JSON = "src/generated/interceptor-catalog.json";
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
    const r = buildDeployVerificationReminder([INFRA_INDEX], ["minsky-mcp"]);
    expect(r).toContain(INFRA_INDEX);
    expect(r).toContain(DEPLOY_WAIT);
    expect(r).toContain("BLOCKER");
    expect(r).toContain("not the OUTCOME");
  });
});

// mt#5002 — the reminder NAMES the affected services instead of saying "the
// affected service(s)". Two sessions (2026-09-04, 2026-09-09) read that phrase,
// picked the service by reasoning about which code consumes the changed file,
// ran the check against the wrong one, and concluded the gate was broken.
describe("renderAffectedServicesLine (mt#5002)", () => {
  test("names every service, backticked, and cites the predicate it came from", () => {
    const line = renderAffectedServicesLine(["minsky-mcp", "reviewer"]);
    expect(line).toContain("`minsky-mcp`");
    expect(line).toContain("`reviewer`");
    expect(line).toContain("findAffectedServices");
  });

  // AT3 — an empty set is a finding, not a formatting case. The line must say so
  // and must NOT send the agent hunting for a service by consumption reasoning.
  test("an EMPTY set is stated explicitly, with the anti-pattern named", () => {
    const line = renderAffectedServicesLine([]);
    expect(line).toContain("NONE resolved");
    expect(line).toContain("Do NOT pick a service");
    expect(line).toContain("DEPLOY_SURFACE_SERVICE_MAP");
    // Never an empty backtick pair or a dangling colon — the shape that reads as a bug.
    expect(line).not.toMatch(/:\s*$/);
    expect(line).not.toContain("``");
  });
});

describe("buildDeployVerificationReminder names services (mt#5002)", () => {
  // AT1 — the originating file class: consumed by the cockpit, attributed to minsky-mcp.
  test("AT1: names the attributed service and drops the unqualified 'affected service(s)' hunt", () => {
    const r = buildDeployVerificationReminder([CATALOG_JSON], ["minsky-mcp"]);
    expect(r).toContain("`minsky-mcp`");
    expect(r).not.toContain("for the affected service(s)");
    // The instruction now says which, and says not to substitute a guess.
    expect(r).toContain("EACH service named above");
    expect(r).toContain("do NOT substitute");
  });

  // AT2 — several services, every one named.
  test("AT2: names every service when several are affected", () => {
    const r = buildDeployVerificationReminder(["package.json"], ["minsky-mcp", "reviewer"]);
    expect(r).toContain("`minsky-mcp`");
    expect(r).toContain("`reviewer`");
  });

  // AT3 — carried through from the line renderer into the full reminder.
  test("AT3: an empty set is stated explicitly in the full reminder", () => {
    const r = buildDeployVerificationReminder([INFRA_INDEX], []);
    expect(r).toContain("NONE resolved");
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
  // The available-services list is injected (mt#5002) so these tests need no
  // services/ tree on disk. The default mirrors production's real set at the
  // time of writing; individual tests override it where the point is the list.
  const AVAILABLE = ["cockpit", "minsky-mcp", "minsky-ops", "reviewer", "site"] as const;
  const depsReturning = (
    files: PrFile[],
    available: readonly string[] = AVAILABLE
  ): PostMergeDeps => ({
    deriveRepo: () => REPO,
    fetchPrFiles: () => ({ files }),
    listAvailableServices: () => available,
  });

  test("reminds when the merged PR touched a deploy surface", () => {
    const reminder = decideDeployReminder(
      mergeInput({ pr_url: PR_URL }),
      depsReturning([f(INFRA_INDEX), f("scripts/app.ts")])
    );
    expect(reminder).not.toBeNull();
    expect(reminder).toContain(INFRA_INDEX);
  });

  // AT4 (mt#5002) — the reminder's service list is pinned against the REAL
  // predicate's own return for the same inputs, so the text cannot drift from
  // the machinery it quotes. This is the load-bearing test: it is the one that
  // fails if a future edit renders a hand-maintained list, or a different
  // predicate, or forgets a service.
  test("AT4: the named services are exactly findAffectedServices' answer for the same files", () => {
    const files = [f(CATALOG_JSON), f("services/reviewer/src/index.ts")];
    const reminder = decideDeployReminder(mergeInput({ pr_url: PR_URL }), depsReturning(files));
    expect(reminder).not.toBeNull();

    const expected = findAffectedServices(
      files.map((x) => x.filename),
      AVAILABLE
    ).services;
    // Positive control on the fixture itself: this input must resolve to more
    // than one service, or the assertion below cannot distinguish "named every
    // service" from "named the first one".
    expect(expected.length).toBeGreaterThan(1);
    for (const svc of expected) expect(reminder).toContain(`\`${svc}\``);
    // And no service OUTSIDE the predicate's answer is named.
    for (const svc of AVAILABLE) {
      if (!expected.includes(svc)) expect(reminder).not.toContain(`\`${svc}\``);
    }
  });

  // AT1 (mt#5002), end to end through decide(): the originating file. Consumed
  // by the cockpit; attributed to minsky-mcp; the reminder must say the latter
  // and must not name the former.
  test("AT1: the generated catalog names minsky-mcp, not the cockpit that consumes it", () => {
    const reminder = decideDeployReminder(
      mergeInput({ pr_url: PR_URL }),
      depsReturning([f(CATALOG_JSON)])
    );
    expect(reminder).toContain("`minsky-mcp`");
    expect(reminder).not.toContain("`cockpit`");
  });

  // AT3 (mt#5002) — when nothing resolves, the reminder says so rather than
  // printing an empty list. Reached by removing every service the file maps to.
  test("AT3: no resolvable service is stated explicitly, not rendered as an empty list", () => {
    const reminder = decideDeployReminder(
      mergeInput({ pr_url: PR_URL }),
      depsReturning([f(CATALOG_JSON)], ["cockpit", "site"])
    );
    expect(reminder).toContain("NONE resolved");
  });

  test("silent when the merged PR touched no deploy surface", () => {
    // scripts/** is outside every deploy workflow's paths: block; root src/**
    // no longer qualifies as a non-surface fixture (mt#4013).
    const reminder = decideDeployReminder(
      mergeInput({ pr_url: PR_URL }),
      depsReturning([f("scripts/app.ts")])
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

  // AT5 (mt#5002) — the tray section is byte-identical to its standalone builder
  // for a tray-only merge: the service-naming change lives entirely in the
  // Railway section and must not leak a services line into the tray reminder.
  test("AT5: a tray-only merge renders exactly buildTrayReinstallReminder, no services line", () => {
    const reminder = decideDeployReminder(
      mergeInput({ pr_url: PR_URL }),
      depsReturning([f(TRAY_FILE)])
    );
    expect(reminder).toBe(buildTrayReinstallReminder([TRAY_FILE]));
    expect(reminder).not.toContain("Affected service(s)");
  });

  test("emits BOTH reminders for a mixed Railway + tray merge (mt#2976)", () => {
    const reminder = decideDeployReminder(
      mergeInput({ pr_url: PR_URL }),
      depsReturning([f(INFRA_INDEX), f(TRAY_FILE)])
    );
    expect(reminder).toContain(DEPLOY_WAIT);
    expect(reminder).toContain(INSTALL_LOCAL);
  });

  test("cockpit-web change: Railway reminder (bundled into minsky-mcp, mt#4013) but NO tray reinstall (mt#2976)", () => {
    // mt#2976's concern stands — a web change must not demand a tray
    // reinstall — but src/cockpit/** is bundled into the minsky-mcp image
    // (mt#4013), so the Railway deploy reminder now legitimately fires.
    const reminder = decideDeployReminder(
      mergeInput({ pr_url: PR_URL }),
      depsReturning([f("src/cockpit/web/App.tsx")])
    );
    expect(reminder).not.toBeNull();
    expect(reminder).toContain(DEPLOY_WAIT);
    expect(reminder).not.toContain(INSTALL_LOCAL);
  });

  test("suppressRailway drops the Railway reminder but KEEPS the tray reminder (mt#2976 review)", () => {
    const reminder = decideDeployReminder(
      mergeInput({ pr_url: PR_URL }),
      depsReturning([f(INFRA_INDEX), f(TRAY_FILE)]),
      true
    );
    expect(reminder).not.toBeNull();
    expect(reminder).toContain(INSTALL_LOCAL);
    expect(reminder).not.toContain(DEPLOY_WAIT);
  });

  test("suppressRailway on a Railway-only merge is silent (mt#2976 review)", () => {
    const reminder = decideDeployReminder(
      mergeInput({ pr_url: PR_URL }),
      depsReturning([f(INFRA_INDEX)]),
      true
    );
    expect(reminder).toBeNull();
  });
});
