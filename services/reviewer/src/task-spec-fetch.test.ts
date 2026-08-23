import { describe, expect, test } from "bun:test";
import type { TaskServiceInterface } from "@minsky/domain/tasks";
import {
  extractTaskId,
  resolveTaskSpec,
  extractReferencedTaskIds,
  extractReferencedTaskRefs,
  resolveReferencedTaskSpecs,
  MAX_REFERENCED_TASK_SPECS,
  MAX_REFERENCED_SPEC_CHARS_PER_TASK,
  MAX_REFERENCED_SPECS_TOTAL_CHARS,
} from "./task-spec-fetch";

const SAMPLE_SPEC_BODY = "## Summary\n\nThe spec body.";
const REFERENCED_SPEC_BODY = "## Success Criteria\n\n- [ ] scoped package name.";
const DB_ERROR_MESSAGE = "Database connection failed";

/**
 * Build a minimal fake TaskServiceInterface for task-spec-fetch tests.
 * Only getTaskSpecContent is relevant here.
 */
function makeTaskService(spec: string | null): TaskServiceInterface {
  return {
    getTaskSpecContent: async (_taskId: string) => {
      if (spec === null) {
        throw new Error("task not found");
      }
      return { task: {} as never, specPath: "/fake/path", content: spec };
    },
  } as unknown as TaskServiceInterface;
}

describe("extractTaskId", () => {
  test("pulls mt#NNNN from a task/mt-XXXX branch name", () => {
    expect(extractTaskId({ branchName: "task/mt-1187", prTitle: "" })).toBe("mt#1187");
  });

  test("pulls mt#NNNN from a feat(mt#XXXX): PR title", () => {
    expect(extractTaskId({ branchName: "", prTitle: "feat(mt#1110): calibrate reviewer" })).toBe(
      "mt#1110"
    );
  });

  test("matches the [mt-NNNN] bracket form", () => {
    expect(extractTaskId({ branchName: "", prTitle: "[mt-42] cleanup" })).toBe("mt#42");
  });

  test("branch name takes priority over title when both match", () => {
    expect(extractTaskId({ branchName: "task/mt-1187", prTitle: "mt-999 something" })).toBe(
      "mt#1187"
    );
  });

  test("falls back to title when branch has no match", () => {
    expect(extractTaskId({ branchName: "main", prTitle: "fix(mt#555): x" })).toBe("mt#555");
  });

  test("returns null when neither has a match", () => {
    expect(extractTaskId({ branchName: "main", prTitle: "misc cleanup" })).toBeNull();
  });

  test("returns null on null inputs", () => {
    expect(extractTaskId({ branchName: null, prTitle: null })).toBeNull();
  });

  test("is case-insensitive on the mt prefix", () => {
    expect(extractTaskId({ branchName: "task/MT-77", prTitle: "" })).toBe("mt#77");
  });

  test("does not match mid-word false positives (word boundary)", () => {
    expect(extractTaskId({ branchName: "fmt-1234", prTitle: "" })).toBeNull();
    expect(extractTaskId({ branchName: "", prTitle: "bump amount-123" })).toBeNull();
    expect(extractTaskId({ branchName: "", prTitle: "drop comment-99" })).toBeNull();
  });
});

