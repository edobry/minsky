// Tests for the standalone (parentless) tasks_create duplicate probe (mt#2813).
//
// All pure / hermetic: the in-process search stack (`standalone-dup-probe.ts`,
// mt#2958) is never invoked — `decideStandaloneDuplicateGuard` takes an
// injected `fetchSimilar` dependency (sync or async), mirroring the sibling
// duplicate-CHILD matcher's `decideTasksCreateGuard` / `fetchChildren`
// injection pattern (parallel-work-guard-dedup.test.ts).

import { describe, expect, it } from "bun:test";

import {
  buildStandaloneDuplicateQuery,
  detectStandaloneDuplicates,
  formatStandaloneDuplicateWarning,
  decideStandaloneDuplicateGuard,
  STANDALONE_DUP_MAX_DISTANCE,
  STANDALONE_DUP_CANDIDATE_CAP,
  STANDALONE_DUP_SPEC_MAX_CHARS,
  type TaskSearchResult,
  type StandaloneDuplicateCandidate,
} from "./parallel-work-guard-standalone";

function result(
  id: string,
  score: number,
  status = "TODO",
  title = `Title for ${id}`
): TaskSearchResult {
  return { id, score, status, title };
}

describe("buildStandaloneDuplicateQuery (mt#2813)", () => {
  it("returns title alone when no spec is supplied", () => {
    expect(buildStandaloneDuplicateQuery("Fix the thing", undefined)).toBe("Fix the thing");
  });

  it("returns title alone when spec is an empty string", () => {
    expect(buildStandaloneDuplicateQuery("Fix the thing", "")).toBe("Fix the thing");
  });

  it("joins title + spec with a blank line, mirroring extractTaskContent's format", () => {
    expect(buildStandaloneDuplicateQuery("Fix the thing", "## Summary\n\nDetails.")).toBe(
      "Fix the thing\n\n## Summary\n\nDetails."
    );
  });

  it("truncates spec content beyond STANDALONE_DUP_SPEC_MAX_CHARS", () => {
    const longSpec = "x".repeat(STANDALONE_DUP_SPEC_MAX_CHARS + 500);
    const query = buildStandaloneDuplicateQuery("Title", longSpec);
    const specPart = query.slice("Title\n\n".length);
    expect(specPart.length).toBe(STANDALONE_DUP_SPEC_MAX_CHARS);
  });

  it("does not truncate spec content at or under the cap", () => {
    const spec = "y".repeat(STANDALONE_DUP_SPEC_MAX_CHARS);
    const query = buildStandaloneDuplicateQuery("Title", spec);
    expect(query).toBe(`Title\n\n${spec}`);
  });
});

describe("detectStandaloneDuplicates (mt#2813)", () => {
  it("keeps results at or under the distance threshold", () => {
    const candidates = detectStandaloneDuplicates([
      result("mt#1", 0.4),
      result("mt#2", STANDALONE_DUP_MAX_DISTANCE),
      result("mt#3", STANDALONE_DUP_MAX_DISTANCE + 0.01),
    ]);
    expect(candidates.map((c) => c.id)).toEqual(["mt#1", "mt#2"]);
  });

  it("excludes TERMINAL-status matches (mt#2683 discipline) even under threshold", () => {
    // COMPLETED used to be exercised here too (mt#2683 discipline predates
    // mt#2311's single-DONE-terminal collapse), but COMPLETED was removed
    // entirely as a valid TaskStatus by mt#2311 — no live match can ever
    // carry it, so the case was dropped rather than kept as a dead-status
    // regression fixture (mt#3013 residue sweep).
    const candidates = detectStandaloneDuplicates([
      result("mt#1", 0.1, "DONE"),
      result("mt#2", 0.2, "CLOSED"),
      result("mt#4", 0.4, "TODO"),
    ]);
    expect(candidates.map((c) => c.id)).toEqual(["mt#4"]);
  });

  it("sorts candidates closest-first", () => {
    const candidates = detectStandaloneDuplicates([
      result("mt#far", 0.5),
      result("mt#close", 0.1),
      result("mt#mid", 0.3),
    ]);
    expect(candidates.map((c) => c.id)).toEqual(["mt#close", "mt#mid", "mt#far"]);
  });

  it("caps at STANDALONE_DUP_CANDIDATE_CAP", () => {
    const many: TaskSearchResult[] = [];
    for (let i = 0; i < STANDALONE_DUP_CANDIDATE_CAP + 5; i++) {
      many.push(result(`mt#${i}`, 0.01 * i));
    }
    const candidates = detectStandaloneDuplicates(many);
    expect(candidates.length).toBe(STANDALONE_DUP_CANDIDATE_CAP);
  });

  it("skips entries missing an id or a numeric score", () => {
    const candidates = detectStandaloneDuplicates([
      { id: "mt#1", status: "TODO" } as TaskSearchResult, // no score
      { score: 0.1, status: "TODO" } as unknown as TaskSearchResult, // no id
      result("mt#ok", 0.2),
    ]);
    expect(candidates.map((c) => c.id)).toEqual(["mt#ok"]);
  });

  it("returns [] for a clearly-novel task with no close results", () => {
    const candidates = detectStandaloneDuplicates([result("mt#1", 0.9), result("mt#2", 1.05)]);
    expect(candidates).toEqual([]);
  });
});

