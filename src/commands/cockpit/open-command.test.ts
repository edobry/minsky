import { describe, test, expect } from "bun:test";
import { buildOpenPlan } from "./open-command";
import type { ResolvedCockpit } from "./url-command";

const CONVERSATION_ID = "b310a426-7dac-4ab6-aea5-1552de51a390";

const RUNNING: ResolvedCockpit = {
  source: "main",
  state: {
    pid: 49326,
    port: 3737,
    url: "http://localhost:3737",
    workspaceId: "main",
    workspacePath: "/Users/someone/Projects/minsky",
    startedAt: "2026-08-05T22:17:16.552Z",
  },
};

describe("buildOpenPlan (mt#3807)", () => {
  test("tries the tray deeplink first, then the browser URL", () => {
    // minsky:// first so the cockpit WINDOW fronts; a browser tab is the fallback.
    const plan = buildOpenPlan({ envConversationId: CONVERSATION_ID, resolved: RUNNING });
    expect(plan).toEqual({
      kind: "open",
      conversationId: CONVERSATION_ID,
      targets: [
        `minsky://conversation/${CONVERSATION_ID}`,
        `http://localhost:3737/conversation/${CONVERSATION_ID}`,
      ],
    });
  });

  test("still plans the tray deeplink when no cockpit is running", () => {
    // The tray registers the scheme and launches the daemon itself, so an
    // un-running cockpit is not a reason to refuse — only the browser fallback
    // needs a URL to point at.
    const plan = buildOpenPlan({ envConversationId: CONVERSATION_ID, resolved: null });
    expect(plan).toEqual({
      kind: "open",
      conversationId: CONVERSATION_ID,
      targets: [`minsky://conversation/${CONVERSATION_ID}`],
    });
  });

  test("errors, naming the variable, when no conversation id is available", () => {
    const plan = buildOpenPlan({ envConversationId: undefined, resolved: RUNNING });
    expect(plan.kind).toBe("error");
    if (plan.kind !== "error") throw new Error("expected an error plan");
    expect(plan.message[0]).toContain("CLAUDE_CODE_SESSION_ID");
    expect(plan.message.join("\n")).toContain("--conversation");
  });

  test("treats a whitespace-only id as absent", () => {
    // An unset env var read through a shell can arrive as "" or " " rather than
    // undefined; both mean "no conversation", not "open /conversation/ ".
    expect(buildOpenPlan({ envConversationId: "   ", resolved: RUNNING }).kind).toBe("error");
    expect(buildOpenPlan({ envConversationId: "", resolved: RUNNING }).kind).toBe("error");
  });

  test("percent-encodes the id so a hostile value cannot escape the path", () => {
    const plan = buildOpenPlan({ envConversationId: "a b/../c", resolved: RUNNING });
    if (plan.kind !== "open") throw new Error("expected an open plan");
    expect(plan.targets[0]).toBe("minsky://conversation/a%20b%2F..%2Fc");
    expect(plan.targets[1]).toBe("http://localhost:3737/conversation/a%20b%2F..%2Fc");
  });
});
