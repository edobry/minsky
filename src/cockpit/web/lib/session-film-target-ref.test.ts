/**
 * Tests for session-film-target-ref.ts (mt#3226 SC 2 / AT 3).
 */
import { describe, test, expect } from "bun:test";
import type { EventRealm } from "@minsky/domain/transcripts/event-schema";
import {
  deriveFilmSubjectAgentId,
  isSelfReferenceTarget,
  isUnknownRealmTarget,
  parseRoutableTarget,
  resolveTargetDestination,
  targetDisplayLabel,
} from "./session-film-target-ref";

const SUBSTRATE_REALM: EventRealm = "minsky-substrate";

/** Shorthand for a minsky-substrate target fixture — avoids repeating the realm literal per test. */
function substrate(id: string) {
  return { realm: SUBSTRATE_REALM, id };
}

describe("parseRoutableTarget", () => {
  test("a minsky:task:<id> target resolves to a routable task ref", () => {
    expect(parseRoutableTarget(substrate("minsky:task:mt#1772"))).toEqual({
      type: "task",
      id: "mt#1772",
    });
  });

  test("a minsky:memory:<id> target resolves to a routable memory ref", () => {
    expect(parseRoutableTarget(substrate("minsky:memory:bd38be2c-1234"))).toEqual({
      type: "memory",
      id: "bd38be2c-1234",
    });
  });

  test("a minsky:ask:<id> target resolves to a routable ask ref", () => {
    expect(parseRoutableTarget(substrate("minsky:ask:abcd-1234"))).toEqual({
      type: "ask",
      id: "abcd-1234",
    });
  });

  test("a minsky:changeset:<n> target resolves to a routable changeset ref", () => {
    expect(parseRoutableTarget(substrate("minsky:changeset:2269"))).toEqual({
      type: "changeset",
      id: "2269",
    });
  });

  test("a minsky:workspace:<id> target resolves to the session RoutableEntityType", () => {
    expect(parseRoutableTarget(substrate("minsky:workspace:577bbf25-90e5"))).toEqual({
      type: "session",
      id: "577bbf25-90e5",
    });
  });

  test("a non-minsky-substrate realm never resolves, even with a similarly-shaped id", () => {
    expect(parseRoutableTarget({ realm: "repo", id: "minsky:task:mt#1772" })).toBeNull();
  });

  test("the adapter's 'unknown' ref placeholder does not resolve", () => {
    expect(parseRoutableTarget(substrate("minsky:task:unknown"))).toBeNull();
  });

  test("an unrecognized entity kind does not resolve", () => {
    expect(parseRoutableTarget(substrate("minsky:mystery:abc"))).toBeNull();
  });
});

describe("targetDisplayLabel", () => {
  test("a repo file target shows the path, not the realm-prefixed synthetic id", () => {
    expect(
      targetDisplayLabel({ realm: "repo", id: "file:/Users/foo/workspace:src/cockpit/web/App.tsx" })
    ).toBe("src/cockpit/web/App.tsx");
  });

  test("a web target shows the domain", () => {
    expect(targetDisplayLabel({ realm: "web", id: "web:example.com" })).toBe("example.com");
  });

  test("a shell target shows the command digest", () => {
    expect(targetDisplayLabel({ realm: "shell", id: "shell:git status" })).toBe("git status");
  });

  test("a recognized agents-realm target strips the 'agents:' prefix", () => {
    expect(targetDisplayLabel({ realm: "agents", id: "agents:implementer" })).toBe("implementer");
  });

  test("an unknown-realm target NEVER surfaces the literal 'unknown:' prefix (mt#3258 SC 3)", () => {
    // Coordinator's live-DOM finding: "unknown:Skill" / "unknown:tasks_children"
    // rendered VERBATIM on the ribbon — the adapter's total-fallback shape
    // (`${realm}:${toolName}`) leaked straight through because "unknown:" was
    // not in the stripped-prefix list. Fixed: strip it like every other
    // recognized prefix, degrading to the bare tool name.
    const target = { realm: "unknown" as const, id: "unknown:Skill" };
    expect(targetDisplayLabel(target)).toBe("Skill");
    expect(targetDisplayLabel(target)).not.toContain("unknown");
  });

  test("an unknown-realm target with an unprefixed id still never contains 'unknown:' after display", () => {
    const target = { realm: "unknown" as const, id: "unknown:tasks_children" };
    expect(targetDisplayLabel(target)).toBe("tasks_children");
  });
});

describe("isUnknownRealmTarget (mt#3258 SC 3)", () => {
  test("true only for the unknown realm", () => {
    expect(isUnknownRealmTarget({ realm: "unknown", id: "unknown:Skill" })).toBe(true);
    expect(isUnknownRealmTarget({ realm: "repo", id: "file:ws:a.ts" })).toBe(false);
  });
});

