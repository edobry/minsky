/**
 * Tests for the entity codec (mt#2518).
 *
 * Covers:
 *   - entityToPath round-trips with matchEntityRoute
 *   - entityToMinskyUri / parseMinskyUri round-trips
 *   - # encoding in task ids
 *   - parseMinskyUri rejects non-minsky URIs and unknown types
 */
import { describe, test, expect } from "bun:test";
import { entityToPath, entityToMinskyUri, parseMinskyUri, minskyUriToPath } from "./entity-codec";
import { matchEntityRoute } from "./tabs";
import { tokenEntity } from "./entity-linkifier";

// Shared fixture ids
const ASK_ID = "0a1b2c3d-0000-0000-0000-000000000000";
const SESSION_ID = "4d44d12b-58f0-433e-95b3-8b914693fa39";
const TASK_URI = "minsky://task/mt%232370";
const TASK_PATH = "/tasks/mt%232370";

describe("entityToPath", () => {
  test("task id with # is percent-encoded", () => {
    expect(entityToPath("task", "mt#2370")).toBe(TASK_PATH);
  });

  test("ask id produces /ask/:id", () => {
    expect(entityToPath("ask", ASK_ID)).toBe("/ask/0a1b2c3d-0000-0000-0000-000000000000");
  });

  test("memory id produces /memory/:id", () => {
    expect(entityToPath("memory", "d4e5f6a7-0000-0000-0000-000000000000")).toBe(
      "/memory/d4e5f6a7-0000-0000-0000-000000000000"
    );
  });

  test("session id produces /agents/:id", () => {
    expect(entityToPath("session", SESSION_ID)).toBe(
      "/agents/4d44d12b-58f0-433e-95b3-8b914693fa39"
    );
  });

  test("changeset id produces /changeset/:id", () => {
    expect(entityToPath("changeset", "1234")).toBe("/changeset/1234");
  });
});

describe("entityToPath + matchEntityRoute round-trip", () => {
  test("task round-trip", () => {
    const path = entityToPath("task", "mt#2370");
    const tab = matchEntityRoute(path);
    expect(tab?.kind).toBe("task");
    expect(tab?.entityId).toBe("mt#2370");
  });

  test("ask round-trip", () => {
    const id = ASK_ID;
    const path = entityToPath("ask", id);
    const tab = matchEntityRoute(path);
    expect(tab?.kind).toBe("ask");
    expect(tab?.entityId).toBe(id);
  });

  test("memory round-trip", () => {
    const id = "d4e5f6a7-0000-0000-0000-000000000000";
    const path = entityToPath("memory", id);
    const tab = matchEntityRoute(path);
    expect(tab?.kind).toBe("memory");
    expect(tab?.entityId).toBe(id);
  });

  test("session round-trip goes through /agents/", () => {
    const id = SESSION_ID;
    const path = entityToPath("session", id);
    // matchEntityRoute maps /agents/:id to kind "agent" (workspace session id-space)
    const tab = matchEntityRoute(path);
    expect(tab?.kind).toBe("agent");
    expect(tab?.entityId).toBe(id);
  });
});

describe("entityToMinskyUri", () => {
  test("task id with # becomes %23 in URI", () => {
    expect(entityToMinskyUri("task", "mt#2370")).toBe("minsky://task/mt%232370");
  });

  test("ask id", () => {
    expect(entityToMinskyUri("ask", ASK_ID)).toBe(
      "minsky://ask/0a1b2c3d-0000-0000-0000-000000000000"
    );
  });

  test("memory id", () => {
    expect(entityToMinskyUri("memory", "bd38be2c-1234-5678-9abc-def000000000")).toBe(
      "minsky://memory/bd38be2c-1234-5678-9abc-def000000000"
    );
  });

  test("session id", () => {
    expect(entityToMinskyUri("session", SESSION_ID)).toBe(
      "minsky://session/4d44d12b-58f0-433e-95b3-8b914693fa39"
    );
  });

  test("changeset id", () => {
    expect(entityToMinskyUri("changeset", "1234")).toBe("minsky://changeset/1234");
  });
});

