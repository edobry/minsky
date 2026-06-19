import { describe, it, expect } from "bun:test";
import { mapSessionPrListParams } from "./pr-list-command";

/**
 * mt#2516 regression. The `session.pr.list` command's parameter schema exposes the
 * identity key as `sessionId`, but the handler previously read `params.session` — a
 * key that is never populated — so the session filter was silently dropped.
 * `mapSessionPrListParams` must read `sessionId` and surface it as the domain `session`
 * filter.
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