describe("resolveTaskSpec", () => {
  test("returns disabled when taskService is absent (null)", async () => {
    const { taskSpec, fetchResult } = await resolveTaskSpec({
      branchName: "task/mt-1187",
      prTitle: "",
      taskService: null,
    });
    expect(taskSpec).toBeNull();
    expect(fetchResult.status).toBe("disabled");
    expect(fetchResult.taskId).toBeUndefined();
  });

  test("returns disabled when taskService is absent (undefined)", async () => {
    const { taskSpec, fetchResult } = await resolveTaskSpec({
      branchName: "task/mt-1187",
      prTitle: "",
    });
    expect(taskSpec).toBeNull();
    expect(fetchResult.status).toBe("disabled");
  });

  test("returns no-task-id when no mt# reference is in branch or title", async () => {
    const { taskSpec, fetchResult } = await resolveTaskSpec({
      branchName: "main",
      prTitle: "misc cleanup",
      taskService: makeTaskService(SAMPLE_SPEC_BODY),
    });
    expect(taskSpec).toBeNull();
    expect(fetchResult.status).toBe("no-task-id");
  });

  test("returns found with specLength when the TaskService returns content", async () => {
    const { taskSpec, fetchResult } = await resolveTaskSpec({
      branchName: "task/mt-1187",
      prTitle: "",
      taskService: makeTaskService(SAMPLE_SPEC_BODY),
    });
    expect(taskSpec).toBe(SAMPLE_SPEC_BODY);
    expect(fetchResult.status).toBe("found");
    expect(fetchResult.taskId).toBe("mt#1187");
    expect(fetchResult.specLength).toBe(SAMPLE_SPEC_BODY.length);
  });

  test("returns not-found when the TaskService returns null content", async () => {
    // makeTaskService(null) throws a "task not found" error — which resolveTaskSpec
    // maps to not-found via the /not.found|does not exist|no such/i regex.
    const { taskSpec, fetchResult } = await resolveTaskSpec({
      branchName: "task/mt-9999",
      prTitle: "",
      taskService: makeTaskService(null),
    });
    expect(taskSpec).toBeNull();
    expect(fetchResult.status).toBe("not-found");
    expect(fetchResult.taskId).toBe("mt#9999");
  });

  test("returns error with message when the TaskService throws an unexpected error", async () => {
    const errorService = {
      getTaskSpecContent: async (_taskId: string) => {
        throw new Error(DB_ERROR_MESSAGE);
      },
    } as unknown as TaskServiceInterface;

    const { taskSpec, fetchResult } = await resolveTaskSpec({
      branchName: "task/mt-42",
      prTitle: "",
      taskService: errorService,
    });
    expect(taskSpec).toBeNull();
    expect(fetchResult.status).toBe("error");
    expect(fetchResult.taskId).toBe("mt#42");
    expect(fetchResult.error).toBe(DB_ERROR_MESSAGE);
  });
});

describe("extractReferencedTaskIds (mt#3919)", () => {
  test("finds a single mt#NNNN reference", () => {
    expect(extractReferencedTaskIds("update task mt#3874's spec/ATs")).toEqual(["mt#3874"]);
  });

  test("finds multiple distinct references in first-occurrence order", () => {
    expect(extractReferencedTaskIds("see mt#10 and mt-20, then mt#10 again")).toEqual([
      "mt#10",
      "mt#20",
    ]);
  });

  test("excludes the self-reference when selfTaskId is provided", () => {
    expect(extractReferencedTaskIds("mt#3915 depends on mt#3874", "mt#3915")).toEqual(["mt#3874"]);
  });

  test("self-exclusion normalizes mt-NNNN and mt#NNNN forms alike", () => {
    expect(extractReferencedTaskIds("see mt#3915 and mt#3874", "mt-3915")).toEqual(["mt#3874"]);
  });

  test("returns [] when the text has no reference", () => {
    expect(extractReferencedTaskIds("no references here")).toEqual([]);
  });

  test("returns [] for empty text", () => {
    expect(extractReferencedTaskIds("")).toEqual([]);
  });

  test("caps at MAX_REFERENCED_TASK_SPECS distinct references", () => {
    const many = Array.from({ length: MAX_REFERENCED_TASK_SPECS + 5 }, (_, i) => `mt#${i}`).join(
      " "
    );
    expect(extractReferencedTaskIds(many)).toHaveLength(MAX_REFERENCED_TASK_SPECS);
  });
});

