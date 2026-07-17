/**
 * Tests for the shared entity-label resolver (mt#2883).
 *
 * Pure-function coverage: requestor formatting (ascribed-identity handling)
 * and per-kind tab-label resolution with fallback behavior. The
 * `useEntityLabel` hook is a thin query-wiring layer over `resolveTabLabel`;
 * the resolution logic is what carries the correctness burden.
 */
import { describe, expect, test } from "bun:test";
import {
  formatRequestor,
  formatRequestorOption,
  resolveTabLabel,
  EMPTY_LABEL_SOURCES,
  type LabelSources,
} from "./entity-labels";

/** Fixture ascribed-identity actor id, shared across the requestor tests. */
const ASCRIBED_FIXTURE = "unknown:hash:f5a2b3c4d5e6";
/** Fixture task title shared between the task-index and agent-row sources. */
const TASK_TITLE_FIXTURE = "Cockpit identity legibility";

describe("formatRequestor", () => {
  test("ascribed unknown:hash actor renders as unattributed agent", () => {
    const d = formatRequestor(ASCRIBED_FIXTURE);
    expect(d.label).toBe("unattributed agent");
    expect(d.isAscribed).toBe(true);
    expect(d.raw).toBe(ASCRIBED_FIXTURE);
  });

  test("ascribed actor with parent task gets task context", () => {
    const d = formatRequestor(ASCRIBED_FIXTURE, "mt#2505");
    expect(d.label).toBe("unattributed agent · mt#2505");
    expect(d.isAscribed).toBe(true);
  });

  test("declared identity passes through unchanged", () => {
    const d = formatRequestor("plan-task-agent", "mt#2505");
    expect(d.label).toBe("plan-task-agent");
    expect(d.isAscribed).toBe(false);
  });

  test("prefixed ascribed form (minsky.agent:unknown:hash:…) is also caught", () => {
    const d = formatRequestor("minsky.agent:unknown:hash:9a8b7c6d5e", "mt#2707");
    expect(d.label).toBe("unattributed agent · mt#2707");
    expect(d.isAscribed).toBe(true);
  });

  test("terminal-unknown form (minsky.agent:unknown, live audit) is caught", () => {
    const d = formatRequestor("minsky.agent:unknown", "mt#2707");
    expect(d.label).toBe("unattributed agent · mt#2707");
    expect(d.isAscribed).toBe(true);
  });

  test("an identity merely containing the word unknown is NOT ascribed", () => {
    const d = formatRequestor("unknown-issues-triage-agent");
    expect(d.isAscribed).toBe(false);
    expect(d.label).toBe("unknown-issues-triage-agent");
  });
});

describe("formatRequestorOption", () => {
  test("ascribed actors stay distinguishable in filter options", () => {
    expect(formatRequestorOption(ASCRIBED_FIXTURE)).toBe("unattributed (f5a2b3c4)");
  });

  test("prefixed ascribed form extracts the hash after the marker", () => {
    expect(formatRequestorOption("minsky.agent:unknown:hash:9a8b7c6d5e")).toBe(
      "unattributed (9a8b7c6d)"
    );
  });

  test("terminal-unknown form disambiguates by issuing prefix", () => {
    expect(formatRequestorOption("minsky.agent:unknown")).toBe("unattributed (minsky.agent)");
  });

  test("declared identity passes through", () => {
    expect(formatRequestorOption("minsky-reviewer[bot]")).toBe("minsky-reviewer[bot]");
  });
});

describe("resolveTabLabel", () => {
  const sources: LabelSources = {
    tasks: [{ id: "mt#2883", title: TASK_TITLE_FIXTURE, status: "IN-PROGRESS" }],
    agentRows: [
      { sessionId: "a10e3905-cc67", taskId: "mt#2883", taskTitle: TASK_TITLE_FIXTURE },
      { sessionId: "b20f4a16-dd78", taskId: "mt#42", taskTitle: null },
    ],
    conversationRows: [{ agentSessionId: "4b019e33-0b84", label: "product-thinking research" }],
    askRows: [{ id: "6807fb14", title: "Grant checks:write to the reviewer App" }],
    memoryRows: [{ id: "92050c7b", name: "Cockpit product pass direction" }],
    changesetRows: [{ number: 1985, title: "product-thinking skill" }],
  };

  test("task tab: anchor + title", () => {
    const r = resolveTabLabel({ kind: "task", entityId: "mt#2883", label: "mt#2883" }, sources);
    expect(r.primary).toBe(`mt#2883 · ${TASK_TITLE_FIXTURE}`);
    expect(r.enriched).toBe(true);
  });

  test("agent tab: bound task title wins", () => {
    const r = resolveTabLabel(
      { kind: "agent", entityId: "a10e3905-cc67", label: "a10e3905" },
      sources
    );
    expect(r.primary).toBe(TASK_TITLE_FIXTURE);
  });

  test("agent tab: falls to task id when no title", () => {
    const r = resolveTabLabel(
      { kind: "agent", entityId: "b20f4a16-dd78", label: "b20f4a16" },
      sources
    );
    expect(r.primary).toBe("mt#42");
  });

  test("conversation (session-kind) tab: ladder label", () => {
    const r = resolveTabLabel(
      { kind: "session", entityId: "4b019e33-0b84", label: "4b019e33" },
      sources
    );
    expect(r.primary).toBe("product-thinking research");
  });

  test("ask tab: subject", () => {
    const r = resolveTabLabel({ kind: "ask", entityId: "6807fb14", label: "6807fb14" }, sources);
    expect(r.primary).toBe("Grant checks:write to the reviewer App");
  });

  test("memory tab: name", () => {
    const r = resolveTabLabel({ kind: "memory", entityId: "92050c7b", label: "92050c7b" }, sources);
    expect(r.primary).toBe("Cockpit product pass direction");
  });

  test("changeset tab: PR anchor + title", () => {
    const r = resolveTabLabel({ kind: "changeset", entityId: "1985", label: "1985" }, sources);
    expect(r.primary).toBe("#1985 · product-thinking skill");
  });

  test("unknown entity falls back to the existing label, unenriched", () => {
    const r = resolveTabLabel(
      { kind: "task", entityId: "mt#9999", label: "mt#9999" },
      EMPTY_LABEL_SOURCES
    );
    expect(r.primary).toBe("mt#9999");
    expect(r.enriched).toBe(false);
  });

  test("empty sources: every kind degrades to fallback", () => {
    for (const kind of ["task", "agent", "session", "ask", "memory", "changeset"] as const) {
      const r = resolveTabLabel({ kind, entityId: "x-1", label: "x-1" }, EMPTY_LABEL_SOURCES);
      expect(r.primary).toBe("x-1");
      expect(r.enriched).toBe(false);
    }
  });
});
