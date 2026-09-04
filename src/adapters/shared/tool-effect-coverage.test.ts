/**
 * Coverage measurement for the tool-effect classification (mt#3847, AT1).
 *
 * The classification lives in `packages/shared` because the cockpit bundle has
 * to read it, which means it is NOT declared at each command's definition site
 * and CAN drift from the registry. This test is the mechanism that makes the
 * drift fail rather than pass silently — the guarantee mt#3789's unpopulated
 * registry field never had, and the reason its emptiness went unnoticed.
 *
 * It asserts two different things:
 *   1. Coverage does not regress below a COMMITTED number. Gaps are allowed;
 *      not knowing the size of the gap is not.
 *   2. Every command id found by scanning the command sources is present in the
 *      snapshot below — so adding a command without classifying it fails here,
 *      naming the id.
 */
/* eslint-disable custom/no-real-fs-in-tests -- the assertions below are ABOUT the
   real command sources. An injected fake filesystem would make them assert the
   fixture rather than the repo, which is precisely the drift these tests exist
   to catch: a command added to the sources without a classification entry. Same
   rationale as `src/utils/tsgo-binary.test.ts`'s repo-invariant tests. */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

import { MCP_COMMAND_EFFECTS, KNOWN_UNCLASSIFIED, classifyTool } from "@minsky/shared/tool-effect";
import { scanCommandIds, scanMutatingFlaggedIds } from "../../utils/test-utils/command-source-scan";

/**
 * The registered tool surface, captured 2026-08-10.
 *
 * Refresh with `debug.listMethods` (225 shared-registry commands) PLUS the
 * tools registered directly on the MCP surface rather than through the shared
 * registry — currently `tasks.spec.patch` and `tasks.spec.search_replace` in
 * `src/adapters/mcp/task-edit-tools.ts`. That second path is easy to miss:
 * `debug.listMethods` does not report it, so "the registry" and "the tool
 * surface" are not the same set.
 */