describe("deriveFilmSubjectAgentId / isSelfReferenceTarget (mt#3231 SC 1 / AT 1)", () => {
  test("a think event targeting the SAME actor's own agents:<id> reveals the subject id", () => {
    const events = [
      {
        actor: { kind: "agent", agentSessionId: "a3f9c21b" },
        target: { realm: "agents" as const, id: "agents:a3f9c21b" },
      },
    ];
    expect(deriveFilmSubjectAgentId(events)).toBe("agents:a3f9c21b");
  });

  test("a real tool-call event (target != actor's own id) does not, by itself, reveal a subject id", () => {
    const events = [
      {
        actor: { kind: "agent", agentSessionId: "a1" },
        target: { realm: "repo" as const, id: "file:ws:a.ts" },
      },
    ];
    expect(deriveFilmSubjectAgentId(events)).toBeNull();
  });

  test("a spawn target (agents:<kind>, e.g. agents:Explore) is NOT mistaken for a self-reference", () => {
    const events = [
      {
        actor: { kind: "agent", agentSessionId: "a1" },
        target: { realm: "agents" as const, id: "agents:Explore" },
      },
    ];
    expect(deriveFilmSubjectAgentId(events)).toBeNull();
  });

  test("returns the FIRST self-targeting id found, deterministically", () => {
    const events = [
      {
        actor: { kind: "agent", agentSessionId: "a1" },
        target: { realm: "repo" as const, id: "file:ws:a.ts" },
      },
      {
        actor: { kind: "agent", agentSessionId: "a1" },
        target: { realm: "agents" as const, id: "agents:a1" },
      },
      {
        actor: { kind: "agent", agentSessionId: "a1" },
        target: { realm: "agents" as const, id: "agents:a1" },
      },
    ];
    expect(deriveFilmSubjectAgentId(events)).toBe("agents:a1");
  });

  test("a namespaced self-target (agents:<tenant>:<id>) is caught by the defensive suffix fallback (mt#3231 review R1, non-blocking #7)", () => {
    const events = [
      {
        actor: { kind: "agent", agentSessionId: "a1" },
        target: { realm: "agents" as const, id: "agents:tenant:a1" },
      },
    ];
    expect(deriveFilmSubjectAgentId(events)).toBe("agents:tenant:a1");
  });

  test("the suffix fallback does not false-positive on an unrelated id that merely contains the session id as a fragment", () => {
    const events = [
      {
        actor: { kind: "agent", agentSessionId: "1" },
        target: { realm: "agents" as const, id: "agents:Explore1" },
      },
    ];
    expect(deriveFilmSubjectAgentId(events)).toBeNull();
  });

  test("isSelfReferenceTarget is true only when both the realm and id match the derived subject id", () => {
    expect(isSelfReferenceTarget({ realm: "agents", id: "agents:a1" }, "agents:a1")).toBe(true);
    expect(isSelfReferenceTarget({ realm: "agents", id: "agents:Explore" }, "agents:a1")).toBe(
      false
    );
    expect(isSelfReferenceTarget({ realm: "repo", id: "agents:a1" }, "agents:a1")).toBe(false);
    expect(isSelfReferenceTarget({ realm: "agents", id: "agents:a1" }, null)).toBe(false);
  });
});

describe("resolveTargetDestination (mt#3793)", () => {
  test("a routable substrate target resolves to its entity destination", () => {
    expect(
      resolveTargetDestination({ realm: SUBSTRATE_REALM, id: "minsky:task:mt#3793" }, null)
    ).toEqual({ kind: "entity", type: "task", id: "mt#3793" });
  });

  test("the film's own subject resolves to self, not to a link", () => {
    expect(resolveTargetDestination({ realm: "agents", id: "agents:a1" }, "agents:a1")).toEqual({
      kind: "self",
    });
  });

  test("every non-routable realm resolves to a NAMED no-page destination", () => {
    // The point of `none` carrying a className: the panel says what the thing
    // IS. A bare "no link" is what the old panel already did by rendering
    // nothing, and it reads as a missing feature rather than an answer.
    const cases: [{ realm: EventRealm; id: string }, string][] = [
      [{ realm: "repo", id: "file:workspace:src/foo.ts" }, "repo file"],
      [{ realm: "web", id: "web:example.com" }, "web domain"],
      [{ realm: "notion", id: "notion:page-123" }, "Notion page"],
      [{ realm: "shell", id: "shell:git status" }, "shell command"],
      [{ realm: "unknown", id: "unknown:SomeTool" }, "unrecognized tool"],
    ];
    for (const [target, expected] of cases) {
      expect(resolveTargetDestination(target, null)).toEqual({
        kind: "none",
        className: expected,
      });
    }
  });

  test("a spawn target is a subagent KIND with no page — not a conversation link", () => {
    // Pins the finding that shaped this: `agentSpawnTargetExtractor` builds the
    // target from the tool INPUT's `subagent_type`, so `agents:Explore` names an
    // agent TYPE. There is no child session id here to link to, and claiming
    // otherwise would produce a link to a conversation that does not exist.
    expect(
      resolveTargetDestination({ realm: "agents", id: "agents:Explore" }, "agents:a1")
    ).toEqual({ kind: "none", className: "subagent kind" });
  });

  test("a skill target is named as a skill", () => {
    expect(
      resolveTargetDestination({ realm: "agents", id: "agents:skill:plan-task" }, "agents:a1")
    ).toEqual({ kind: "none", className: "skill" });
  });

  test("a substrate target the routable map rejects still gets a destination, not a null", () => {
    // Totality is the property that lets the panel render unconditionally.
    expect(
      resolveTargetDestination({ realm: SUBSTRATE_REALM, id: "minsky:task:unknown" }, null)
    ).toEqual({ kind: "none", className: "Minsky entity with no page" });
  });
});