describe("parseMinskyUri", () => {
  test("round-trips task URI", () => {
    const uri = entityToMinskyUri("task", "mt#2370");
    const parsed = parseMinskyUri(uri);
    expect(parsed?.type).toBe("task");
    expect(parsed?.id).toBe("mt#2370");
  });

  test("round-trips ask URI", () => {
    const id = ASK_ID;
    const uri = entityToMinskyUri("ask", id);
    const parsed = parseMinskyUri(uri);
    expect(parsed?.type).toBe("ask");
    expect(parsed?.id).toBe(id);
  });

  test("round-trips memory URI", () => {
    const id = "bd38be2c-1234-5678-9abc-def000000000";
    const uri = entityToMinskyUri("memory", id);
    const parsed = parseMinskyUri(uri);
    expect(parsed?.type).toBe("memory");
    expect(parsed?.id).toBe(id);
  });

  test("round-trips session URI", () => {
    const id = SESSION_ID;
    const uri = entityToMinskyUri("session", id);
    const parsed = parseMinskyUri(uri);
    expect(parsed?.type).toBe("session");
    expect(parsed?.id).toBe(id);
  });

  test("round-trips changeset URI", () => {
    const uri = entityToMinskyUri("changeset", "1234");
    const parsed = parseMinskyUri(uri);
    expect(parsed?.type).toBe("changeset");
    expect(parsed?.id).toBe("1234");
  });

  test("rejects non-minsky URIs", () => {
    expect(parseMinskyUri("https://example.com")).toBeNull();
    expect(parseMinskyUri("http://localhost:3000/tasks/mt%232370")).toBeNull();
  });

  test("rejects unknown types", () => {
    // "pr" is not a routable type (use "changeset" for PR-number refs)
    expect(parseMinskyUri("minsky://pr/123")).toBeNull();
    // "agent" is not a routable type (use "session" for workspace session ids)
    expect(parseMinskyUri("minsky://agent/abc")).toBeNull();
  });

  test("rejects missing id", () => {
    expect(parseMinskyUri("minsky://task/")).toBeNull();
    expect(parseMinskyUri("minsky://task")).toBeNull();
  });

  test("rejects bare minsky://", () => {
    expect(parseMinskyUri("minsky://")).toBeNull();
  });

  test("decodes % encoding in id", () => {
    // mt%232370 → mt#2370
    const parsed = parseMinskyUri("minsky://task/mt%232370");
    expect(parsed?.id).toBe("mt#2370");
  });
});

describe("minskyUriToPath", () => {
  test("converts task URI to cockpit path", () => {
    expect(minskyUriToPath(TASK_URI)).toBe(TASK_PATH);
  });

  test("converts session URI to /agents/ path", () => {
    const id = SESSION_ID;
    expect(minskyUriToPath(`minsky://session/${id}`)).toBe(`/agents/${id}`);
  });

  test("returns null for invalid URI", () => {
    expect(minskyUriToPath("https://example.com")).toBeNull();
    expect(minskyUriToPath("minsky://pr/123")).toBeNull();
  });

  test("old minsky://session/<uuid> URI still resolves after the ADR-022 stage-1 cockpit rename (mt#2686)", () => {
    // Stored transcripts (pre-dating ADR-022) carry minsky://session/<uuid>
    // links that name the Minsky WORKSPACE sessionId. mt#2686 renamed the
    // cockpit component that serves /agents/:id from SessionDetailPage to
    // WorkspaceDetailPage (and its widget from SessionDetail to
    // WorkspaceDetail), but did NOT rename the "session" URI type or the
    // /agents/:id path — the type->route mapping absorbs the divergence, as
    // it already did pre-rename. A URI minted years ago must still resolve.
    const id = SESSION_ID;
    const uri = entityToMinskyUri("session", id);
    expect(uri).toBe(`minsky://session/${id}`);
    expect(minskyUriToPath(uri)).toBe(`/agents/${id}`);
  });
});

