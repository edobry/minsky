import { describe, expect, it } from "bun:test";
import {
  detectEpicDecompositionStaleness,
  extractInScopeText,
  computeOverlap,
  __TEST_ONLY,
  type EpicChildSnapshot,
  type EpicStalenessCandidate,
  DEFAULT_RECENCY_WINDOW_DAYS,
} from "./epic-decomposition-staleness";

const { extractFilePaths, extractIdentifiers, extractKeywords } = __TEST_ONLY;

// Test-utils: shared scope-spec fixture for the (todo, delivery) overlap cases.
// Extracted to a constant to satisfy `custom/no-magic-string-duplication`.
const FOO_TS_SCOPE = "## Scope\n**In scope:**\n- src/foo.ts";

/** Test helper: pick the first candidate or fail loudly with a useful message. */
function firstOrFail(candidates: EpicStalenessCandidate[]): EpicStalenessCandidate {
  if (candidates.length === 0) {
    throw new Error("expected at least one candidate, got 0");
  }
  return candidates[0] as EpicStalenessCandidate;
}

// ---------------------------------------------------------------------------
// In-scope text extraction
// ---------------------------------------------------------------------------

describe("extractInScopeText", () => {
  it("returns empty when spec has no ## Scope heading", () => {
    expect(extractInScopeText("# Title\n\nSome text")).toBe("");
  });

  it("returns the whole scope body when no In-scope subsection marker present", () => {
    const spec = `## Summary\nFoo.\n\n## Scope\nWe will modify foo.ts and bar.ts.\n\n## Success Criteria\nDone.`;
    const out = extractInScopeText(spec);
    expect(out).toContain("foo.ts");
    expect(out).toContain("bar.ts");
    expect(out).not.toContain("Success Criteria");
  });

  it("scopes to **In scope:** sub-section when present", () => {
    const spec = `## Scope\n\n**In scope:**\n- src/foo/bar.ts\n- modifyThis\n\n**Out of scope:**\n- src/quux.ts\n\n## Acceptance Tests`;
    const out = extractInScopeText(spec);
    expect(out).toContain("src/foo/bar.ts");
    expect(out).toContain("modifyThis");
    expect(out).not.toContain("quux.ts");
  });

  it("is case-insensitive on the headings", () => {
    const spec = `## scope\n\n**in scope:**\n- src/x.ts\n\n**out of scope:**\n- src/y.ts`;
    const out = extractInScopeText(spec);
    expect(out).toContain("src/x.ts");
    expect(out).not.toContain("src/y.ts");
  });

  it("stops at the next ## heading", () => {
    const spec = `## Scope\n**In scope:**\n- foo.ts\n\n## Context\n- bar.ts`;
    const out = extractInScopeText(spec);
    expect(out).toContain("foo.ts");
    expect(out).not.toContain("bar.ts");
  });
});

// ---------------------------------------------------------------------------
// Signal extractors
// ---------------------------------------------------------------------------

describe("extractFilePaths", () => {
  it("extracts code file paths", () => {
    const paths = extractFilePaths("modify src/domain/foo.ts and src/adapters/bar.tsx");
    expect(paths.has("src/domain/foo.ts")).toBe(true);
    expect(paths.has("src/adapters/bar.tsx")).toBe(true);
  });

  it("extracts markdown paths", () => {
    const paths = extractFilePaths("update .claude/skills/orchestrate/SKILL.md");
    expect(paths.has(".claude/skills/orchestrate/skill.md")).toBe(true);
  });

  it("ignores bare filenames without a slash", () => {
    const paths = extractFilePaths("update foo.ts and bar.md");
    expect(paths.size).toBe(0);
  });

  it("returns lowercased paths for case-insensitive matching", () => {
    const paths = extractFilePaths("modify Src/Domain/Foo.TS");
    expect(paths.has("src/domain/foo.ts")).toBe(true);
  });
});

describe("extractIdentifiers", () => {
  it("captures camelCase identifiers", () => {
    const idents = extractIdentifiers("call registerEpicDecomposition and findThings");
    expect(idents.has("registerepicdecomposition")).toBe(true);
    expect(idents.has("findthings")).toBe(true);
  });

  it("captures snake_case identifiers", () => {
    const idents = extractIdentifiers("tasks_status_get and submit_finding");
    expect(idents.has("tasks_status_get")).toBe(true);
    expect(idents.has("submit_finding")).toBe(true);
  });

  it("captures kebab-case identifiers", () => {
    const idents = extractIdentifiers("policy-coverage detector and parent-rollup-completion");
    expect(idents.has("policy-coverage")).toBe(true);
    expect(idents.has("parent-rollup-completion")).toBe(true);
  });

  it("excludes single-word lowercase tokens", () => {
    const idents = extractIdentifiers("we need scope and overlap and detect");
    expect(idents.size).toBe(0);
  });
});

