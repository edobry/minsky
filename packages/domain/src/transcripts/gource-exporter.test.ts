/**
 * Tests for the Gource custom-log exporter (mt#3157).
 */

import { describe, expect, test } from "bun:test";
import {
  eventsToGourceLines,
  formatGourceLog,
  exportGourceLog,
  assertScrubGate,
  UnscrubbedSessionError,
  CREDENTIAL_SCRUB_CUTOFF_ISO,
} from "./gource-exporter";
import { EVENT_SCHEMA_VERSION, type SemanticEvent } from "./event-schema";

/** Realm literal reused across fixtures (avoids magic-string duplication). */
const MINSKY_SUBSTRATE_REALM = "minsky-substrate";

function event(overrides: Partial<SemanticEvent>): SemanticEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    tStart: "2026-07-24T10:00:00.000Z",
    actor: { kind: "agent", agentSessionId: "agent-1" },
    verb: "read",
    target: { realm: "repo", id: "file:workspace:src/a.ts" },
    outcome: "ok",
    adapterVersion: "test",
    ...overrides,
  };
}

describe("eventsToGourceLines — AT4: path-bearing verbs only, no query strings", () => {
  test("excludes non-path-bearing verbs (execute, spawn, speak, think, ask, respond, wait)", () => {
    const events: SemanticEvent[] = [
      event({ verb: "read", target: { realm: "repo", id: "file:workspace:src/a.ts" } }),
      event({ verb: "execute", target: { realm: "shell", id: "shell:echo hi" } }),
      event({ verb: "spawn", target: { realm: "agents", id: "agents:Explore" } }),
      event({ verb: "speak", target: { realm: "agents", id: "agents:agent-1" } }),
      event({ verb: "think", target: { realm: "agents", id: "agents:agent-1" } }),
      event({ verb: "ask", target: { realm: "agents", id: "agents:agent-1" } }),
      event({ verb: "respond", target: { realm: MINSKY_SUBSTRATE_REALM, id: "minsky:ask:1" } }),
      event({ verb: "wait", target: { realm: MINSKY_SUBSTRATE_REALM, id: "minsky:ask:1" } }),
    ];

    const lines = eventsToGourceLines(events);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.path).toBe("src/a.ts");
    expect(lines[0]?.action).toBe("M");
  });

  test("strips query strings from web-realm targets", () => {
    const events: SemanticEvent[] = [
      event({
        verb: "read",
        target: { realm: "web", id: "web:example.com?token=secret&utm_source=x" },
      }),
    ];
    const lines = eventsToGourceLines(events);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.path).toBe("example.com");
    expect(lines[0]?.path).not.toContain("?");
    expect(lines[0]?.path).not.toContain("token");
  });

  test("write/create is A on first touch of a path, M thereafter", () => {
    const events: SemanticEvent[] = [
      event({
        verb: "create",
        tStart: "2026-07-24T10:00:00.000Z",
        target: { realm: "repo", id: "file:workspace:new.ts" },
      }),
      event({
        verb: "write",
        tStart: "2026-07-24T10:00:05.000Z",
        target: { realm: "repo", id: "file:workspace:new.ts" },
      }),
    ];
    const lines = eventsToGourceLines(events);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.action).toBe("A");
    expect(lines[1]?.action).toBe("M");
  });

  test("delete maps to D, clone maps to a synthetic directory-grain A", () => {
    const events: SemanticEvent[] = [
      event({ verb: "delete", target: { realm: "repo", id: "file:workspace:gone.ts" } }),
      event({
        verb: "clone",
        target: { realm: "minsky-substrate", id: "minsky:workspace:mt#3157" },
      }),
    ];
    const lines = eventsToGourceLines(events);
    expect(lines.find((l) => l.path === "gone.ts")?.action).toBe("D");
    expect(lines.find((l) => l.path === "workspace/mt#3157")?.action).toBe("A");
  });

  test("formatGourceLog produces pipe-delimited lines sorted by timestamp", () => {
    const events: SemanticEvent[] = [
      event({
        verb: "read",
        tStart: "2026-07-24T10:00:05.000Z",
        target: { realm: "repo", id: "file:workspace:b.ts" },
      }),
      event({
        verb: "read",
        tStart: "2026-07-24T10:00:00.000Z",
        target: { realm: "repo", id: "file:workspace:a.ts" },
      }),
    ];
    const lines = eventsToGourceLines(events);
    const text = formatGourceLog(lines);
    const rows = text.trim().split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("a.ts");
    expect(rows[1]).toContain("b.ts");
    for (const row of rows) {
      const parts = row.split("|");
      expect(parts).toHaveLength(4);
    }
  });
});

describe("assertScrubGate / exportGourceLog — credential-scrub gate", () => {
  test("refuses a session ingested before the cutoff", () => {
    expect(() => assertScrubGate("2026-06-01T00:00:00.000Z")).toThrow(UnscrubbedSessionError);
  });

  test("allows a session ingested on/after the cutoff", () => {
    expect(() => assertScrubGate(CREDENTIAL_SCRUB_CUTOFF_ISO)).not.toThrow();
    expect(() => assertScrubGate("2026-07-19T00:00:00.000Z")).not.toThrow();
  });

  test("refuses a null ingestedAt without verifiedRescrubbed", () => {
    expect(() => assertScrubGate(null)).toThrow(UnscrubbedSessionError);
  });

  test("verifiedRescrubbed overrides a pre-cutoff ingestedAt", () => {
    expect(() => assertScrubGate("2026-01-01T00:00:00.000Z", true)).not.toThrow();
  });

  test("exportGourceLog throws for a pre-cutoff session and produces output for a post-cutoff one", () => {
    const events: SemanticEvent[] = [event({ verb: "read" })];
    expect(() => exportGourceLog(events, { ingestedAt: "2026-06-01T00:00:00.000Z" })).toThrow(
      UnscrubbedSessionError
    );

    const output = exportGourceLog(events, { ingestedAt: "2026-07-20T00:00:00.000Z" });
    expect(output).toContain("src/a.ts");
  });
});