describe("trailing prose-punctuation robustness (mt#2549)", () => {
  // A terminal's URL auto-detection captures the closing ) of a markdown link
  // `[mt#2370](minsky://task/mt%232370)`, so `open` delivers the URI WITH a trailing
  // `)`. Without stripping, the `)` decodes into the id → "Task mt#2370) not found".
  test("strips a trailing ) captured by terminal URL detection", () => {
    expect(parseMinskyUri(`${TASK_URI})`)).toEqual({ type: "task", id: "mt#2370" });
    expect(minskyUriToPath(`${TASK_URI})`)).toBe(TASK_PATH);
  });

  test("strips trailing . , ] ; and runs of them", () => {
    expect(minskyUriToPath(`${TASK_URI}.`)).toBe(TASK_PATH);
    expect(minskyUriToPath(`${TASK_URI},`)).toBe(TASK_PATH);
    expect(minskyUriToPath(`${TASK_URI}]`)).toBe(TASK_PATH);
    expect(minskyUriToPath(`${TASK_URI};`)).toBe(TASK_PATH);
    expect(minskyUriToPath(`${TASK_URI}).`)).toBe(TASK_PATH);
  });

  test("clean URIs are unchanged", () => {
    expect(minskyUriToPath(TASK_URI)).toBe(TASK_PATH);
    expect(parseMinskyUri(TASK_URI)).toEqual({ type: "task", id: "mt#2370" });
  });

  test("strips trailing punct on UUID ids too (session → /agents/)", () => {
    expect(minskyUriToPath(`minsky://session/${SESSION_ID})`)).toBe(`/agents/${SESSION_ID}`);
  });

  test("an id that is ALL trailing punctuation → null", () => {
    expect(parseMinskyUri("minsky://task/)")).toBeNull();
    expect(parseMinskyUri("minsky://task/]")).toBeNull();
  });

  test("strips percent-encoded trailing punctuation (%29 %2E %5D %3B)", () => {
    expect(minskyUriToPath(`${TASK_URI}%29`)).toBe(TASK_PATH); // %29 = )
    expect(minskyUriToPath(`${TASK_URI}%2E`)).toBe(TASK_PATH); // %2E = .
    expect(minskyUriToPath(`${TASK_URI}%5D`)).toBe(TASK_PATH); // %5D = ]
    expect(minskyUriToPath(`${TASK_URI}%3B`)).toBe(TASK_PATH); // %3B = ;
  });

  test("an id that is ALL percent-encoded punctuation → null", () => {
    expect(parseMinskyUri("minsky://task/%29")).toBeNull();
  });

  // PR #2695 R1: the class was missing `:` (and, on the same reasoning, `>` `!` `?`).
  // "see minsky://task/mt%232370: it explains why" decoded to the id `mt#2370:`, which
  // then failed lookup exactly the way the mt#2549 `)` case did.
  test("strips trailing : > ! ? — the rest of the prose-punctuation class", () => {
    expect(minskyUriToPath(`${TASK_URI}:`)).toBe(TASK_PATH);
    expect(minskyUriToPath(`${TASK_URI}>`)).toBe(TASK_PATH); // <autolink> closer
    expect(minskyUriToPath(`${TASK_URI}!`)).toBe(TASK_PATH);
    expect(minskyUriToPath(`${TASK_URI}?`)).toBe(TASK_PATH);
    expect(parseMinskyUri(`${TASK_URI}:`)).toEqual({ type: "task", id: "mt#2370" });
  });

  test("strips the same characters percent-encoded (%3A %3E %21 %3F)", () => {
    expect(minskyUriToPath(`${TASK_URI}%3A`)).toBe(TASK_PATH); // %3A = :
    expect(minskyUriToPath(`${TASK_URI}%3E`)).toBe(TASK_PATH); // %3E = >
    expect(minskyUriToPath(`${TASK_URI}%21`)).toBe(TASK_PATH); // %21 = !
    expect(minskyUriToPath(`${TASK_URI}%3F`)).toBe(TASK_PATH); // %3F = ?
  });

  test("applies to uuid ids on every type, including conversation", () => {
    expect(minskyUriToPath(`minsky://conversation/${SESSION_ID}:`)).toBe(
      `/conversation/${SESSION_ID}`
    );
    expect(minskyUriToPath(`minsky://memory/${SESSION_ID}?`)).toBe(`/memory/${SESSION_ID}`);
    expect(minskyUriToPath(`minsky://changeset/1234:`)).toBe(`/changeset/1234`);
  });
});