describe("resolveReferencedTaskSpecs (mt#3919)", () => {
  const CRITERIA_TEXT = "## Success Criteria\n\n- [ ] mt#3874's spec must be updated.";

  test("returns [] when taskSpec is null", async () => {
    const results = await resolveReferencedTaskSpecs({
      taskSpec: null,
      boundTaskId: "mt#3915",
      taskService: makeTaskService(SAMPLE_SPEC_BODY),
    });
    expect(results).toEqual([]);
  });

  test("returns [] when taskSpec has no mt#NNNN references", async () => {
    const results = await resolveReferencedTaskSpecs({
      taskSpec: "## Success Criteria\n\n- [ ] no references here.",
      boundTaskId: "mt#3915",
      taskService: makeTaskService(SAMPLE_SPEC_BODY),
    });
    expect(results).toEqual([]);
  });

  test("excludes the bound task's own id", async () => {
    const results = await resolveReferencedTaskSpecs({
      taskSpec: "mt#3915 says: see also mt#3915 for context.",
      boundTaskId: "mt#3915",
      taskService: makeTaskService(SAMPLE_SPEC_BODY),
    });
    expect(results).toEqual([]);
  });

  test("returns a `disabled` entry per reference when taskService is absent — the model still SEES the reference", async () => {
    const results = await resolveReferencedTaskSpecs({
      taskSpec: CRITERIA_TEXT,
      boundTaskId: "mt#3915",
      taskService: null,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.taskId).toBe("mt#3874");
    expect(results[0]?.content).toBeNull();
    expect(results[0]?.fetchResult.status).toBe("disabled");
  });

  test("returns `found` with content + the SPEC-CONTENT updatedAt (mt#4415)", async () => {
    // Two distinct timestamps, deliberately: the prompt labels this field
    // "(spec last updated X)", so it must track the spec's TEXT, not the task
    // row that any status transition bumps. Before mt#4415 this read the row's
    // value, and a spec untouched for weeks was presented to the reviewer as
    // edited moments ago.
    const specUpdatedAt = new Date("2026-08-10T17:53:58.889Z");
    const taskRowUpdatedAt = new Date("2026-08-21T09:00:00.000Z");
    const taskService = {
      getTaskSpecContent: async (taskId: string) => {
        expect(taskId).toBe("mt#3874");
        return {
          task: { updatedAt: taskRowUpdatedAt } as never,
          specPath: "/fake/mt-3874.md",
          content: REFERENCED_SPEC_BODY,
          specUpdatedAt,
        };
      },
    } as unknown as TaskServiceInterface;

    const results = await resolveReferencedTaskSpecs({
      taskSpec: CRITERIA_TEXT,
      boundTaskId: "mt#3915",
      taskService,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.taskId).toBe("mt#3874");
    expect(results[0]?.content).toBe(REFERENCED_SPEC_BODY);
    expect(results[0]?.updatedAt).toBe(specUpdatedAt.toISOString());
    // The discriminating assertion: the row timestamp must NOT be what surfaces.
    expect(results[0]?.updatedAt).not.toBe(taskRowUpdatedAt.toISOString());
    expect(results[0]?.fetchResult.status).toBe("found");
  });

  test("omits the timestamp rather than substituting the task row's when no spec timestamp exists (mt#4415)", async () => {
    const taskService = {
      getTaskSpecContent: async () => ({
        task: { updatedAt: new Date("2026-08-21T09:00:00.000Z") } as never,
        specPath: "/fake/mt-3874.md",
        content: REFERENCED_SPEC_BODY,
        // No specUpdatedAt: a backend that tracks none.
      }),
    } as unknown as TaskServiceInterface;

    const results = await resolveReferencedTaskSpecs({
      taskSpec: CRITERIA_TEXT,
      boundTaskId: "mt#3915",
      taskService,
    });

    // null drops the "(spec last updated X)" suffix from the prompt entirely,
    // which is the honest rendering — a wrong date is worse than no date.
    expect(results[0]?.updatedAt).toBeNull();
    expect(results[0]?.fetchResult.status).toBe("found");
  });

  test("returns `not-found` when the referenced task's spec content is empty", async () => {
    const results = await resolveReferencedTaskSpecs({
      taskSpec: CRITERIA_TEXT,
      boundTaskId: "mt#3915",
      taskService: makeTaskService(null),
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.taskId).toBe("mt#3874");
    expect(results[0]?.content).toBeNull();
    expect(results[0]?.fetchResult.status).toBe("not-found");
  });

  test("returns `error` with message when the TaskService throws unexpectedly", async () => {
    const errorService = {
      getTaskSpecContent: async (_taskId: string) => {
        throw new Error(DB_ERROR_MESSAGE);
      },
    } as unknown as TaskServiceInterface;

    const results = await resolveReferencedTaskSpecs({
      taskSpec: CRITERIA_TEXT,
      boundTaskId: "mt#3915",
      taskService: errorService,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBeNull();
    expect(results[0]?.fetchResult.status).toBe("error");
    expect(results[0]?.fetchResult.error).toBe(DB_ERROR_MESSAGE);
  });

  test("resolves multiple distinct references independently", async () => {
    const specs: Record<string, string | null> = {
      "mt#3874": "found content",
      "mt#9999": null,
    };
    const taskService = {
      getTaskSpecContent: async (taskId: string) => {
        const content = specs[taskId] ?? null;
        if (content === null) throw new Error("task not found");
        return { task: {} as never, specPath: "/fake", content };
      },
    } as unknown as TaskServiceInterface;

    const results = await resolveReferencedTaskSpecs({
      taskSpec: "see mt#3874 and mt#9999",
      boundTaskId: "mt#3915",
      taskService,
    });

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.taskId === "mt#3874")?.fetchResult.status).toBe("found");
    expect(results.find((r) => r.taskId === "mt#9999")?.fetchResult.status).toBe("not-found");
  });
});

describe("extractReferencedTaskRefs section hints (mt#3919 R1 BLOCKING)", () => {
  test("attaches a section hint when a keyword appears near the reference", () => {
    const refs = extractReferencedTaskRefs(
      "- [ ] mt#3874's success criteria and acceptance tests are updated to the scoped name"
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.taskId).toBe("mt#3874");
    expect(refs[0]?.sectionHints).toEqual(
      expect.arrayContaining(["Success Criteria", "Acceptance Tests"])
    );
  });

  test("returns no hints when nothing nearby matches a known keyword", () => {
    const refs = extractReferencedTaskRefs("- [ ] mt#3874 has been closed out.");
    expect(refs).toHaveLength(1);
    expect(refs[0]?.sectionHints).toEqual([]);
  });

  test("a keyword outside the scan window does not attach a hint", () => {
    // "success criteria" appears once, then 400+ chars of unrelated filler
    // (well past SECTION_HINT_WINDOW_CHARS=300) before the reference — the
    // keyword must not bleed across that gap.
    const filler = "unrelated filler text ".repeat(20); // ~460 chars
    const refs = extractReferencedTaskRefs(
      `The success criteria are listed elsewhere. ${filler}\n\nmt#3874 is referenced way down here.`
    );
    expect(refs[0]?.sectionHints).toEqual([]);
  });

  test("extractReferencedTaskIds stays an id-only view of the same extraction", () => {
    const text = "mt#3874's success criteria need updating, see also mt#10.";
    expect(extractReferencedTaskIds(text)).toEqual(
      extractReferencedTaskRefs(text).map((r) => r.taskId)
    );
  });
});

// Shared fixture: a criterion whose local text hints at the "Success
// Criteria" section. Reused across the section-targeted-injection tests
// below (custom/no-magic-string-duplication).
const CRITERION_HINTING_SUCCESS_CRITERIA = "- [ ] mt#3874's success criteria are updated.";

describe("resolveReferencedTaskSpecs — section-targeted injection (mt#3919 R1 BLOCKING)", () => {
  test("injects only the hinted section, not an unrelated large section in the same spec", async () => {
    const largeContext = "x".repeat(5_000);
    const fullSpec =
      "## Success Criteria\n\n- [ ] scoped package name.\n\n" + `## Context\n\n${largeContext}\n`;
    const taskService = {
      getTaskSpecContent: async (_taskId: string) => ({
        task: {} as never,
        specPath: "/fake",
        content: fullSpec,
      }),
    } as unknown as TaskServiceInterface;

    const results = await resolveReferencedTaskSpecs({
      taskSpec: CRITERION_HINTING_SUCCESS_CRITERIA,
      boundTaskId: "mt#3915",
      taskService,
    });

    expect(results).toHaveLength(1);
    const [entry] = results;
    expect(entry?.content).toContain("scoped package name.");
    expect(entry?.content).not.toContain(largeContext);
    expect(entry?.sectionsInjected).toEqual(["Success Criteria"]);
    expect(entry?.truncated).toBe(false);
  });

  test("unions in an AMENDED section even when it was not an explicit hint", async () => {
    const fullSpec =
      "## Success Criteria\n\n- [ ] the old (unscoped) name.\n\n" +
      "## AMENDED 2026-08-10\n\nThe name is now scoped: @edobry/minsky.\n";
    const taskService = {
      getTaskSpecContent: async (_taskId: string) => ({
        task: {} as never,
        specPath: "/fake",
        content: fullSpec,
      }),
    } as unknown as TaskServiceInterface;

    const results = await resolveReferencedTaskSpecs({
      taskSpec: CRITERION_HINTING_SUCCESS_CRITERIA,
      boundTaskId: "mt#3915",
      taskService,
    });

    const [entry] = results;
    expect(entry?.content).toContain("the old (unscoped) name.");
    expect(entry?.content).toContain("AMENDED 2026-08-10");
    expect(entry?.content).toContain("now scoped: @edobry/minsky");
  });

  test("falls back to the whole spec when no hint matches any heading in THIS spec", async () => {
    const fullSpec = "## Different Heading\n\nsome content that has no matching section.\n";
    const taskService = {
      getTaskSpecContent: async (_taskId: string) => ({
        task: {} as never,
        specPath: "/fake",
        content: fullSpec,
      }),
    } as unknown as TaskServiceInterface;

    const results = await resolveReferencedTaskSpecs({
      taskSpec: CRITERION_HINTING_SUCCESS_CRITERIA,
      boundTaskId: "mt#3915",
      taskService,
    });

    expect(results[0]?.content).toBe(fullSpec);
    expect(results[0]?.sectionsInjected).toBeUndefined();
  });
});

describe("resolveReferencedTaskSpecs — size caps (mt#3919 PR #2841 R1 BLOCKING)", () => {
  test("truncates a whole-spec fallback that exceeds the per-task cap", async () => {
    const oversized = "y".repeat(MAX_REFERENCED_SPEC_CHARS_PER_TASK + 1_000);
    const taskService = {
      getTaskSpecContent: async (_taskId: string) => ({
        task: {} as never,
        specPath: "/fake",
        content: oversized,
      }),
    } as unknown as TaskServiceInterface;

    const results = await resolveReferencedTaskSpecs({
      taskSpec: "mt#3874 is referenced with no section keyword nearby.",
      boundTaskId: "mt#3915",
      taskService,
    });

    const [entry] = results;
    expect(entry?.content).not.toBeNull();
    expect(entry?.content?.length).toBe(MAX_REFERENCED_SPEC_CHARS_PER_TASK);
    expect(entry?.truncated).toBe(true);
    expect(entry?.omittedChars).toBe(1_000);
  });

  test("does not truncate content that fits comfortably under the per-task cap", async () => {
    const small = "## Summary\n\nShort spec.";
    const taskService = {
      getTaskSpecContent: async (_taskId: string) => ({
        task: {} as never,
        specPath: "/fake",
        content: small,
      }),
    } as unknown as TaskServiceInterface;

    const results = await resolveReferencedTaskSpecs({
      taskSpec: "mt#3874 has no hint nearby.",
      boundTaskId: "mt#3915",
      taskService,
    });

    expect(results[0]?.content).toBe(small);
    expect(results[0]?.truncated).toBe(false);
    expect(results[0]?.omittedChars).toBe(0);
  });

  test("enforces the TOTAL budget across several references — later ones truncate further, then omit entirely", async () => {
    // Four references, each fetching 9,000 chars of whole-spec content (no
    // section hints — deliberately, to isolate the total-budget behavior
    // from section-targeting). Per-task cap is 8,000; total budget is
    // 20,000. Walking the math: ref1 -> capped to 8,000 (total=8,000);
    // ref2 -> capped to 8,000 (total=16,000); ref3 -> only 4,000 remain, so
    // it is capped to 4,000 (total=20,000); ref4 -> the total is already
    // exhausted, so it is omitted entirely (content: null).
    const PER_REF_CONTENT_CHARS = 9_000;
    const oneSpec = "z".repeat(PER_REF_CONTENT_CHARS);
    const taskService = {
      getTaskSpecContent: async (_taskId: string) => ({
        task: {} as never,
        specPath: "/fake",
        content: oneSpec,
      }),
    } as unknown as TaskServiceInterface;

    const taskSpec = "see mt#1001, mt#1002, mt#1003, and mt#1004 — no section keywords here.";
    const results = await resolveReferencedTaskSpecs({
      taskSpec,
      boundTaskId: "mt#3915",
      taskService,
    });

    expect(results).toHaveLength(4);
    const [r1, r2, r3, r4] = results;

    expect(r1?.content?.length).toBe(MAX_REFERENCED_SPEC_CHARS_PER_TASK);
    expect(r1?.truncated).toBe(true);

    expect(r2?.content?.length).toBe(MAX_REFERENCED_SPEC_CHARS_PER_TASK);
    expect(r2?.truncated).toBe(true);

    // Only 4,000 chars of total budget remain for r3.
    expect(r3?.content?.length).toBe(4_000);
    expect(r3?.truncated).toBe(true);

    // Total budget is exhausted before r4's turn — content omitted, but the
    // fetch itself succeeded (distinguishing "budget" from "fetch failure").
    expect(r4?.content).toBeNull();
    expect(r4?.truncated).toBe(true);
    expect(r4?.omittedChars).toBe(PER_REF_CONTENT_CHARS);
    expect(r4?.fetchResult.status).toBe("found");

    const totalInjected = [r1, r2, r3].reduce((sum, r) => sum + (r?.content?.length ?? 0), 0);
    expect(totalInjected).toBeLessThanOrEqual(MAX_REFERENCED_SPECS_TOTAL_CHARS);
  });
});
