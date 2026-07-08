import { describe, it, expect } from "bun:test";
import { mapSessionPrListParams, createSessionPrListCommand } from "./pr-list-command";

/**
 * mt#2516 regression. The `session.pr.list` command's parameter schema exposes the
 * identity key as `sessionId`, but the handler previously read `params.session` — a
 * key that is never populated — so the session filter was silently dropped.
 */
describe("session pr list — param mapping (mt#2516)", () => {
  it("maps the `sessionId` command param to the domain `session` filter", () => {
    const mapped = mapSessionPrListParams({ sessionId: "task-mt-2516" });
    expect(mapped.session).toBe("task-mt-2516");
  });

  it("ignores a stray `session` key (the pre-fix bug would have used it and dropped the real filter)", () => {
    const mapped = mapSessionPrListParams({ session: "wrong-key" });
    expect(mapped.session).toBeUndefined();
  });

  it("passes through the other documented filters unchanged", () => {
    const mapped = mapSessionPrListParams({
      sessionId: "s1",
      task: "mt#1",
      status: "open",
      backend: "github",
      json: true,
    });
    expect(mapped.task).toBe("mt#1");
    expect(mapped.status).toBe("open");
    expect(mapped.backend).toBe("github");
    expect(mapped.json).toBe(true);
  });
});

/**
 * Behavioral regression at the command `execute` boundary (Acceptance Test #3): the
 * domain `sessionPrList` is injected as a stub that records its filter args, so we can
 * assert that passing `sessionId: "X"` reaches the domain call as `session: "X"`. The
 * pre-fix handler read `params.session` (undefined), so the stub would have seen
 * `session: undefined` — the silent filter drop this fix repairs.
 */
describe("session pr list — execute honors sessionId (mt#2516)", () => {
  it("execute() passes the sessionId param to the domain call as the `session` filter", async () => {
    const calls: Array<{ session?: string }> = [];
    const fakeListFn = ((args: { session?: string }) => {
      calls.push(args);
      return Promise.resolve({
        pullRequests: [
          { sessionId: "X", taskId: "mt#1", status: "open", title: "t", prNumber: 1, url: "u" },
        ],
      });
    }) as any;

    const command = createSessionPrListCommand(
      async () => ({ sessionProvider: {} as any }) as any,
      fakeListFn
    );

    const result = (await command.execute({ sessionId: "X", json: true }, {
      interface: "cli",
    } as any)) as { success?: boolean; pullRequests?: unknown[] };

    expect(calls).toHaveLength(1);
    expect(calls[0]?.session).toBe("X");
    expect(result.success).toBe(true);
    expect(result.pullRequests).toHaveLength(1);
  });
});
