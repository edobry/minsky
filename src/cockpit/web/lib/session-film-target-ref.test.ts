/**
 * Tests for session-film-target-ref.ts (mt#3226 SC 2 / AT 3).
 */
import { describe, test, expect } from "bun:test";
import type { EventRealm } from "@minsky/domain/transcripts/event-schema";
import {
  deriveFilmSubjectAgentId,
  isSelfReferenceTarget,
  parseRoutableTarget,
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

  test("an unrecognized shape falls back to the raw id VERBATIM (no prefix matches: not repo/file:, not web:/notion:/shell:/agents:)", () => {
    // "unknown:Skill" deliberately matches none of targetDisplayLabel's known
    // prefixes (realm is "unknown", not "repo"; id doesn't start with
    // "web:"/"notion:"/"shell:"/"agents:") — the PREVIOUS version of this
    // test used {realm:"agents", id:"agents:implementer"}, which actually
    // exercises the RECOGNIZED "agents:" prefix-strip path (asserted above
    // as its own test), not the fallback (PR #2323 R1: same class of bug as
    // the BATCH_ROW_ICON test — the name claimed "unrecognized," the fixture
    // was recognized).
    const target = { realm: "unknown" as const, id: "unknown:Skill" };
    expect(targetDisplayLabel(target)).toBe(target.id);
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
