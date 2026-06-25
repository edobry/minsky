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

  test("rejects non-minsky URIs", () => {
    expect(parseMinskyUri("https://example.com")).toBeNull();
    expect(parseMinskyUri("http://localhost:3000/tasks/mt%232370")).toBeNull();
  });

  test("rejects unknown types", () => {
    expect(parseMinskyUri("minsky://pr/123")).toBeNull();
    expect(parseMinskyUri("minsky://agent/abc")).toBeNull();
    expect(parseMinskyUri("minsky://changeset/abc")).toBeNull();
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
});