describe("formatStandaloneDuplicateWarning (mt#2813)", () => {
  it("names every candidate with its status and distance", () => {
    const candidates: StandaloneDuplicateCandidate[] = [
      {
        id: "mt#2351",
        title: "Reconcile pre-existing Pulumi-state drift",
        status: "TODO",
        score: 0.478,
      },
    ];
    const msg = formatStandaloneDuplicateWarning("Reconcile prod Pulumi drift", candidates);
    expect(msg).toContain("mt#2351");
    expect(msg).toContain("[TODO]");
    expect(msg).toContain("0.478");
    expect(msg).toContain("ADVISORY, not blocking");
  });

  it("pluralizes correctly for multiple candidates", () => {
    const candidates: StandaloneDuplicateCandidate[] = [
      { id: "mt#1", title: "A", status: "TODO", score: 0.1 },
      { id: "mt#2", title: "B", status: "IN-PROGRESS", score: 0.2 },
    ];
    const msg = formatStandaloneDuplicateWarning("New task", candidates);
    expect(msg).toContain("2 existing ACTIVE tasks");
    expect(msg).toContain("mt#1");
    expect(msg).toContain("mt#2");
  });
});

describe("decideStandaloneDuplicateGuard (mt#2813)", () => {
  it("skips (no title) when tasks_create has no title", async () => {
    const decision = await decideStandaloneDuplicateGuard(
      {},
      { fetchSimilar: () => ({ results: [], degraded: false }) }
    );
    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.degraded).toBeFalsy();
    }
  });

  it("degrades open with a loud skip when the search backend is unavailable (null)", async () => {
    const decision = await decideStandaloneDuplicateGuard(
      { title: "Some new task" },
      { fetchSimilar: () => null }
    );
    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.degraded).toBe(true);
      expect(decision.reason).toMatch(/failed|timed out/);
    }
  });

  it("threads the probe's ACTUAL error message into the skip reason (mt#2958 SC2)", async () => {
    const decision = await decideStandaloneDuplicateGuard(
      { title: "Some new task" },
      {
        fetchSimilar: () => ({
          failed: "write CONNECT_TIMEOUT 192.0.2.1:5432",
          causeClass: "infra",
        }),
      }
    );
    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.degraded).toBe(true);
      expect(decision.reason).toContain("write CONNECT_TIMEOUT 192.0.2.1:5432");
    }
  });

  it("threads the probe's causeClass into the skip decision (mt#3072 SC2)", async () => {
    const infraDecision = await decideStandaloneDuplicateGuard(
      { title: "Some new task" },
      { fetchSimilar: () => ({ failed: "persistence provider unavailable", causeClass: "infra" }) }
    );
    expect(infraDecision.action).toBe("skip");
    if (infraDecision.action === "skip") expect(infraDecision.causeClass).toBe("infra");

    const logicDecision = await decideStandaloneDuplicateGuard(
      { title: "Some new task" },
      {
        fetchSimilar: () => ({
          failed: "Cannot read properties of undefined (reading 'id')",
          causeClass: "logic",
        }),
      }
    );
    expect(logicDecision.action).toBe("skip");
    if (logicDecision.action === "skip") expect(logicDecision.causeClass).toBe("logic");
  });

  it("classifies the legacy null-return and lexical-fallback-degraded paths as infra (mt#3072 SC2)", async () => {
    const nullDecision = await decideStandaloneDuplicateGuard(
      { title: "Some new task" },
      { fetchSimilar: () => null }
    );
    expect(nullDecision.action).toBe("skip");
    if (nullDecision.action === "skip") expect(nullDecision.causeClass).toBe("infra");

    const degradedDecision = await decideStandaloneDuplicateGuard(
      { title: "Some new task" },
      { fetchSimilar: () => ({ results: [result("mt#1", 0.1)], degraded: true }) }
    );
    expect(degradedDecision.action).toBe("skip");
    if (degradedDecision.action === "skip") expect(degradedDecision.causeClass).toBe("infra");
  });

  it("accepts an ASYNC fetchSimilar (the in-process probe's shape)", async () => {
    const decision = await decideStandaloneDuplicateGuard(
      { title: "Some new task" },
      { fetchSimilar: async () => ({ results: [result("mt#dup", 0.3, "TODO")], degraded: false }) }
    );
    expect(decision.action).toBe("warn");
  });

  it("degrades open when the search response reports lexical-fallback degradation", async () => {
    const decision = await decideStandaloneDuplicateGuard(
      { title: "Some new task" },
      { fetchSimilar: () => ({ results: [result("mt#1", 0.1)], degraded: true }) }
    );
    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.degraded).toBe(true);
      expect(decision.reason).toMatch(/lexical fallback/);
    }
  });

  it("permits a clearly-novel task with no close matches", async () => {
    const decision = await decideStandaloneDuplicateGuard(
      { title: "Totally novel unrelated task" },
      {
        fetchSimilar: () => ({
          results: [result("mt#1", 0.95), result("mt#2", 1.1)],
          degraded: false,
        }),
      }
    );
    expect(decision.action).toBe("permit");
  });

  it("warns naming the candidate when a high-similarity ACTIVE match is found", async () => {
    const decision = await decideStandaloneDuplicateGuard(
      { title: "New task" },
      { fetchSimilar: () => ({ results: [result("mt#dup", 0.3, "TODO")], degraded: false }) }
    );
    expect(decision.action).toBe("warn");
    if (decision.action === "warn") {
      expect(decision.candidates.map((c) => c.id)).toEqual(["mt#dup"]);
      expect(decision.message).toContain("mt#dup");
    }
  });

  it("passes title+spec through to fetchSimilar as the query", async () => {
    let receivedQuery = "";
    await decideStandaloneDuplicateGuard(
      { title: "T", spec: "S" },
      {
        fetchSimilar: (query) => {
          receivedQuery = query;
          return { results: [], degraded: false };
        },
      }
    );
    expect(receivedQuery).toBe("T\n\nS");
  });

  // -------------------------------------------------------------------------
  // Replay corpus (mt#2813 acceptance tests) — fixture scores taken from a
  // live `minsky tasks search` probe run during implementation (PR body has
  // the full calibration table). Hermetic: fetchSimilar is a fixture, not a
  // live call.
  // -------------------------------------------------------------------------

  it("replay: mt#2734/mt#2351 pair — warns naming mt#2351", async () => {
    // Live-probed distance (title+spec query): mt#2351 at 0.478.
    const decision = await decideStandaloneDuplicateGuard(
      {
        title:
          "Reconcile prod Pulumi drift: undeployed cockpit service + minsky-mcp/site variable drift",
        spec: "## Summary\n\npulumi preview surfaced drift...",
      },
      {
        fetchSimilar: () => ({
          results: [
            result(
              "mt#2351",
              0.478,
              "TODO",
              "Reconcile pre-existing Pulumi-state drift on minsky-mcp (rootDirectory) and site (SITE_URL variable) in infra/"
            ),
            result(
              "mt#2476",
              0.581,
              "TODO",
              "Before pulumi up: import the live cockpit Railway service"
            ),
          ],
          degraded: false,
        }),
      }
    );
    expect(decision.action).toBe("warn");
    if (decision.action === "warn") {
      expect(decision.candidates.map((c) => c.id)).toContain("mt#2351");
    }
  });

  it("replay: mt#2887/mt#2888 pair (fresh evidence, 2026-07-16) — warns naming mt#2888", async () => {
    // Live-probed distances (title+spec query, mt#2887's at-creation content):
    // mt#2892 at 0.579, mt#2888 at 0.632 — both ACTIVE at replay time. This is
    // the hard case: the two titles use completely different framing/vocabulary
    // for the same underlying incident ("session_pr_merge's internal gh api
    // check_runs query fails with HTTP 503..." vs "GitHub-API resilience in
    // convergence tooling: classify 503/rate-limit/HTML errors...") — a
    // title-only query does NOT separate this pair from calibration noise
    // (see the section doc comment in parallel-work-guard.ts); title+spec does.
    const decision = await decideStandaloneDuplicateGuard(
      {
        title:
          "session_pr_merge's internal gh api check_runs query fails with HTTP 503 while equivalent Octokit-based MCP calls succeed",
        spec: "## Summary\n\n`mcp__minsky__session_pr_merge` shells out to `gh` CLI...",
      },
      {
        fetchSimilar: () => ({
          results: [
            result(
              "mt#2892",
              0.579,
              "TODO",
              "Merge-gate resilience: pr-context gh-subprocess failure should fall back to the MCP server's forge client"
            ),
            result(
              "mt#2888",
              0.632,
              "TODO",
              "GitHub-API resilience in convergence tooling: classify 503/rate-limit/HTML errors, unify gate fetch path with Octokit, trim error payloads"
            ),
            result(
              "mt#2890",
              0.648,
              "IN-PROGRESS",
              "session_pr_merge mislabels non-conflict GitHub API failures"
            ),
          ],
          degraded: false,
        }),
      }
    );
    expect(decision.action).toBe("warn");
    if (decision.action === "warn") {
      const ids = decision.candidates.map((c) => c.id);
      expect(ids).toContain("mt#2888");
      expect(ids).toContain("mt#2892");
    }
  });

  it("replay: a terminal-status near-duplicate (e.g. the original mt#2887, later CLOSED) is excluded", async () => {
    const decision = await decideStandaloneDuplicateGuard(
      { title: "New bug report" },
      {
        fetchSimilar: () => ({
          results: [
            result(
              "mt#2887",
              0.05,
              "CLOSED",
              "session_pr_merge's internal gh api check_runs query fails"
            ),
            result("mt#2888", 0.632, "TODO", "GitHub-API resilience in convergence tooling"),
          ],
          degraded: false,
        }),
      }
    );
    expect(decision.action).toBe("warn");
    if (decision.action === "warn") {
      const ids = decision.candidates.map((c) => c.id);
      expect(ids).not.toContain("mt#2887");
      expect(ids).toContain("mt#2888");
    }
  });

  it("replay: legitimately-distinct false-positive-corpus sample stays under threshold and permits", async () => {
    // mt#2762 vs its nearest ACTIVE neighbor during calibration landed at
    // 0.797 (title+spec) — comfortably above STANDALONE_DUP_MAX_DISTANCE.
    const decision = await decideStandaloneDuplicateGuard(
      {
        title:
          'Add kind filter to tasks_list / tasks_search / tasks_available so "list open work streams" is one query',
      },
      {
        fetchSimilar: () => ({
          results: [
            result(
              "mt#2783",
              0.797,
              "TODO",
              "Reconcile duplicate listTasksFromParams implementations"
            ),
          ],
          degraded: false,
        }),
      }
    );
    expect(decision.action).toBe("permit");
  });
});