const REGISTERED_TOOL_IDS: readonly string[] = [
  "ai.cache.clear",
  "ai.chat",
  "ai.complete",
  "ai.fast-apply",
  "ai.models.available",
  "ai.models.list",
  "ai.models.refresh",
  "ai.providers.list",
  "ai.validate",
  "asks.cancel",
  "asks.create",
  "asks.edit",
  "asks.get",
  "asks.list",
  "asks.reconcile",
  "asks.repair",
  "asks.respond",
  "asks.wait-for-response",
  "attention.report",
  "authorship.get",
  "authorship.recompute",
  "changeset.get",
  "changeset.info",
  "changeset.list",
  "changeset.search",
  "compile",
  "config.credentials.add",
  "config.credentials.list",
  "config.credentials.recheck",
  "config.credentials.remove",
  "credentials.request",
  "credentials.request-status",
  "config.doctor",
  "config.get",
  "config.list",
  "config.set",
  "config.show",
  "config.unset",
  "config.validate",
  "debug.echo",
  "debug.listMethods",
  "debug.systemInfo",
  "deployment.logs",
  "deployment.status",
  "deployment.wait-for-latest",
  "epic-decomposition.audit",
  "events.emit",
  "events.list",
  "forge.branch_protection_get",
  "forge.branch_protection_set",
  "forge.check_runs_list",
  "forge.ci_run_list",
  "forge.ci_run_rerun",
  "forge.ci_run_view_log",
  "forge.label_create",
  "forge.label_delete",
  "forge.label_list",
  "forge.label_update",
  "git.blame",
  "git.branch",
  "git.checkout",
  "git.clone",
  "git.commit",
  "git.conflicts",
  "git.diff",
  "git.log",
  "git.merge",
  "git.pull",
  "git.push",
  "git.rebase",
  "git.repair_lock",
  "git.repair_refs",
  "git.reset",
  "git.restore",
  "git.search",
  "git.stash",
  "git.stash_drop",
  "git.stash_list",
  "git.stash_pop",
  "git.stats",
  "git.status",
  "guard-events.ingest",
  "init",
  "knowledge.fetch",
  "knowledge.search",
  "knowledge.sources",
  "knowledge.sync",
  "mcp.register",
  "mcp.restart",
  "mcp.status",
  "memory.create",
  "memory.delete",
  "memory.get",
  "memory.lineage",
  "memory.list",
  "memory.patch",
  "memory.search",
  "memory.similar",
  "memory.supersede",
  "memory.update",
  "observability.calibration-review",
  "observability.reviewer-cost",
  "observability.reviewer-events",
  "observability.smoke-test",
  "persistence.check",
  "persistence.migrate",
  "pr.watch.cancel",
  "pr.watch.create",
  "pr.watch.list",
  "pr.watch.run",
  "principal.notify",
  "principal_corpus.index-embeddings",
  "principal_corpus.search",
  "principal_corpus.similar",
  "provenance.get",
  "provenance.recompute",
  "refs.status",
  "repo.list_directory",
  "repo.read_file",
  "repo.search",
  "reviewer.retrigger",
  "reviewer.watch.run",
  "reviewer.watch.start",
  "rules.compile",
  "rules.config",
  "rules.create",
  "rules.disable",
  "rules.enable",
  "rules.get",
  "rules.index-embeddings",
  "rules.list",
  "rules.migrate",
  "rules.presets",
  "rules.search",
  "rules.update",
  "security.check-credentials",
  "session.apply_post_merge_state_sync",
  "session.attached",
  "session.bindings.refresh",
  "session.cleanup",
  "session.commit",
  "session.conflicts",
  "session.delete",
  "session.dir",
  "session.edit-file",
  "session.exec",
  "session.focus",
  "session.generate_prompt",
  "session.get",
  "session.goto",
  "session.inspect",
  "session.list",
  "session.migrate",
  "session.migrate-backend",
  "session.pr.approve",
  "session.pr.check_run.submit",
  "session.pr.checks",
  "session.pr.close",
  "session.pr.create",
  "session.pr.drive",
  "session.pr.edit",
  "session.pr.get",
  "session.pr.list",
  "session.pr.merge",
  "session.pr.open",
  "session.pr.review.dismiss",
  "session.pr.review.submit",
  "session.pr.review.thread.resolve",
  "session.pr.review_context",
  "session.pr.wait-for-review",
  "session.ps",
  "session.repair",
  "session.review",
  "session.search",
  "session.start",
  "session.update",
  "setup",
  "setup.db",
  "setup.github-app",
  "setup.local-http",
  "tasks.analyze",
  "tasks.available",
  "tasks.bulk-edit",
  "tasks.children",
  "tasks.claim",
  "tasks.claims.list",
  "tasks.claims.release",
  "tasks.create",
  "tasks.decompose",
  "tasks.delete",
  "tasks.deps.add",
  "tasks.deps.graph",
  "tasks.deps.list",
  "tasks.deps.rm",
  "tasks.deps.tree",
  "tasks.dispatch",
  "tasks.dispatch-recover",
  "tasks.edit",
  "tasks.embeddings-repair",
  "tasks.embeddings-status",
  "tasks.estimate",
  "tasks.get",
  "tasks.index-embeddings",
  "tasks.list",
  "tasks.migrate-backend",
  "tasks.orchestrate",
  "tasks.parent",
  "tasks.release",
  "tasks.reparent",
  "tasks.route",
  "tasks.search",
  "tasks.similar",
  "tasks.spec.freshness",
  "tasks.spec.get",
  "tasks.status.get",
  "tasks.status.set",
  "tasks.supervise",
  "tasks.supervise-stop",
  "tasks.supervision-status",
  "tools.index-embeddings",
  "tools.search",
  "tools.similar",
  "transcripts.get",
  "transcripts.index-embeddings",
  "transcripts.ingest",
  "transcripts.list",
  "transcripts.search",
  "transcripts.search-text",
  "transcripts.similar",
  "transcripts.spawns-extract",
  "unasked-direction.list",
  "unasked-direction.mark-false-positive",
  "unasked-direction.mark-real",
  "validate.lint",
  "validate.typecheck",
  "window.close",
  "window.list",
  "window.open",
  "window.service",
  "window.status",
  "workspace.info",
  // Registered directly on the MCP surface, not via the shared registry, so
  // `debug.listMethods` reports none of these. PR #2789 R1: the first draft
  // listed only the two task-spec tools and missed the entire session-workspace
  // file family — most of what an agent actually calls. The scan below now
  // covers `src/adapters/mcp/**` so the omission cannot recur silently.
  "tasks.spec.patch",
  "tasks.spec.search_replace",
  "session.read_file",
  "session.write_file",
  "session.list_directory",
  "session.file_exists",
  "session.delete_file",
  "session.create_directory",
  "session.grep_search",
  "session.diff",
  "session.status",
  "session.edit_file",
  "session.search_replace",
  "session.move_file",
  "session.rename_file",
];

/**
 * The committed floor. This is the coverage ACHIEVED at authoring time, not an
 * aspiration — raising it is the point, lowering it should require saying so.
 */
const MINIMUM_CLASSIFIED = 231;

function classifiedCount(): number {
  return REGISTERED_TOOL_IDS.filter((id) => classifyTool(id) !== "unclassified").length;
}

