/**
 * Tests for per-family tool icon selection (mt#2790).
 */
import { describe, test, expect } from "bun:test";
import {
  Terminal,
  FileText,
  GitBranch,
  ListTodo,
  BrainCircuit,
  Bot,
  Plug,
  Wrench,
  Search,
  Clock,
  MessageCircle,
  Layers,
  User,
  ShieldAlert,
} from "lucide-react";
import type { EventVerb } from "@minsky/domain/transcripts/event-schema";
import { EVENT_VERBS } from "@minsky/domain/transcripts/event-schema";
import {
  actorIconFor,
  BATCH_ROW_ICON,
  BATCH_ROW_LABEL,
  toolIconFor,
  verbIconFor,
  verbLabelFor,
} from "./tool-icon";
import { parseToolName } from "./tool-name";

describe("toolIconFor", () => {
  test("shell tools (Bash, session_exec) get the Terminal icon", () => {
    expect(toolIconFor(parseToolName("Bash"))).toBe(Terminal);
    expect(toolIconFor(parseToolName("session_exec"))).toBe(Terminal);
  });

  test("file-op tools get the FileText icon", () => {
    expect(toolIconFor(parseToolName("Read"))).toBe(FileText);
    expect(toolIconFor(parseToolName("Edit"))).toBe(FileText);
    expect(toolIconFor(parseToolName("Write"))).toBe(FileText);
    expect(toolIconFor(parseToolName("mcp__minsky__session_read_file"))).toBe(FileText);
  });

  test("git_* tools get the GitBranch icon", () => {
    expect(toolIconFor(parseToolName("mcp__minsky__git_log"))).toBe(GitBranch);
    expect(toolIconFor(parseToolName("git_diff"))).toBe(GitBranch);
  });

  test("tasks_* tools get the ListTodo icon", () => {
    expect(toolIconFor(parseToolName("mcp__minsky__tasks_search"))).toBe(ListTodo);
  });

  test("memory_* tools get the BrainCircuit icon", () => {
    expect(toolIconFor(parseToolName("mcp__minsky__memory_search"))).toBe(BrainCircuit);
  });

  test("Agent (subagent spawn) gets the Bot icon", () => {
    expect(toolIconFor(parseToolName("Agent"))).toBe(Bot);
  });

  test("an unrecognized MCP tool gets the generic Plug icon", () => {
    expect(toolIconFor(parseToolName("mcp__github__list_pull_requests"))).toBe(Plug);
  });

  test("an unrecognized native tool gets the generic Wrench icon", () => {
    expect(toolIconFor(parseToolName("WebFetch"))).toBe(Wrench);
  });
});

describe("verbIconFor (mt#3226 SC 2 — session-film glyphic ribbon)", () => {
  test("read/search verbs get the Search icon", () => {
    expect(verbIconFor("read")).toBe(Search);
    expect(verbIconFor("search")).toBe(Search);
  });

  test("write/create/delete verbs get the FileText icon", () => {
    expect(verbIconFor("write")).toBe(FileText);
    expect(verbIconFor("create")).toBe(FileText);
    expect(verbIconFor("delete")).toBe(FileText);
  });

  test("clone gets the GitBranch icon", () => {
    expect(verbIconFor("clone")).toBe(GitBranch);
  });

  test("execute gets the Terminal icon", () => {
    expect(verbIconFor("execute")).toBe(Terminal);
  });

  test("spawn gets the Bot icon", () => {
    expect(verbIconFor("spawn")).toBe(Bot);
  });

  test("wait gets the Clock icon", () => {
    expect(verbIconFor("wait")).toBe(Clock);
  });

  test("speak/respond/ask get the MessageCircle icon", () => {
    expect(verbIconFor("speak")).toBe(MessageCircle);
    expect(verbIconFor("respond")).toBe(MessageCircle);
    expect(verbIconFor("ask")).toBe(MessageCircle);
  });

  test("think gets the BrainCircuit icon", () => {
    expect(verbIconFor("think")).toBe(BrainCircuit);
  });
});

describe("BATCH_ROW_ICON / actorIconFor (mt#3226 SC 2)", () => {
  test("BATCH_ROW_ICON is the Layers icon", () => {
    expect(BATCH_ROW_ICON).toBe(Layers);
  });

  test("BATCH_ROW_ICON is distinct from EVERY verb's icon in the real registry (PR #2323 R1)", () => {
    // Iterates the actual verb vocabulary (EVENT_VERBS, the schema's own
    // list) through the REAL verbIconFor mapping — not a hardcoded subset —
    // so this genuinely fails if a future verb is ever mapped to Layers.
    for (const verb of EVENT_VERBS as readonly EventVerb[]) {
      expect(verbIconFor(verb)).not.toBe(BATCH_ROW_ICON);
    }
  });

  test("actorIconFor maps principal/policy/agent to distinct icons", () => {
    expect(actorIconFor("principal")).toBe(User);
    expect(actorIconFor("policy")).toBe(ShieldAlert);
    expect(actorIconFor("agent")).toBe(Bot);
  });
});

describe("verbLabelFor / BATCH_ROW_LABEL (mt#3231 SC 2 / AT 2 — icon text-label badges)", () => {
  test("every verb in the real vocabulary (EVENT_VERBS) gets a non-empty human label", () => {
    for (const verb of EVENT_VERBS as readonly EventVerb[]) {
      const label = verbLabelFor(verb);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });

  test("a sample of verbs get the expected human-readable word (not the raw verb string)", () => {
    expect(verbLabelFor("read")).toBe("Read");
    expect(verbLabelFor("write")).toBe("Write");
    expect(verbLabelFor("search")).toBe("Search");
    expect(verbLabelFor("think")).toBe("Think");
    expect(verbLabelFor("wait")).toBe("Wait");
    expect(verbLabelFor("spawn")).toBe("Spawn");
    expect(verbLabelFor("ask")).toBe("Ask");
  });

  test("every verb's label is distinct — no two verbs collapse to the same word (even where icons collide, e.g. read/search)", () => {
    const labels = (EVENT_VERBS as readonly EventVerb[]).map(verbLabelFor);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("BATCH_ROW_LABEL is distinct from every verb's label", () => {
    for (const verb of EVENT_VERBS as readonly EventVerb[]) {
      expect(verbLabelFor(verb)).not.toBe(BATCH_ROW_LABEL);
    }
  });
});
