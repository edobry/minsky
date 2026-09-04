/**
 * Tests for the tool-output credential scrubber (mt#2763).
 *
 * All credential values below are SYNTHETIC — shaped to match the regex
 * (correct prefix/length/charset) but not derived from, and unrelated to,
 * any real credential from any incident. Never paste a real leaked shape
 * into a test.
 */

import { describe, test, expect } from "bun:test";

import { CREDENTIAL_SHAPES, scrubText, scrubValueDeep } from "./credential-scrubber";

// ── Synthetic fixtures (fake, shape-matching only) ──────────────────────────

const FAKE_PULUMI_TOKEN = `pul-${"a1b2c3d4".repeat(5)}`; // 40 hex chars
const FAKE_OPENAI_KEY = `sk-${"x".repeat(48)}`;
const FAKE_GITHUB_PAT = `ghp_${"A".repeat(36)}`;
const FAKE_GITHUB_OAUTH = `gho_${"B".repeat(36)}`;
// Deliberately NOT shaped like a real Slack token's digit-group structure
// (xoxb-<digits>-<digits>-<alnum>) — a realistic-looking digit run tripped
// GitHub push protection's secret scanner even though this value is
// synthetic. Keeping the prefix + length-floor (what OUR regex matches) while
// avoiding GitHub's own detector's shape.
const FAKE_SLACK_TOKEN = "xoxb-FAKE-NOT-A-REAL-SLACK-TOKEN-TEST-ONLY";
const FAKE_AWS_KEY = "AKIAABCDEFGHIJKLMNOP"; // AKIA + 16 uppercase alnum
const FAKE_PEM_KEY = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtlZmFrZQ==",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
const FAKE_JWT = [`eyJ${"a".repeat(10)}`, `eyJ${"b".repeat(10)}`, `${"c".repeat(10)}`].join(".");
const FAKE_PG_URL = "postgresql://fakeuser:fakepassword@db.example.invalid:5432/mydb";
const PG_SHAPE = "postgres-url-credentials";
// mt#4159. The hex fixture mirrors the shape `.mcp.json` actually carried (64
// hex chars, no vendor sigil); the b64 fixture exercises the rest of RFC 6750
// §2.1's charset — `-`, `_`, `~`, `+`, `/`, `.` — so a body using the full
// grammar is covered, not just the hex subset that prompted the shape.
const FAKE_BEARER_HEX = "0123456789abcdef".repeat(4); // 64 chars
const FAKE_BEARER_B64 = "FAKE-not-a-real-bearer.token_value~1+2/3";