describe("tool-effect coverage over the registered tool surface", () => {
  test("coverage does not regress below the committed floor", () => {
    const classified = classifiedCount();
    const total = REGISTERED_TOOL_IDS.length;
    // Reported on failure so the number is visible without re-deriving it.
    expect({ classified, total, unclassified: total - classified }).toMatchObject({
      classified: expect.any(Number),
    });
    expect(classified).toBeGreaterThanOrEqual(MINIMUM_CLASSIFIED);
  });

  test("every unclassified id is a RECORDED gap, not an oversight", () => {
    const unrecorded = REGISTERED_TOOL_IDS.filter(
      (id) => classifyTool(id) === "unclassified" && !KNOWN_UNCLASSIFIED.includes(id)
    );
    expect(unrecorded).toEqual([]);
  });

  test("the table carries no entry for a tool that is not registered", () => {
    const registered = new Set(REGISTERED_TOOL_IDS);
    const orphans = Object.keys(MCP_COMMAND_EFFECTS).filter((id) => !registered.has(id));
    expect(orphans).toEqual([]);
  });
});

/**
 * The drift gate's refusal set is DECIDED, and this pins it (mt#3847 AT6 → mt#3924).
 *
 * mt#3847 pinned the set at the 13 session/PR commands that predated the
 * classification, because backfilling `mutating: true` across everything the table
 * calls `mutates` would widen a SAFETY gate's blast radius as a side effect of
 * adding a field. mt#3924 then made that call deliberately and narrowly: 15
 * commands joined, chosen because their effect is irreversible, bulk, or
 * schema-migrating — NOT the 116 the table classifies as `mutates`. Ordinary
 * reversible single-record writes (`tasks.create`, `memory.create`,
 * `tasks.status.set`, the session file tools) stay out on purpose; they sit on the
 * hottest agent path, and a gate that fires there is one people route around.
 *
 * The test's job is unchanged — an accidental widening should fail here rather
 * than merge — only its expected set moved, once, with a recorded decision.
 */
describe("drift-gate refusal set matches the mt#3924 decision", () => {
  /**
   * The 28 commands carrying the flag, read off the sources rather than recalled —
   * an earlier draft of this list guessed `session.approve` and missed
   * `session.pr.approve` and `session.pr.merge`, and this assertion is what caught
   * it. The same discipline caught a second error in mt#3924: `session.pr.drive`
   * was slated for the widening as "creates and merges a PR" and in fact never
   * merges (it is a review/checks wait that deliberately leaves merging to
   * `session.pr.merge` so the harness merge gates still fire), so it is absent.
   */
  const MUTATING_FLAGGED_COMMANDS: readonly string[] = [
    // Pre-mt#3924: session/PR operations.
    "session.apply_post_merge_state_sync",
    "session.bindings.refresh",
    "session.commit",
    "session.pr.approve",
    "session.pr.check_run.submit",
    "session.pr.close",
    "session.pr.create",
    "session.pr.edit",
    "session.pr.merge",
    "session.pr.review.dismiss",
    "session.pr.review.submit",
    "session.pr.review.thread.resolve",
    "session.update",
    // mt#3924 — irreversible deletion of a durable record.
    "memory.delete",
    "session.delete",
    "tasks.delete",
    // mt#3924 — irreversible discard or publication of work.
    "git.push",
    "git.reset",
    "git.restore",
    "git.stash_drop",
    // mt#3924 — bulk mutation.
    "tasks.bulk-edit",
    // mt#3924 — schema / store migration.
    "persistence.migrate",
    "rules.migrate",
    "session.migrate",
    "session.migrate-backend",
    "setup.db",
    "tasks.migrate-backend",
    // mt#3924 — shared-repository setting, full-replace semantics.
    "forge.branch_protection_set",
    // mt#3816 — rewrites the operator's Claude Code MCP config, a durable
    // artifact OUTSIDE this repo, and may start a daemon. Backed up before the
    // first byte is written and reversible via `--revert`, but a stale-state
    // refusal is still right: the entry it rewrites decides what the operator's
    // editor spawns.
    "setup.local-http",
  ];

  test("exactly the decided commands carry mutating: true", () => {
    expect(scanMutatingFlaggedIds()).toEqual([...MUTATING_FLAGGED_COMMANDS].sort());
  });

  test("every drift-gated command is one the table also calls a mutator", () => {
    // A command refused when stale but classified `reads` would mean one of the
    // two is wrong. This is the cheap cross-check between them; it does NOT
    // require the converse, which is the whole point of the next test.
    const misclassified = MUTATING_FLAGGED_COMMANDS.filter(
      (id) => MCP_COMMAND_EFFECTS[id] !== undefined && MCP_COMMAND_EFFECTS[id] !== "mutates"
    );
    expect(misclassified).toEqual([]);
  });

  test("the classification stays far wider than the gate's set — deliberately", () => {
    // mt#3924 decided the gate covers irreversible/bulk/migrating effects, not
    // everything that writes, so this gap is the DECISION rather than a lag to
    // close. Recording the ratio keeps it visible instead of leaving it in a spec:
    // a future change that quietly closes it should have to say so here.
    const classifiedMutators = Object.values(MCP_COMMAND_EFFECTS).filter(
      (e) => e === "mutates"
    ).length;
    expect(classifiedMutators).toBeGreaterThan(MUTATING_FLAGGED_COMMANDS.length * 3);
  });
});

