import { describe, test, expect } from "bun:test";
import type { RefResolvers } from "../refs";
import {
  createTasksPackageSucceedCommand,
  parseMemberList,
  resolveSuccessionMembers,
  WORK_PACKAGE_SUCCEED_COMMAND_ID,
} from "./work-package-succession-command";

/** Resolvers backed by a fixed map of known refs → status. */
function makeResolvers(known: Record<string, string>): RefResolvers {
  const lookup = async (id: string) =>
    id in known ? { found: true as const, status: known[id] } : { found: false as const };
  return {
    getTaskStatus: lookup,
    getChangesetStatus: lookup,
    getAskState: lookup,
    getMemoryState: lookup,
    getWorkspaceState: lookup,
  };
}

const SUCCESSION_SPEC = `# Handoff: onboarding queue

Origin: succession

## Situation

mt#1 shipped this hop; mt#2 and mt#3 remain, mt#4 was surfaced by the review.

## Decisions

Kept mt#3 ahead of mt#4 — it unblocks the deploy.

## Provenance

Written by this conversation at 12:00Z from PR #3749's review thread.

## Members

1. mt#2 — next: the migration
2. mt#3 — unblocks the deploy
3. mt#4
`;

const GROOMED_SPEC = `Origin: groomed

## Members

1. mt#2 — first

## Grouping rationale

Same widget.
`;

describe("parseMemberList", () => {
  test("splits on commas, trims, drops empties, keeps order", () => {
    expect(parseMemberList(" mt#3, mt#1 ,,mt#2 ")).toEqual(["mt#3", "mt#1", "mt#2"]);
    expect(parseMemberList("")).toEqual([]);
  });

  test("a repeated ref keeps its first position (PR #3751 R1)", () => {
    expect(parseMemberList("mt#3,mt#1,mt#3,mt#2,mt#1")).toEqual(["mt#3", "mt#1", "mt#2"]);
  });
});

describe("resolveSuccessionMembers (mt#5133)", () => {
  test("spec form: a valid succession briefing yields its members with live statuses", async () => {
    const out = await resolveSuccessionMembers(
      { spec: SUCCESSION_SPEC },
      makeResolvers({ "mt#1": "DONE", "mt#2": "READY", "mt#3": "TODO", "mt#4": "TODO" })
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.spec).toBe(SUCCESSION_SPEC);
    expect(out.members).toEqual([
      { taskId: "mt#2", rationale: "next: the migration", statusAtWrite: "READY" },
      { taskId: "mt#3", rationale: "unblocks the deploy", statusAtWrite: "TODO" },
      { taskId: "mt#4", rationale: null, statusAtWrite: "TODO" },
    ]);
  });

  test("spec form: a cited ref that does not exist refuses, naming it (AT2)", async () => {
    const out = await resolveSuccessionMembers(
      { spec: SUCCESSION_SPEC },
      makeResolvers({ "mt#1": "DONE", "mt#2": "READY", "mt#3": "TODO" })
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.reason).toBe("unresolved-refs");
    expect(out.message).toContain("mt#4");
  });

  test("spec form: a groomed briefing is refused as wrong-origin", async () => {
    const out = await resolveSuccessionMembers(
      { spec: GROOMED_SPEC },
      makeResolvers({ "mt#2": "READY" })
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.reason).toBe("wrong-origin");
  });

  test("spec form: a structurally invalid briefing is refused by the create seam", async () => {
    const out = await resolveSuccessionMembers(
      { spec: "Origin: succession\n\n## Members\n\n- mt#2\n" },
      makeResolvers({ "mt#2": "READY" })
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.reason).toBe("invalid-briefing");
    expect(out.message).toContain("Situation");
  });

  test("members form: each ref resolved, statuses captured, no spec replacement", async () => {
    const out = await resolveSuccessionMembers(
      { members: "mt#3,mt#2" },
      makeResolvers({ "mt#2": "READY", "mt#3": "IN-PROGRESS" })
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.spec).toBeNull();
    expect(out.members).toEqual([
      { taskId: "mt#3", rationale: null, statusAtWrite: "IN-PROGRESS" },
      { taskId: "mt#2", rationale: null, statusAtWrite: "READY" },
    ]);
  });

  test("members form: an unknown ref refuses, naming it (AT2)", async () => {
    const out = await resolveSuccessionMembers(
      { members: "mt#2,mt#999" },
      makeResolvers({ "mt#2": "READY" })
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.reason).toBe("unresolved-refs");
    expect(out.message).toContain("mt#999");
    expect(out.message).not.toContain("mt#2 (");
  });

  test("neither form: members and spec both untouched", async () => {
    const out = await resolveSuccessionMembers({}, makeResolvers({}));
    expect(out).toEqual({ ok: true, spec: null, members: null });
  });
});

describe("tasks.package.succeed command shape", () => {
  const command = createTasksPackageSucceedCommand(() => undefined);

  test("registers under the spec's id with the succession parameters", () => {
    expect(command.id).toBe(WORK_PACKAGE_SUCCEED_COMMAND_ID);
    expect(command.id).toBe("tasks.package.succeed");
    expect(Object.keys(command.parameters).sort()).toEqual([
      "callerActorId",
      "members",
      "notes",
      "releaseClaim",
      "spec",
      "taskId",
    ]);
    expect(command.parameters.releaseClaim.defaultValue).toBe(true);
  });

  test("validate() refuses spec AND members together", async () => {
    await expect(
      command.validate?.(
        { taskId: "mt#1", notes: "n", spec: "x", members: "mt#2" } as never,
        {} as never
      )
    ).rejects.toThrow(/either --spec .* or --members/);
  });

  test("validate() refuses a malformed member ref, an empty notes, an unqualified task id", async () => {
    await expect(
      command.validate?.(
        { taskId: "mt#1", notes: "n", members: "mt#2, fix it" } as never,
        {} as never
      )
    ).rejects.toThrow(/qualified task refs.*fix it/);
    await expect(
      command.validate?.({ taskId: "mt#1", notes: "   " } as never, {} as never)
    ).rejects.toThrow(/notes is required/);
    await expect(
      command.validate?.({ taskId: "1", notes: "n" } as never, {} as never)
    ).rejects.toThrow(/Invalid task ID/);
  });

  test("validate() accepts each form alone", async () => {
    await expect(
      command.validate?.({ taskId: "mt#1", notes: "n", members: "mt#2,mt#3" } as never, {} as never)
    ).resolves.toBeUndefined();
    await expect(
      command.validate?.(
        { taskId: "mt#1", notes: "n", spec: SUCCESSION_SPEC } as never,
        {} as never
      )
    ).resolves.toBeUndefined();
    await expect(
      command.validate?.({ taskId: "mt#1", notes: "n" } as never, {} as never)
    ).resolves.toBeUndefined();
  });
});
