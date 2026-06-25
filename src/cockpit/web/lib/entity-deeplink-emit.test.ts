/**
 * Surface A (terminal) deeplink emit-format tests (mt#2519).
 *
 * The agent emits clickable markdown deeplinks `[label](minsky://type/id)` by hand —
 * there is no harness hook that rewrites assistant output, so the format is agent
 * discipline documented in `.minsky/rules/cockpit-deeplinks.mdc`. These tests pin the
 * exact markdown form the rule documents to mt#2518's codec output, so the rule's
 * documented format and the codec (which the cockpit linkifier + the tray scheme handler
 * parse) cannot silently drift apart.
 *
 * Maps to mt#2519 acceptance tests:
 *   - `[mt#2370](minsky://task/mt%232370)` for a task ref (label = clean ref, target = URI)
 *   - one form per entity type, # percent-encoded, round-trips via parseMinskyUri
 *   - no host/port (`localhost` / `http://`) ever appears in an emitted link
 *
 * @see .minsky/rules/cockpit-deeplinks.mdc — the rule this format implements
 * @see entity-codec.ts — entityToMinskyUri / parseMinskyUri (the shared codec, mt#2518)
 */
import { describe, test, expect } from "bun:test";
import { entityToMinskyUri, parseMinskyUri, type RoutableEntityType } from "./entity-codec";

/**
 * Build a Surface-A deeplink exactly as `cockpit-deeplinks.mdc` documents it:
 * `[<clean label>](<minsky:// URI>)`. The URI is the shared codec's output (reused, not
 * reimplemented); the label is the clean human-readable ref.
 */
function deeplink(label: string, type: RoutableEntityType, id: string): string {
  return `[${label}](${entityToMinskyUri(type, id)})`;
}

/** Extract the URL from a single `[label](url)` markdown link. */
function linkTarget(markdown: string): string | null {
  const match = markdown.match(/\]\(([^)]+)\)/);
  return match ? match[1] : null;
}

// Shared fixture ids (mirror entity-codec.test.ts).
const ASK_ID = "0a1b2c3d-0000-0000-0000-000000000000";
const SESSION_ID = "4d44d12b-58f0-433e-95b3-8b914693fa39";
const MEMORY_ID = "bd38be2c-1234-5678-9abc-def000000000";

describe("Surface A deeplink emit format", () => {
  test("task ref produces the canonical [label](minsky://task/...) form with %23 encoding", () => {
    // The mt#2519 acceptance-test literal: label keeps the clean `mt#2370`,
    // the target percent-encodes the `#` as `%23`.
    expect(deeplink("mt#2370", "task", "mt#2370")).toBe("[mt#2370](minsky://task/mt%232370)");
  });

  test("ask ref", () => {
    expect(deeplink("38b1c0de", "ask", ASK_ID)).toBe(`[38b1c0de](minsky://ask/${ASK_ID})`);
  });

  test("session ref uses the `session` URI type (not `agent`)", () => {
    expect(deeplink("sess-4d44", "session", SESSION_ID)).toBe(
      `[sess-4d44](minsky://session/${SESSION_ID})`
    );
  });

  test("memory ref", () => {
    expect(deeplink("push-not-pull", "memory", MEMORY_ID)).toBe(
      `[push-not-pull](minsky://memory/${MEMORY_ID})`
    );
  });

  test("changeset ref uses PR number as id", () => {
    expect(deeplink("PR #1234", "changeset", "1234")).toBe("[PR #1234](minsky://changeset/1234)");
  });
});

describe("emitted link target round-trips through the codec", () => {
  const cases: Array<{ type: RoutableEntityType; id: string }> = [
    { type: "task", id: "mt#2370" },
    { type: "ask", id: ASK_ID },
    { type: "session", id: SESSION_ID },
    { type: "memory", id: MEMORY_ID },
    { type: "changeset", id: "1234" },
  ];

  for (const { type, id } of cases) {
    test(`${type} link target parses back to {type, id}`, () => {
      const target = linkTarget(deeplink("label", type, id));
      expect(target).not.toBeNull();
      const parsed = parseMinskyUri(target as string);
      expect(parsed?.type).toBe(type);
      expect(parsed?.id).toBe(id);
    });
  }
});

describe("no host/port in emitted links", () => {
  const cases: Array<{ type: RoutableEntityType; id: string }> = [
    { type: "task", id: "mt#2370" },
    { type: "ask", id: ASK_ID },
    { type: "session", id: SESSION_ID },
    { type: "memory", id: MEMORY_ID },
    { type: "changeset", id: "1234" },
  ];

  for (const { type, id } of cases) {
    test(`${type} link contains no localhost / http://`, () => {
      const link = deeplink("label", type, id);
      expect(link).not.toContain("localhost");
      expect(link).not.toContain("http://");
      expect(link).not.toContain("https://");
      expect(link).toContain("minsky://");
    });
  }
});

describe("changeset (PR) refs are routable (mt#2536)", () => {
  // As of mt#2536, the "changeset" entity type IS part of RoutableEntityType.
  // minsky://changeset/<prNumber> is a valid emittable URI that navigates to
  // /changeset/<prNumber> in the cockpit (the route added in mt#2535).
  test("changeset link form is canonical [PR #N](minsky://changeset/N)", () => {
    expect(deeplink("PR #1234", "changeset", "1234")).toBe("[PR #1234](minsky://changeset/1234)");
  });

  test("changeset URI parses to {type:'changeset', id:'1234'}", () => {
    expect(parseMinskyUri("minsky://changeset/1234")).toEqual({
      type: "changeset",
      id: "1234",
    });
  });

  test("minsky://pr/... (wrong type) still does not parse to a routable entity", () => {
    // The canonical URI type is "changeset", not "pr"
    expect(parseMinskyUri("minsky://pr/1234")).toBeNull();
  });
});

describe("emit form is markdown-safe (label + URL closing)", () => {
  const cases: Array<{ type: RoutableEntityType; id: string }> = [
    { type: "task", id: "mt#2370" },
    { type: "ask", id: ASK_ID },
    { type: "session", id: SESSION_ID },
    { type: "memory", id: MEMORY_ID },
    { type: "changeset", id: "1234" },
  ];

  for (const { type, id } of cases) {
    test(`${type} URI contains no ) or ] so the [label](url) close is unambiguous`, () => {
      // linkTarget()'s /\]\(([^)]+)\)/ regex (and any markdown renderer) closes the
      // link at the first ")". The codec percent-encodes the id, and real id shapes
      // (mt#NNNN, UUIDs) contain no parens/brackets, so the URL side is always safe.
      const uri = entityToMinskyUri(type, id);
      expect(uri).not.toContain(")");
      expect(uri).not.toContain("]");
    });
  }

  test("a clean label yields exactly one extractable, balanced link", () => {
    // Clean labels (the rule's requirement: no ] ( ) metacharacters) keep the
    // markdown link parseable — linkTarget extracts the full URL intact.
    const link = deeplink("mt#2370", "task", "mt#2370");
    expect(link).toBe("[mt#2370](minsky://task/mt%232370)");
    expect(linkTarget(link)).toBe("minsky://task/mt%232370");
  });
});