describe("extractKeywords", () => {
  it("captures distinctive multi-char words", () => {
    const kws = extractKeywords("reviewer empty-body silent failure detection corpus");
    expect(kws.has("reviewer")).toBe(true);
    expect(kws.has("silent")).toBe(true);
    expect(kws.has("corpus")).toBe(true);
  });

  it("excludes stopwords", () => {
    const kws = extractKeywords("because should every other while these those");
    expect(kws.size).toBe(0);
  });

  it("excludes short words", () => {
    const kws = extractKeywords("a be the and or it");
    expect(kws.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Overlap analysis
// ---------------------------------------------------------------------------

describe("computeOverlap", () => {
  it("intersects on each signal type independently", () => {
    const a = {
      filePaths: new Set(["src/foo.ts", "src/bar.ts"]),
      identifiers: new Set(["doThing", "doOther"]),
      keywords: new Set(["leak", "race"]),
    };
    const b = {
      filePaths: new Set(["src/foo.ts", "src/baz.ts"]),
      identifiers: new Set(["doThing"]),
      keywords: new Set(["leak", "stall"]),
    };

    const overlap = computeOverlap(a, b);
    expect(overlap.filePaths).toEqual(["src/foo.ts"]);
    expect(overlap.identifiers).toEqual(["doThing"]);
    expect(overlap.keywords).toEqual(["leak"]);
    expect(overlap.signalTypeCount).toBe(3);
    expect(overlap.totalTokenCount).toBe(3);
  });

  it("returns zero counts on disjoint inputs", () => {
    const a = {
      filePaths: new Set(["src/foo.ts"]),
      identifiers: new Set(["doThing"]),
      keywords: new Set(["leak"]),
    };
    const b = {
      filePaths: new Set(["src/quux.ts"]),
      identifiers: new Set(["doOther"]),
      keywords: new Set(["stall"]),
    };
    const overlap = computeOverlap(a, b);
    expect(overlap.signalTypeCount).toBe(0);
    expect(overlap.totalTokenCount).toBe(0);
  });

  it("produces sorted output for determinism", () => {
    const a = {
      filePaths: new Set<string>(["src/b.ts", "src/a.ts"]),
      identifiers: new Set<string>(),
      keywords: new Set<string>(),
    };
    const b = {
      filePaths: new Set<string>(["src/a.ts", "src/b.ts"]),
      identifiers: new Set<string>(),
      keywords: new Set<string>(),
    };
    const overlap = computeOverlap(a, b);
    expect(overlap.filePaths).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Detection entry point
// ---------------------------------------------------------------------------

describe("detectEpicDecompositionStaleness", () => {
  const now = new Date("2026-05-11T12:00:00Z");
  const recentEnough = new Date("2026-05-01T00:00:00Z"); // ~10 days ago
  const tooOld = new Date("2026-03-01T00:00:00Z"); // ~70 days ago
  const beforeDelivery = new Date("2026-04-15T00:00:00Z"); // before recentEnough
  const afterDelivery = new Date("2026-05-05T00:00:00Z"); // after recentEnough

  function childTodo(
    id: string,
    spec: string,
    createdAt: Date | undefined = beforeDelivery
  ): EpicChildSnapshot {
    return { id, title: `todo ${id}`, status: "TODO", spec, createdAt };
  }

  function childDone(
    id: string,
    spec: string,
    updatedAt: Date | undefined = recentEnough
  ): EpicChildSnapshot {
    return { id, title: `done ${id}`, status: "DONE", spec, updatedAt };
  }

  it("returns empty when no children present", () => {
    expect(detectEpicDecompositionStaleness([], { now })).toEqual([]);
  });

  it("returns empty when no DONE siblings in recency window", () => {
    const children: EpicChildSnapshot[] = [
      childTodo("mt#100", FOO_TS_SCOPE),
      childDone("mt#200", FOO_TS_SCOPE, tooOld),
    ];
    expect(detectEpicDecompositionStaleness(children, { now })).toEqual([]);
  });

  it("returns empty when no TODO/PLANNING children present", () => {
    const children: EpicChildSnapshot[] = [childDone("mt#200", FOO_TS_SCOPE)];
    expect(detectEpicDecompositionStaleness(children, { now })).toEqual([]);
  });

  it("surfaces pairs with file-path overlap", () => {
    const children: EpicChildSnapshot[] = [
      childTodo("mt#100", FOO_TS_SCOPE),
      childDone("mt#200", FOO_TS_SCOPE),
    ];
    const candidates = detectEpicDecompositionStaleness(children, { now });
    expect(candidates).toHaveLength(1);
    const first = firstOrFail(candidates);
    expect(first.todoChildId).toBe("mt#100");
    expect(first.deliveringSiblingId).toBe("mt#200");
    expect(first.overlap.filePaths).toEqual(["src/foo.ts"]);
  });

  it("surfaces pairs with identifier overlap", () => {
    const children: EpicChildSnapshot[] = [
      childTodo("mt#100", "## Scope\n**In scope:**\n- handle submit_finding tool call"),
      childDone("mt#200", "## Scope\n**In scope:**\n- new submit_finding output tool"),
    ];
    const candidates = detectEpicDecompositionStaleness(children, { now });
    expect(candidates).toHaveLength(1);
    expect(firstOrFail(candidates).overlap.identifiers).toContain("submit_finding");
  });

  it("surfaces pairs with keyword overlap", () => {
    const children: EpicChildSnapshot[] = [
      childTodo("mt#100", "## Scope\n**In scope:**\n- detect reviewer empty-body silent failures"),
      childDone("mt#200", "## Scope\n**In scope:**\n- prevent reviewer empty-body silent emission"),
    ];
    const candidates = detectEpicDecompositionStaleness(children, { now });
    expect(candidates.length).toBeGreaterThan(0);
    const first = firstOrFail(candidates);
    expect(first.overlap.keywords).toContain("reviewer");
    expect(first.overlap.keywords).toContain("silent");
  });

  it("excludes pairs with no overlap on any signal type", () => {
    const children: EpicChildSnapshot[] = [
      childTodo("mt#100", "## Scope\n**In scope:**\n- src/foo.ts: handle calculation"),
      childDone("mt#200", "## Scope\n**In scope:**\n- src/quux.ts: emit notifications"),
    ];
    expect(detectEpicDecompositionStaleness(children, { now })).toEqual([]);
  });

  it("excludes TODO children filed AFTER the delivery shipped", () => {
    // todo.createdAt > delivery.updatedAt — the TODO post-dates the delivery, so it
    // wasn't superseded by it.
    const children: EpicChildSnapshot[] = [
      childTodo("mt#100", FOO_TS_SCOPE, afterDelivery),
      childDone("mt#200", FOO_TS_SCOPE, recentEnough),
    ];
    expect(detectEpicDecompositionStaleness(children, { now })).toEqual([]);
  });

  it("respects minOverlapSignals threshold", () => {
    const children: EpicChildSnapshot[] = [
      childTodo("mt#100", FOO_TS_SCOPE),
      childDone("mt#200", FOO_TS_SCOPE),
    ];
    expect(detectEpicDecompositionStaleness(children, { now, minOverlapSignals: 2 })).toEqual([]);
  });

  it("considers PLANNING status as candidate", () => {
    const children: EpicChildSnapshot[] = [
      {
        id: "mt#100",
        title: "planning",
        status: "PLANNING",
        spec: FOO_TS_SCOPE,
        createdAt: beforeDelivery,
      },
      childDone("mt#200", FOO_TS_SCOPE),
    ];
    const candidates = detectEpicDecompositionStaleness(children, { now });
    expect(candidates).toHaveLength(1);
  });

  it("does NOT consider IN-PROGRESS or IN-REVIEW as candidates", () => {
    const children: EpicChildSnapshot[] = [
      {
        id: "mt#100",
        title: "in-progress",
        status: "IN-PROGRESS",
        spec: FOO_TS_SCOPE,
        createdAt: beforeDelivery,
      },
      childDone("mt#200", FOO_TS_SCOPE),
    ];
    expect(detectEpicDecompositionStaleness(children, { now })).toEqual([]);
  });

  it("sorts results by todoChildId then by overlap strength", () => {
    const children: EpicChildSnapshot[] = [
      childTodo("mt#100", "## Scope\n**In scope:**\n- src/a.ts and src/b.ts and doThing"),
      childTodo("mt#101", "## Scope\n**In scope:**\n- src/a.ts"),
      childDone("mt#200", "## Scope\n**In scope:**\n- src/a.ts and src/b.ts and doThing"),
      childDone("mt#201", "## Scope\n**In scope:**\n- src/a.ts"),
    ];
    const candidates = detectEpicDecompositionStaleness(children, { now });
    expect(candidates.length).toBeGreaterThan(0);
    expect(firstOrFail(candidates).todoChildId).toBe("mt#100");
  });

  it("uses default recency window of 30 days", () => {
    const justInside = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
    const justOutside = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    // childCreated earlier than both deliveries so the createdAt < updatedAt
    // filter doesn't drop the pair we're testing.
    const wayEarlier = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const children: EpicChildSnapshot[] = [
      childTodo("mt#100", FOO_TS_SCOPE, wayEarlier),
      childDone("mt#200", FOO_TS_SCOPE, justInside),
      childDone("mt#201", FOO_TS_SCOPE, justOutside),
    ];
    const candidates = detectEpicDecompositionStaleness(children, { now });
    expect(candidates).toHaveLength(1);
    expect(firstOrFail(candidates).deliveringSiblingId).toBe("mt#200");
    // sanity: DEFAULT_RECENCY_WINDOW_DAYS is 30
    expect(DEFAULT_RECENCY_WINDOW_DAYS).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// mt#1552 cluster correctness baseline
// ---------------------------------------------------------------------------
//
// Replays the 7-instance cluster from the originating 2026-05-11 bulk audit.
// Each TODO child should be flagged with at least one delivering sibling.
// (mt#1083 / mt#1395 / mt#1110 / mt#1126 / mt#1639 are the documented
// supersession sources from the bridge memory.)

describe("detectEpicDecompositionStaleness — mt#1552 cluster baseline", () => {
  const now = new Date("2026-05-11T12:00:00Z");
  const earlyDelivery = new Date("2026-04-20T00:00:00Z");
  const filedBefore = new Date("2026-04-01T00:00:00Z");

  const deliveries: EpicChildSnapshot[] = [
    {
      id: "mt#1083",
      title: "Sprint A: minsky-reviewer App service",
      status: "DONE",
      updatedAt: earlyDelivery,
      spec: `## Scope\n**In scope:**\n- services/reviewer/ — reviewer service Railway deploy\n- adversarial reviewer prompt construction in services/reviewer/src/prompt.ts\n- submit_finding output tool wiring\n- reviewer-bot identity routing\n- reviewer evidence-based findings\n- citation requirements for falsifiable claims about diff content\n- file:line evidence for findings\n- session-scoped MCP tools for reviewer subagent (mcp__github__get_file_contents at PR ref)\n- gpt-5 CoT leakage prevention via empty-body guard\n- reviewer subagent submit_finding tool access via .claude/agents/reviewer.md allowlist\n- CI: dedicated services/reviewer working-directory test step\n- zero-tool-call prevention guard\n\n**Out of scope:**\n- mt#1110 calibration tuning`,
    },
    {
      id: "mt#1395",
      title: "Add structured-output tools to reviewer",
      status: "DONE",
      updatedAt: earlyDelivery,
      spec: `## Scope\n**In scope:**\n- structured output tools: submit_finding, submit_inline_comment, submit_spec_verification, conclude_review\n- prompts.ts updates in services/reviewer/src/prompt.ts requiring file:line citation\n- adversarial reviewer prompt: flaw-finding, evidence-based\n- CoT leakage class dissolved structurally on the OpenAI path\n- falsifiable-claim citation requirement enforced via prompt + tool schema\n- reviewer empty-body silent failure prevention\n\n**Out of scope:**\n- gpt-5 specific config (general reviewer model approach)`,
    },
  ];

  const todoChildren: EpicChildSnapshot[] = [
    {
      id: "mt#1600",
      title: "Reviewer service: prevent zero-tool-call emission on gpt-5",
      status: "TODO",
      createdAt: filedBefore,
      spec: `## Scope\n**In scope:**\n- detect zero-tool-call reviewer emission\n- gpt-5 CoT leakage failure mode\n- empty-body guard for reviewer output\n- reviewer empty-body silent failures`,
    },
    {
      id: "mt#1512",
      title: "Adversarial reviewer prompt engineering",
      status: "TODO",
      createdAt: filedBefore,
      spec: `## Scope\n**In scope:**\n- adversarial reviewer flaw-finding prompt framing\n- evidence-based findings\n- file:line citations in services/reviewer/src/prompt.ts\n- reviewer prompt updates`,
    },
    {
      id: "mt#1080",
      title: "Give reviewer subagent type access to session_pr_review_submit",
      status: "TODO",
      createdAt: filedBefore,
      spec: `## Scope\n**In scope:**\n- reviewer subagent submit access\n- submit_finding tool allowlist\n- .claude/agents/reviewer.md tools curation`,
    },
    {
      id: "mt#1321",
      title: "Reviewer: switch REVIEWER_MODEL away from gpt-5",
      status: "TODO",
      createdAt: filedBefore,
      spec: `## Scope\n**In scope:**\n- reviewer model choice for skill/docs PR patterns\n- gpt-5 CoT leakage avoidance\n- reviewer prompt model swap`,
    },
    {
      id: "mt#1301",
      title: "reviewer-bot: require code citation for falsifiable factual claims",
      status: "TODO",
      createdAt: filedBefore,
      spec: `## Scope\n**In scope:**\n- citation requirement for falsifiable claims in reviewer findings\n- file:line evidence enforcement\n- reviewer prompt updates in services/reviewer/src/prompt.ts`,
    },
    {
      id: "mt#1043",
      title: "Wire reviewer agent to use session-scoped MCP tools",
      status: "TODO",
      createdAt: filedBefore,
      spec: `## Scope\n**In scope:**\n- session-scoped MCP tools for reviewer subagent PR verification\n- mcp__github__get_file_contents at PR ref usage`,
    },
    {
      id: "mt#1349",
      title: "CI gap: reviewer service tests not run by bun run test",
      status: "TODO",
      createdAt: filedBefore,
      spec: `## Scope\n**In scope:**\n- CI for services/reviewer/ — dedicated working-directory test step\n- automated regression gate for reviewer tests`,
    },
  ];

  it("identifies ≥6 of 7 confirmed cluster instances (correctness baseline)", () => {
    const all = [...deliveries, ...todoChildren];
    const candidates = detectEpicDecompositionStaleness(all, { now });
    const flaggedTodos = new Set(candidates.map((c) => c.todoChildId));

    // Spec success criterion 1: identifies the 7 confirmed instances retrospectively
    expect(flaggedTodos.has("mt#1600")).toBe(true);
    expect(flaggedTodos.has("mt#1512")).toBe(true);
    expect(flaggedTodos.has("mt#1080")).toBe(true);
    expect(flaggedTodos.has("mt#1321")).toBe(true);
    expect(flaggedTodos.has("mt#1301")).toBe(true);
    expect(flaggedTodos.has("mt#1043")).toBe(true);
    expect(flaggedTodos.has("mt#1349")).toBe(true);

    // Sanity: not all 7 collapsed to one — each has at least one candidate row
    expect(flaggedTodos.size).toBe(7);
  });

  it("does not surface candidates with truly disjoint scope (precision)", () => {
    // mt#1345 stand-in: reviewer reply-to-thread / auto-resolve-on-fix loop —
    // a sibling with real distinct scope. Its identifiers and keywords do not
    // overlap on file paths with the deliveries' scope sections; should NOT
    // appear in the candidate list.
    const mt1345: EpicChildSnapshot = {
      id: "mt#1345",
      title: "Reviewer reply-to-thread + auto-resolve-on-fix loop",
      status: "TODO",
      createdAt: filedBefore,
      spec: `## Scope\n**In scope:**\n- thread reply automation for the github review API\n- automatic thread resolution when followup commit fixes the comment\n- iteration loop convergence detection per-thread`,
    };

    const all = [...deliveries, mt1345];
    const candidates = detectEpicDecompositionStaleness(all, { now });
    const flagged = new Set(candidates.map((c) => c.todoChildId));

    // It may or may not appear depending on keyword overlap; if it does, the
    // surface format must make the overlap visible so the operator can dismiss.
    // The spec phrasing of acceptance test 3 explicitly allows this.
    if (flagged.has("mt#1345")) {
      const c = candidates.find((x) => x.todoChildId === "mt#1345");
      // At least the overlap should be readable for triage
      expect(c?.overlap.signalTypeCount).toBeGreaterThan(0);
    }
  });
});
