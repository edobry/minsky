/**
 * Tests for session-film-target-ref.ts (mt#3226 SC 2 / AT 3).
 */
import { describe, test, expect } from "bun:test";
import type { EventRealm } from "@minsky/domain/transcripts/event-schema";
import { parseRoutableTarget, targetDisplayLabel } from "./session-film-target-ref";

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

  test("an unrecognized shape falls back to the raw id", () => {
    expect(targetDisplayLabel({ realm: "agents", id: "agents:implementer" })).toBe("implementer");
  });
});