describe("conversation entity type (mt#2769 route; mt#3800 made it a minsky:// URI type)", () => {
  const CONVERSATION_ID = "4d44d12b-58f0-433e-95b3-8b914693fa39";

  test("entityToPath produces /conversation/:id", () => {
    expect(entityToPath("conversation", CONVERSATION_ID)).toBe(`/conversation/${CONVERSATION_ID}`);
  });

  test("round-trips through matchEntityRoute (kind stays 'session', mt#2769/mt#2686)", () => {
    const path = entityToPath("conversation", CONVERSATION_ID);
    const tab = matchEntityRoute(path);
    expect(tab?.kind).toBe("session");
    expect(tab?.entityId).toBe(CONVERSATION_ID);
  });

  test("round-trips through the minsky:// URI form (mt#3800)", () => {
    // Until mt#3800 parseMinskyUri deliberately rejected this, so a tray deep-link
    // to a conversation fronted the window without navigating. Accepting it is what
    // lets `/cockpit` hand the tray the conversation the operator is sitting in.
    const uri = entityToMinskyUri("conversation", CONVERSATION_ID);
    expect(uri).toBe(`minsky://conversation/${CONVERSATION_ID}`);
    expect(parseMinskyUri(uri)).toEqual({ type: "conversation", id: CONVERSATION_ID });
    expect(minskyUriToPath(uri)).toBe(`/conversation/${CONVERSATION_ID}`);
  });

  test("accepting it does NOT widen `session`, which still means the workspace id", () => {
    // ADR-022 stage 2 (mt#2527) owns the session_* → workspace_* rename; mt#3800 must
    // not anticipate it. A workspace deeplink still routes to /agents/:id.
    expect(parseMinskyUri(`minsky://session/${CONVERSATION_ID}`)).toEqual({
      type: "session",
      id: CONVERSATION_ID,
    });
    expect(minskyUriToPath(`minsky://session/${CONVERSATION_ID}`)).toBe(
      `/agents/${CONVERSATION_ID}`
    );
  });

  test("an unknown type is still rejected", () => {
    expect(parseMinskyUri(`minsky://conversations/${CONVERSATION_ID}`)).toBeNull();
    expect(parseMinskyUri(`minsky://bogus/${CONVERSATION_ID}`)).toBeNull();
  });
});

describe("changeset id numeric enforcement (mt#2536 R1)", () => {
  // The rule/docs pin `changeset id == PR number` (positive integer). A non-numeric
  // changeset id must NOT parse — it would otherwise route to a nonexistent
  // /changeset/<junk>. Enforcement applies ONLY to the changeset type.
  test("accepts a numeric changeset id", () => {
    expect(parseMinskyUri("minsky://changeset/1234")).toEqual({ type: "changeset", id: "1234" });
  });

  test("rejects a non-numeric changeset id", () => {
    expect(parseMinskyUri("minsky://changeset/abc")).toBeNull();
    expect(parseMinskyUri("minsky://changeset/12ab")).toBeNull();
    expect(parseMinskyUri("minsky://changeset/mt%232370")).toBeNull();
  });

  test("numeric enforcement is changeset-only (other types keep free-form ids)", () => {
    expect(parseMinskyUri("minsky://task/mt%232370")?.id).toBe("mt#2370");
    expect(parseMinskyUri(`minsky://ask/${ASK_ID}`)?.id).toBe(ASK_ID);
  });

  test("trailing-punct strip still yields a valid numeric changeset id", () => {
    // `[PR #1234](minsky://changeset/1234)` → terminal captures the trailing )
    expect(parseMinskyUri("minsky://changeset/1234)")).toEqual({ type: "changeset", id: "1234" });
    expect(minskyUriToPath("minsky://changeset/1234)")).toBe("/changeset/1234");
  });
});