describe("credential-scrubber", () => {
  describe("CREDENTIAL_SHAPES", () => {
    test("every shape carries a non-empty precision basis", () => {
      for (const shape of CREDENTIAL_SHAPES) {
        expect(shape.precisionBasis.length).toBeGreaterThan(20);
        expect(shape.regex.global).toBe(true);
      }
    });

    test("shape names are unique", () => {
      const names = CREDENTIAL_SHAPES.map((s) => s.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  describe("scrubText", () => {
    test("returns input unchanged when no credential shape matches", () => {
      const { text, redactions } = scrubText("just a normal sentence with no secrets in it");
      expect(text).toBe("just a normal sentence with no secrets in it");
      expect(redactions).toEqual([]);
    });

    test("handles empty string", () => {
      const { text, redactions } = scrubText("");
      expect(text).toBe("");
      expect(redactions).toEqual([]);
    });

    test("redacts a Pulumi token and retains an 8-char prefix", () => {
      const { text, redactions } = scrubText(`pulumi token present: ${FAKE_PULUMI_TOKEN}`);
      expect(text).not.toContain(FAKE_PULUMI_TOKEN);
      expect(text).toContain("[REDACTED:pulumi-token:");
      expect(text).toContain(FAKE_PULUMI_TOKEN.slice(0, 8));
      expect(redactions).toHaveLength(1);
      expect(redactions[0]?.shape).toBe("pulumi-token");
      expect(redactions[0]?.prefix8).toBe(FAKE_PULUMI_TOKEN.slice(0, 8));
    });

    test("redacts an OpenAI-shaped secret key", () => {
      const { text, redactions } = scrubText(`OPENAI_API_KEY=${FAKE_OPENAI_KEY}`);
      expect(text).not.toContain(FAKE_OPENAI_KEY);
      expect(text).toContain("[REDACTED:openai-style-secret-key:");
      expect(redactions[0]?.shape).toBe("openai-style-secret-key");
    });

    test("does NOT redact a short sk-prefixed identifier (precision floor)", () => {
      const { text, redactions } = scrubText("the sk-flag was set");
      expect(text).toBe("the sk-flag was set");
      expect(redactions).toEqual([]);
    });

    test("redacts GitHub personal-access and OAuth tokens", () => {
      const { text, redactions } = scrubText(`pat=${FAKE_GITHUB_PAT} oauth=${FAKE_GITHUB_OAUTH}`);
      expect(text).not.toContain(FAKE_GITHUB_PAT);
      expect(text).not.toContain(FAKE_GITHUB_OAUTH);
      expect(redactions).toHaveLength(2);
      expect(redactions.every((r) => r.shape === "github-token")).toBe(true);
    });

    test("redacts a Slack bot token", () => {
      const { text, redactions } = scrubText(`slack token: ${FAKE_SLACK_TOKEN}`);
      expect(text).not.toContain(FAKE_SLACK_TOKEN);
      expect(redactions[0]?.shape).toBe("slack-token");
    });

    test("redacts an AWS access key ID", () => {
      const { text, redactions } = scrubText(`AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}`);
      expect(text).not.toContain(FAKE_AWS_KEY);
      expect(redactions[0]?.shape).toBe("aws-access-key-id");
    });

    test("redacts a PEM private-key block in full (header through footer)", () => {
      const { text, redactions } = scrubText(`key follows:\n${FAKE_PEM_KEY}\ndone`);
      expect(text).not.toContain("ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtlZmFrZQ==");
      expect(text).toContain("[REDACTED:pem-private-key:");
      expect(redactions[0]?.shape).toBe("pem-private-key");
    });

    test("redacts a JWT (three-segment dotted structure)", () => {
      const { text, redactions } = scrubText(`Authorization: Bearer ${FAKE_JWT}`);
      expect(text).not.toContain(FAKE_JWT);
      expect(redactions[0]?.shape).toBe("jwt");
    });

    test("does NOT redact a bare eyJ fragment lacking the full three-segment structure", () => {
      const { text, redactions } = scrubText("the value started with eyJhbGci but nothing else");
      expect(text).toBe("the value started with eyJhbGci but nothing else");
      expect(redactions).toEqual([]);
    });

    test("redacts a postgres URL carrying inline credentials", () => {
      const { text, redactions } = scrubText(`DATABASE_URL=${FAKE_PG_URL}`);
      expect(text).not.toContain("fakepassword");
      expect(redactions[0]?.shape).toBe(PG_SHAPE);
    });

    // mt#4017 criterion 4 / AT4 — the leak shape is JSON-EMBEDDED, not a bare
    // URL in prose: scripts/drizzle-config-loader.ts prints
    // `JSON.stringify({ postgres: { connectionString: "<url>" }, ... }, null, 2)`,
    // so the credential sits on its own quoted, indented line inside a larger
    // JSON blob. Confirms the planning audit's finding programmatically rather
    // than re-deriving it by eye.
    test("redacts a postgres URL embedded in pretty-printed JSON (mt#4017 R4 shape)", () => {
      const dbConfigJson = JSON.stringify(
        {
          postgres: { connectionString: FAKE_PG_URL },
          sqlite: { path: null },
          backend: "postgres",
        },
        null,
        2
      );
      const { text, redactions } = scrubText(dbConfigJson);
      expect(text).not.toContain("fakepassword");
      expect(text).not.toContain(FAKE_PG_URL);
      expect(redactions.some((r) => r.shape === PG_SHAPE)).toBe(true);
      // The surrounding JSON structure (quotes, indentation, sibling keys)
      // survives — only the matched credential span is replaced.
      expect(text).toContain('"connectionString": "[REDACTED:postgres-url-credentials:');
      expect(text).toContain('"backend": "postgres"');
    });

    // mt#4963. Postgres accepts a URL with an empty userinfo half, and the shape
    // used `+` on both — so either half being empty made it match NOTHING, and a
    // regex that matches nothing returns its input unchanged. The empty-USERNAME
    // case is the severe one: the password is real and fully exposed.
    //
    // Measured on the live corpus before the fix: 7 turns since the 2026-07-18
    // scrub cutoff carried an empty-half URL this shape did not see, against 0
    // unredacted both-halves-non-empty URLs in the same window — i.e. the
    // scrubber was working on exactly the inputs it could see, and only these.
    test("redacts a postgres URL with an EMPTY USERNAME (the password is still real)", () => {
      const url = "postgresql://:fakepassword@db.example.invalid:5432/mydb";
      const { text, redactions } = scrubText(`DATABASE_URL=${url}`);
      expect(text).not.toContain("fakepassword");
      expect(redactions[0]?.shape).toBe(PG_SHAPE);
    });

    test("redacts a postgres URL with an EMPTY PASSWORD", () => {
      const url = "postgresql://fakeuser:@db.example.invalid:5432/mydb";
      const { text, redactions } = scrubText(`DATABASE_URL=${url}`);
      expect(text).not.toContain(url);
      expect(redactions[0]?.shape).toBe(PG_SHAPE);
    });

    test("redacts a postgres URL with BOTH halves empty", () => {
      const url = "postgresql://:@db.example.invalid:5432/mydb";
      const { text, redactions } = scrubText(`DATABASE_URL=${url}`);
      expect(text).not.toContain(url);
      expect(redactions[0]?.shape).toBe(PG_SHAPE);
    });

    // The false-positive direction, and the reason widening the quantifiers is
    // safe: it is the trailing `@` that excludes a credential-less URL, not the
    // `+`. Without this the widening would look like a precision regression.
    test("does NOT redact a credential-less postgres URL (the @ anchor, not the quantifiers)", () => {
      const url = "postgresql://db.example.invalid:5432/mydb";
      const { text, redactions } = scrubText(`DATABASE_URL=${url}`);
      expect(text).toContain(url);
      expect(redactions).toHaveLength(0);
    });

    test("redacts multiple distinct credentials in one string", () => {
      const combined = `${FAKE_PULUMI_TOKEN} and also ${FAKE_AWS_KEY}`;
      const { text, redactions } = scrubText(combined);
      expect(text).not.toContain(FAKE_PULUMI_TOKEN);
      expect(text).not.toContain(FAKE_AWS_KEY);
      expect(redactions).toHaveLength(2);
    });

    test("redacts every occurrence of a repeated credential", () => {
      const { text, redactions } = scrubText(`${FAKE_AWS_KEY} ... ${FAKE_AWS_KEY}`);
      expect(text).not.toContain(FAKE_AWS_KEY);
      expect(redactions).toHaveLength(2);
    });
  });

  describe("scrubValueDeep", () => {
    test("scrubs string leaves nested inside objects and arrays", () => {
      const input = {
        type: "user",
        message: {
          content: [
            { type: "text", text: `here is my token: ${FAKE_AWS_KEY}` },
            { type: "tool_result", content: [{ type: "text", text: FAKE_PULUMI_TOKEN }] },
          ],
        },
      };

      const { value, redactions } = scrubValueDeep(input);

      expect(redactions).toHaveLength(2);
      const content = (value as typeof input).message.content;
      expect(content[0]?.text).not.toContain(FAKE_AWS_KEY);
      const toolResultContent = content[1]?.content as Array<{ text: string }>;
      expect(toolResultContent[0]?.text).not.toContain(FAKE_PULUMI_TOKEN);
    });

    test("leaves non-string leaves (numbers, booleans, null) untouched", () => {
      const input = { count: 3, active: true, missing: null, name: "plain text" };
      const { value, redactions } = scrubValueDeep(input);
      expect(value).toEqual(input);
      expect(redactions).toEqual([]);
    });

    test("does not mutate the input", () => {
      const input = { text: FAKE_AWS_KEY };
      const { value } = scrubValueDeep(input);
      expect(input.text).toBe(FAKE_AWS_KEY);
      expect((value as typeof input).text).not.toBe(FAKE_AWS_KEY);
    });

    test("handles a self-referential structure without infinite recursion", () => {
      const cyclic: Record<string, unknown> = { text: FAKE_AWS_KEY };
      cyclic.self = cyclic;
      const { value, redactions } = scrubValueDeep(cyclic);
      expect(redactions).toHaveLength(1);
      expect((value as Record<string, unknown>).text).not.toBe(FAKE_AWS_KEY);
    });

    test("returns clean input with zero redactions unchanged", () => {
      const input = { type: "assistant", message: { content: "hello world" } };
      const { value, redactions } = scrubValueDeep(input);
      expect(value).toEqual(input);
      expect(redactions).toEqual([]);
    });
  });

  // ── mt#4159 — the two shapes `.mcp.json`'s credentials slipped through ─────
  //
  // Found by reading `.mcp.json` while applying mt#4140: the file's
  // `minsky-hosted` entry carries `"Authorization": "Bearer <64 hex>"`, which
  // matched none of the eight shapes and ingested verbatim.
  describe("mt#4159 — bearer tokens and the non-ghp GitHub prefixes", () => {
    test("redacts a bearer token in an Authorization header", () => {
      const { text, redactions } = scrubText(
        `"headers": { "Authorization": "Bearer ${FAKE_BEARER_HEX}" }`
      );
      expect(text).not.toContain(FAKE_BEARER_HEX);
      expect(text).toContain("[REDACTED:bearer-token:");
      expect(redactions).toHaveLength(1);
      expect(redactions[0]?.shape).toBe("bearer-token");
    });

    test("redacts a bearer token in a curl -H argument", () => {
      const { text, redactions } = scrubText(
        `curl -H 'Authorization: Bearer ${FAKE_BEARER_B64}' https://example.invalid/mcp`
      );
      expect(text).not.toContain(FAKE_BEARER_B64);
      expect(redactions[0]?.shape).toBe("bearer-token");
    });

    // PR #3016 R1: the auth-scheme token is case-insensitive per RFC 7235 §2.1, so an
    // emitter sending `BEARER` was leaving a real token unredacted.
    test.each([
      ["upper", "BEARER"],
      ["lower", "bearer"],
      ["mixed", "BeArEr"],
    ])("redacts a bearer token with a %s-case scheme", (_label, scheme) => {
      const { text, redactions } = scrubText(`Authorization: ${scheme} ${FAKE_BEARER_HEX}`);
      expect(text).not.toContain(FAKE_BEARER_HEX);
      expect(redactions).toHaveLength(1);
      expect(redactions[0]?.shape).toBe("bearer-token");
    });

    // PR #3016 R1 read `[...+/-]` as a `+`-to-`/` range admitting a comma. It is not — a
    // hyphen immediately before `]` is literal — but the charset boundary is worth pinning
    // rather than re-deriving, since over-running a header separator would redact the
    // NEXT header's name along with the token.
    test("stops at a header separator and does not consume the comma", () => {
      const input = `Authorization: Bearer ${FAKE_BEARER_HEX}, Next-Header: plain-value`;
      const { text, redactions } = scrubText(input);
      expect(redactions).toHaveLength(1);
      expect(text).not.toContain(FAKE_BEARER_HEX);
      expect(text).toContain(", Next-Header: plain-value");
    });

    test.each([
      ["ghs (server-to-server)", `ghs_${"C".repeat(36)}`],
      ["ghu (user-to-server)", `ghu_${"D".repeat(36)}`],
      ["ghr (refresh)", `ghr_${"E".repeat(36)}`],
    ])("redacts a %s GitHub token", (_label, token) => {
      const { text, redactions } = scrubText(`token=${token}`);
      expect(text).not.toContain(token);
      expect(redactions[0]?.shape).toBe("github-token");
    });

    // mem#972: a shape that cannot tell a secret from its redaction reports
    // every correctly-masking command as a leak. Each of these puts a character
    // outside RFC 6750's charset immediately after the scheme.
    test.each([
      ["asterisk mask", "Authorization: Bearer ***"],
      ["angle-bracket placeholder", "Authorization: Bearer <redacted>"],
      ["shell variable", 'curl -H "Authorization: Bearer $MINSKY_TOKEN"'],
      ["braced shell variable", 'curl -H "Authorization: Bearer ${MINSKY_TOKEN}"'],
      ["scheme with no token", "the header uses the Bearer scheme"],
      ["short token below the floor", "Authorization: Bearer abc123"],
    ])("leaves a masked or token-less form untouched: %s", (_label, input) => {
      const { text, redactions } = scrubText(input);
      expect(text).toBe(input);
      expect(redactions).toEqual([]);
    });

    // The over-redaction control: structurally similar, definitely not credentials.
    test.each([
      ["a git commit SHA", "merged as 28f8f54d0a1b2c3d4e5f60718293a4b5c6d7e8f9"],
      ["a UUID", "session cecf26e4-cf15-41f9-8dcc-a2998475762b started"],
      ["a sha256 digest", `sha256:${"ab".repeat(32)}`],
    ])("does not redact %s", (_label, input) => {
      const { text, redactions } = scrubText(input);
      expect(text).toBe(input);
      expect(redactions).toEqual([]);
    });

    // The single-pass ordering property the file docblock asserts: a more
    // specific shape wins, and its `[REDACTED:...]` output is not re-matched by
    // the bearer shape, so the value is redacted exactly once.
    test("a GitHub token presented as a bearer is redacted once, by its own shape", () => {
      const { text, redactions } = scrubText(`Authorization: Bearer ${FAKE_GITHUB_PAT}`);
      expect(text).not.toContain(FAKE_GITHUB_PAT);
      expect(redactions).toHaveLength(1);
      expect(redactions[0]?.shape).toBe("github-token");
      expect(text).not.toContain("[REDACTED:bearer-token:");
    });

    test("a JWT presented as a bearer is redacted once, by the jwt shape", () => {
      const { text, redactions } = scrubText(`Authorization: Bearer ${FAKE_JWT}`);
      expect(text).not.toContain(FAKE_JWT);
      expect(redactions).toHaveLength(1);
      expect(redactions[0]?.shape).toBe("jwt");
    });

    test("scrubValueDeep reaches a bearer token nested in a config-shaped object", () => {
      const input = {
        mcpServers: {
          "minsky-hosted": {
            type: "http",
            url: "https://example.invalid/mcp",
            headers: { Authorization: `Bearer ${FAKE_BEARER_HEX}` },
          },
        },
      };
      const { value, redactions } = scrubValueDeep(input);
      expect(redactions).toHaveLength(1);
      expect(redactions[0]?.shape).toBe("bearer-token");
      expect(JSON.stringify(value)).not.toContain(FAKE_BEARER_HEX);
    });
  });
});