/**
 * Cross-check the committed snapshot against the command sources, so a command
 * added after this snapshot was taken fails HERE — with its id — rather than
 * silently sitting outside the coverage measurement.
 */
describe("snapshot freshness against the command sources", () => {
  /**
   * Ids the sources DECLARE but nothing registers, so their absence from the
   * snapshot is correct rather than a gap. Each entry needs a verified reason —
   * "it looks like a container" is a guess; a zero-call-site factory is a finding.
   *
   * - `tasks.status` — `TasksStatusCommand`
   *   (`commands/tasks/hierarchical-status-command.ts`) is a parameterless parent
   *   holding the get/set subcommands. Its factory `createTasksStatusCommand` has
   *   NO call sites outside its own definition (verified by grep over `src` and
   *   `packages`, excluding tests, 2026-08-11), so it never reaches the registry
   *   and is not on the tool surface. `MCP_COMMAND_EFFECTS` is right not to carry it.
   *
   * This list is deliberately not a free-form skip: the test below fails if an
   * entry stops being declared, so a stale exclusion cannot outlive its subject.
   */
  const DECLARED_BUT_UNREGISTERED: readonly string[] = ["tasks.status"];

  /**
   * The scan's own floor. Until mt#3966 this scan matched `id:`/`id=` with no
   * space before the separator, so it saw 200 of the 223 declared ids and was
   * structurally blind to every class-based command — including `tasks.create`,
   * `tasks.delete` and `tasks.status.set`. Nothing failed, because a scan that
   * under-reports agrees with the snapshot instead of contradicting it. Asserting
   * the COUNT is what makes a future shrink fail rather than pass.
   */
  const MINIMUM_DECLARED_IDS = 223;

  /**
   * The MCP surface registers tools with `name:` rather than `id:`, in a
   * different tree. Scanning only the shared registry is how the first draft of
   * this snapshot missed 13 session-workspace file tools (PR #2789 R1).
   */
  function scanMcpToolNames(dir: string): string[] {
    const names: string[] = [];
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        names.push(...scanMcpToolNames(p));
        continue;
      }
      if (!p.endsWith(".ts") || p.endsWith(".test.ts")) continue;
      const text = String(readFileSync(p, "utf8"));
      for (const m of text.matchAll(/^\s*name:\s*["'`]([a-z][a-z0-9._-]*)["'`],/gim)) {
        names.push(m[1] as string);
      }
    }
    return names;
  }

  test("no MCP-registered tool name is missing from the snapshot", () => {
    const scanned = new Set(scanMcpToolNames("src/adapters/mcp"));
    const snapshot = new Set(REGISTERED_TOOL_IDS);
    const missing = [...scanned].filter((name) => !snapshot.has(name));
    expect(missing).toEqual([]);
  });

  test("no command id in the sources is missing from the snapshot", () => {
    const scanned = new Set(scanCommandIds());
    const snapshot = new Set(REGISTERED_TOOL_IDS);
    for (const id of DECLARED_BUT_UNREGISTERED) scanned.delete(id);
    const missing = [...scanned].filter((id) => !snapshot.has(id));
    expect(missing).toEqual([]);
  });

  test("the scan still sees every declared id, including class-based ones", () => {
    // Guards the mt#3966 regression class directly: the check above passes just as
    // happily on a scan that sees NOTHING, because an empty set has no missing ids.
    // This is the assertion that can tell "no gaps" from "no vision".
    const scanned = scanCommandIds();
    expect(scanned.length).toBeGreaterThanOrEqual(MINIMUM_DECLARED_IDS);
    // A class-declared id, present only if the modifier-tolerant pattern is live.
    expect(scanned).toContain("tasks.delete");
  });

  test("every declared-but-unregistered exclusion is still declared", () => {
    // A stale exclusion silently re-opens the hole it was written to close.
    const scanned = new Set(scanCommandIds());
    const gone = DECLARED_BUT_UNREGISTERED.filter((id) => !scanned.has(id));
    expect(gone).toEqual([]);
  });
});