describe("project-qualified changeset ids (mt#4724)", () => {
  // A PR number is unique only per-REPOSITORY — `changeset` is the one routable
  // entity type without a global id-space. The qualified `owner/repo#N` form
  // (mt#1207's convention) names its repo; the bare form still means "the
  // default project's PR N", which is what every already-emitted
  // `minsky://changeset/<n>` link says and what ADR-029 fixes in place.
  const QUALIFIED = "edobry/peezombie.me#1";

  test("a qualified id round-trips through URI and path", () => {
    const uri = entityToMinskyUri("changeset", QUALIFIED);
    expect(uri).toBe("minsky://changeset/edobry%2Fpeezombie.me%231");
    expect(parseMinskyUri(uri)).toEqual({ type: "changeset", id: QUALIFIED });
    expect(entityToPath("changeset", QUALIFIED)).toBe("/changeset/edobry%2Fpeezombie.me%231");
    expect(minskyUriToPath(uri)).toBe("/changeset/edobry%2Fpeezombie.me%231");
  });

  test("the path segment survives matchEntityRoute (the `/` stays encoded)", () => {
    expect(matchEntityRoute(entityToPath("changeset", QUALIFIED))?.entityId).toBe(QUALIFIED);
  });

  test("bare ids are unchanged — every already-emitted link still parses", () => {
    expect(parseMinskyUri("minsky://changeset/3423")).toEqual({ type: "changeset", id: "3423" });
  });

  test("two projects' PR #1 produce DISTINCT URIs", () => {
    expect(entityToMinskyUri("changeset", QUALIFIED)).not.toBe(
      entityToMinskyUri("changeset", "edobry/minsky#1")
    );
  });

  test("still rejects malformed qualified ids", () => {
    expect(parseMinskyUri("minsky://changeset/edobry%2Fpeezombie.me")).toBeNull();
    expect(parseMinskyUri("minsky://changeset/edobry%2Fpeezombie.me%23abc")).toBeNull();
    expect(parseMinskyUri("minsky://changeset/%2Frepo%231")).toBeNull();
  });
});

describe("interceptor type (mt#4010)", () => {
  // The id is a `guardName` — kebab-case, already URL-safe, and NOT a uuid.
  const NAME = "turn-end-bare-ref-scan";

  test("entityToPath produces the plural-noun detail route", () => {
    expect(entityToPath("interceptor", NAME)).toBe(`/interceptors/${NAME}`);
  });

  test("URI round-trips through parseMinskyUri", () => {
    const uri = entityToMinskyUri("interceptor", NAME);
    expect(uri).toBe(`minsky://interceptor/${NAME}`);
    expect(parseMinskyUri(uri)).toEqual({ type: "interceptor", id: NAME });
  });

  test("path round-trips through matchEntityRoute (the REVERSE codec)", () => {
    // The gap the original spec's consumer list missed: without the tabs.tsx
    // branch the forward direction resolves and the round-trip silently fails.
    const path = entityToPath("interceptor", NAME);
    const tab = matchEntityRoute(path);
    expect(tab?.kind).toBe("interceptor");
    expect(tab?.entityId).toBe(NAME);
    // The label is the full name, not a shortened uuid prefix.
    expect(tab?.label).toBe(NAME);
  });

  test("minskyUriToPath resolves end to end", () => {
    expect(minskyUriToPath(`minsky://interceptor/${NAME}`)).toBe(`/interceptors/${NAME}`);
  });

  test("the bare catalog route is NOT an entity route", () => {
    // `/interceptors` is a list destination; only a detail path opens a tab.
    expect(matchEntityRoute("/interceptors")).toBeNull();
  });

  test("tokenEntity inverts entityToPath for the new type", () => {
    // `tokenEntity` is a THIRD inverse (path segment -> type), keyed by a
    // `Record<string, ...>` so the typechecker cannot enforce exhaustiveness
    // the way it did for EntityRef's and TabBar's Records. Without this case,
    // a `minsky://interceptor/...` URI in Prose renders an anchor that
    // navigates but loses its entity identity.
    expect(tokenEntity({ kind: "link", to: entityToPath("interceptor", NAME) } as never)).toEqual({
      type: "interceptor",
      id: NAME,
    });
  });

  test("a name needing encoding survives the round-trip", () => {
    // No current guardName contains a URL-reserved character, but the codec
    // must not depend on that — a future name with a `/` would otherwise
    // silently address a different route.
    const odd = "weird/name";
    const uri = entityToMinskyUri("interceptor", odd);
    expect(uri).toBe("minsky://interceptor/weird%2Fname");
    expect(parseMinskyUri(uri)).toEqual({ type: "interceptor", id: odd });
    expect(matchEntityRoute(entityToPath("interceptor", odd))?.entityId).toBe(odd);
  });
});
