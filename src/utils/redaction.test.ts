/**
 * Unit tests for redaction utilities (mt#1181).
 */
import { describe, test, expect } from "bun:test";
import { isSensitiveKey, redact, SENSITIVE_KEY_PATTERNS } from "./redaction";

describe("isSensitiveKey", () => {
  test("matches exact sensitive key names", () => {
    expect(isSensitiveKey("token")).toBe(true);
    expect(isSensitiveKey("apiKey")).toBe(true);
    expect(isSensitiveKey("password")).toBe(true);
    expect(isSensitiveKey("secret")).toBe(true);
    expect(isSensitiveKey("connectionString")).toBe(true);
  });

  test("matches compound *Key and *_key suffix patterns", () => {
    expect(isSensitiveKey("apiKey")).toBe(true);
    expect(isSensitiveKey("secretKey")).toBe(true);
    expect(isSensitiveKey("privateKey")).toBe(true);
    expect(isSensitiveKey("accessKey")).toBe(true);
    expect(isSensitiveKey("authKey")).toBe(true);
    expect(isSensitiveKey("signingKey")).toBe(true);
    expect(isSensitiveKey("encryptionKey")).toBe(true);
    expect(isSensitiveKey("private_key")).toBe(true);
    expect(isSensitiveKey("access_key")).toBe(true);
    expect(isSensitiveKey("api_key")).toBe(true);
  });

  test("does NOT match benign keys that contain 'key' as a prefix or mid-word", () => {
    // These were false positives with the old bare 'key' substring match.
    expect(isSensitiveKey("monkey")).toBe(false);
    expect(isSensitiveKey("keyboard")).toBe(false);
    expect(isSensitiveKey("keyPath")).toBe(false);
    expect(isSensitiveKey("surveyKeyPath")).toBe(false);
  });

  test("does not match non-sensitive key names", () => {
    expect(isSensitiveKey("name")).toBe(false);
    expect(isSensitiveKey("value")).toBe(false);
    expect(isSensitiveKey("status")).toBe(false);
    expect(isSensitiveKey("count")).toBe(false);
    expect(isSensitiveKey("normal")).toBe(false);
  });

  test("case-insensitive matching: Token, API_KEY, ConnectionString all match", () => {
    expect(isSensitiveKey("Token")).toBe(true);
    expect(isSensitiveKey("TOKEN")).toBe(true);
    expect(isSensitiveKey("API_KEY")).toBe(true);
    expect(isSensitiveKey("ConnectionString")).toBe(true);
    expect(isSensitiveKey("CONNECTIONSTRING")).toBe(true);
    expect(isSensitiveKey("APIKEY")).toBe(true);
    expect(isSensitiveKey("apikey")).toBe(true);
  });

  // mt#1181 R4 Finding A: substring overbreadth — generic words must not over-match
  test("'secretary' is NOT sensitive (substring guard for 'secret')", () => {
    expect(isSensitiveKey("secretary")).toBe(false);
  });

  test("'tokenize' is NOT sensitive (substring guard for 'token')", () => {
    expect(isSensitiveKey("tokenize")).toBe(false);
  });

  test("'passwordHash' is NOT sensitive (metadata field, not a credential value)", () => {
    // Judgment call: passwordHash is metadata (e.g. a hash algorithm name), not a
    // credential value, so we intentionally exclude it from redaction.
    expect(isSensitiveKey("passwordHash")).toBe(false);
  });

  // mt#1181 R4 Finding A: camelCase suffix must still match
  test("'accessToken' IS sensitive (camelCase suffix match)", () => {
    expect(isSensitiveKey("accessToken")).toBe(true);
  });

  test("'access_token' IS sensitive (snake_case suffix match)", () => {
    expect(isSensitiveKey("access_token")).toBe(true);
  });

  // mt#1181 R4 Finding B: hyphenated HTTP-header style keys (native regex, no normalization)
  test("x-api-key is sensitive (native regex, hyphen as separator)", () => {
    expect(isSensitiveKey("x-api-key")).toBe(true);
  });

  test("x-auth-token is sensitive (native regex, hyphen as separator)", () => {
    expect(isSensitiveKey("x-auth-token")).toBe(true);
  });

  test("proxy-authorization is sensitive (native regex, hyphen as separator)", () => {
    expect(isSensitiveKey("proxy-authorization")).toBe(true);
  });

  test("x-amz-access-key is sensitive (native regex, hyphen as separator)", () => {
    expect(isSensitiveKey("x-amz-access-key")).toBe(true);
  });

  test("x-access-token is sensitive (native regex, hyphen as separator)", () => {
    expect(isSensitiveKey("x-access-token")).toBe(true);
  });

  test("SENSITIVE_KEY_PATTERNS is readonly and contains expected entries", () => {
    expect(SENSITIVE_KEY_PATTERNS).toContain("token");
    expect(SENSITIVE_KEY_PATTERNS).toContain("apiKey");
    expect(SENSITIVE_KEY_PATTERNS).toContain("password");
    expect(SENSITIVE_KEY_PATTERNS).toContain("secret");
    expect(SENSITIVE_KEY_PATTERNS).toContain("connectionString");
    // 'key' as a bare substring is intentionally absent — see SENSITIVE_KEY_REGEX
    expect(SENSITIVE_KEY_PATTERNS).not.toContain("key");
  });
});

describe("redact", () => {
  test("flat object: sensitive key is redacted, non-sensitive key passes through", () => {
    const input = { token: "secret-value", normal: "visible" };
    const result = redact(input);
    expect(result.token).toBe("[REDACTED]");
    expect(result.normal).toBe("visible");
  });

  test("nested object: inner.token redacted, inner.normal intact", () => {
    const input = { inner: { token: "x", normal: "y" }, outer: "ok" };
    const result = redact(input);
    expect(result.inner.token).toBe("[REDACTED]");
    expect(result.inner.normal).toBe("y");
    expect(result.outer).toBe("ok");
  });

  test("array of objects: each element redacted independently", () => {
    const input = [
      { token: "t1", name: "a" },
      { password: "p1", name: "b" },
    ];
    const result = redact(input);
    expect(result[0]?.token).toBe("[REDACTED]");
    expect(result[0]?.name).toBe("a");
    expect(result[1]?.password).toBe("[REDACTED]");
    expect(result[1]?.name).toBe("b");
  });

  test("null passes through without throwing", () => {
    expect(redact(null)).toBeNull();
  });

  test("undefined passes through without throwing", () => {
    expect(redact(undefined)).toBeUndefined();
  });

  test("primitive string passes through", () => {
    expect(redact("hello")).toBe("hello");
  });

  test("primitive number passes through", () => {
    expect(redact(42)).toBe(42);
  });

  test("primitive boolean passes through", () => {
    expect(redact(false)).toBe(false);
  });

  test("circular reference does not loop", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    // Should not throw; circular reference replaced with sentinel
    expect(() => redact(obj)).not.toThrow();
    const result = redact(obj);
    expect(result.self).toBe("[Circular]");
  });

  test("input object is not mutated after redact", () => {
    const input = { token: "original", normal: "value" };
    redact(input);
    expect(input.token).toBe("original");
    expect(input.normal).toBe("value");
  });

  test("apiKey is redacted regardless of value type", () => {
    const input: Record<string, unknown> = { apiKey: 12345, normal: true };
    const result = redact(input);
    expect(result.apiKey).toBe("[REDACTED]");
    expect(result.normal).toBe(true);
  });

  test("deeply nested sensitive key is redacted", () => {
    const input = { config: { ai: { providers: { openai: { apiKey: "sk-abc" } } } } };
    const result = redact(input);
    expect(result.config.ai.providers.openai.apiKey).toBe("[REDACTED]");
  });

  test("private_key and accessKey are redacted", () => {
    const input = { private_key: "pk-value", accessKey: "ak-value", normal: "ok" };
    const result = redact(input);
    expect(result.private_key).toBe("[REDACTED]");
    expect(result.accessKey).toBe("[REDACTED]");
    expect(result.normal).toBe("ok");
  });

  test("monkey, keyboard, keyPath are NOT redacted (false-positive guard)", () => {
    const input = { monkey: "banana", keyboard: "qwerty", keyPath: "/foo/bar" };
    const result = redact(input);
    expect(result.monkey).toBe("banana");
    expect(result.keyboard).toBe("qwerty");
    expect(result.keyPath).toBe("/foo/bar");
  });

  // mt#1181 Finding 2: authorization/credential word-boundary anchoring
  test("'authorization' exact key is redacted", () => {
    const input: Record<string, unknown> = { authorization: "Bearer xyz" };
    const result = redact(input);
    expect(result.authorization).toBe("[REDACTED]");
  });

  test("'authorizationMode' is NOT redacted (substring over-match guard)", () => {
    const input: Record<string, unknown> = { authorizationMode: "Bearer" };
    const result = redact(input);
    expect(result.authorizationMode).toBe("Bearer");
  });

  test("'authorizationLevel' is NOT redacted (substring over-match guard)", () => {
    const input: Record<string, unknown> = { authorizationLevel: 3 };
    const result = redact(input);
    expect(result.authorizationLevel).toBe(3);
  });

  test("'credential' exact key is redacted", () => {
    const input: Record<string, unknown> = { credential: "s3cr3t" };
    const result = redact(input);
    expect(result.credential).toBe("[REDACTED]");
  });

  test("'credentials' exact key is redacted", () => {
    const input: Record<string, unknown> = { credentials: "multi-cred" };
    const result = redact(input);
    expect(result.credentials).toBe("[REDACTED]");
  });

  test("'credentialStatus' is NOT redacted (substring over-match guard)", () => {
    const input: Record<string, unknown> = { credentialStatus: "valid" };
    const result = redact(input);
    expect(result.credentialStatus).toBe("valid");
  });

  test("authorizationHeader exact key is redacted", () => {
    const input: Record<string, unknown> = { authorizationHeader: "Bearer tok" };
    const result = redact(input);
    expect(result.authorizationHeader).toBe("[REDACTED]");
  });

  // mt#1181 R4 Finding A: substring overbreadth guards in redact()
  test("'secretary' is NOT redacted (substring guard for 'secret')", () => {
    const input: Record<string, unknown> = { secretary: "Jane Doe" };
    const result = redact(input);
    expect(result.secretary).toBe("Jane Doe");
  });

  test("'tokenize' is NOT redacted (substring guard for 'token')", () => {
    const input: Record<string, unknown> = { tokenize: true };
    const result = redact(input);
    expect(result.tokenize).toBe(true);
  });

  test("'passwordHash' is NOT redacted (metadata, not a credential value)", () => {
    const input: Record<string, unknown> = { passwordHash: "bcrypt$..." };
    const result = redact(input);
    expect(result.passwordHash).toBe("bcrypt$...");
  });

  test("'accessToken' IS redacted (camelCase suffix)", () => {
    const input: Record<string, unknown> = { accessToken: "tok_abc" };
    const result = redact(input);
    expect(result.accessToken).toBe("[REDACTED]");
  });

  test("'access_token' IS redacted (snake_case suffix)", () => {
    const input: Record<string, unknown> = { access_token: "tok_abc" };
    const result = redact(input);
    expect(result.access_token).toBe("[REDACTED]");
  });

  // mt#1181 R4 Finding B: hyphenated HTTP-header style keys (native regex, no normalization)
  test("x-api-key is redacted (native regex, hyphen as separator)", () => {
    const input: Record<string, unknown> = { "x-api-key": "my-key-value" };
    const result = redact(input);
    expect(result["x-api-key"]).toBe("[REDACTED]");
  });

  test("x-auth-token is redacted (native regex, hyphen as separator)", () => {
    const input: Record<string, unknown> = { "x-auth-token": "tok_abc" };
    const result = redact(input);
    expect(result["x-auth-token"]).toBe("[REDACTED]");
  });

  test("proxy-authorization is redacted (native regex, hyphen as separator)", () => {
    const proxyAuthKey = "proxy-authorization";
    const input: Record<string, unknown> = { [proxyAuthKey]: "Basic xyz" };
    const result = redact(input);
    expect(result[proxyAuthKey]).toBe("[REDACTED]");
  });

  test("x-amz-access-key is redacted (native regex, hyphen as separator)", () => {
    const amzAccessKeyHeader = "x-amz-access-key";
    const input: Record<string, unknown> = { [amzAccessKeyHeader]: "AKIAIOSFODNN7" };
    const result = redact(input);
    expect(result[amzAccessKeyHeader]).toBe("[REDACTED]");
  });

  test("Authorization (mixed-case exact) is redacted", () => {
    const input: Record<string, unknown> = { Authorization: "Bearer tok" };
    const result = redact(input);
    expect(result.Authorization).toBe("[REDACTED]");
  });

  test("authorizationMode is NOT redacted (regression guard)", () => {
    const input: Record<string, unknown> = { authorizationMode: "implicit" };
    const result = redact(input);
    expect(result.authorizationMode).toBe("implicit");
  });

  test("monkey, keyboard, keyPath, surveyKeyPath remain NOT redacted (regression guards)", () => {
    const input: Record<string, unknown> = {
      monkey: "banana",
      keyboard: "qwerty",
      keyPath: "/foo/bar",
      surveyKeyPath: "/survey/key/path",
    };
    const result = redact(input);
    expect(result.monkey).toBe("banana");
    expect(result.keyboard).toBe("qwerty");
    expect(result.keyPath).toBe("/foo/bar");
    expect(result.surveyKeyPath).toBe("/survey/key/path");
  });

  // mt#1181 R5 finding: bare [-_]key$ catch-all dropped — public keys are not credentials
  test("public-key, public_key, publicKey are NOT redacted (R5: not credentials)", () => {
    const input: Record<string, unknown> = {
      "public-key": "ssh-rsa AAAA...",
      public_key: "ssh-rsa BBBB...",
      publicKey: "ssh-rsa CCCC...",
    };
    const result = redact(input);
    expect(result["public-key"]).toBe("ssh-rsa AAAA...");
    expect(result.public_key).toBe("ssh-rsa BBBB...");
    expect(result.publicKey).toBe("ssh-rsa CCCC...");
  });

  test("primary-key, primary_key are NOT redacted (R5: db column metadata)", () => {
    const input: Record<string, unknown> = {
      "primary-key": "id",
      primary_key: "id",
    };
    const result = redact(input);
    expect(result["primary-key"]).toBe("id");
    expect(result.primary_key).toBe("id");
  });

  test("host-key is NOT redacted (R5: SSH host-key fingerprint metadata)", () => {
    const input: Record<string, unknown> = { "host-key": "SHA256:abc123" };
    const result = redact(input);
    expect(result["host-key"]).toBe("SHA256:abc123");
  });

  test("api-key, private-key, secret-key, access-key ARE still redacted (explicit list)", () => {
    const input: Record<string, unknown> = {
      "api-key": "secret-1",
      "private-key": "secret-2",
      "secret-key": "secret-3",
      "access-key": "secret-4",
    };
    const result = redact(input);
    expect(result["api-key"]).toBe("[REDACTED]");
    expect(result["private-key"]).toBe("[REDACTED]");
    expect(result["secret-key"]).toBe("[REDACTED]");
    expect(result["access-key"]).toBe("[REDACTED]");
  });

  // mt#1181 R6 finding: lowercased camelCase boundary over-redacted unprefixed words
  test("mytoken, custompassword, dbconnectionstring are NOT redacted (R6)", () => {
    const input: Record<string, unknown> = {
      mytoken: "user-data-1",
      custompassword: "user-data-2",
      dbconnectionstring: "user-data-3",
    };
    const result = redact(input);
    expect(result.mytoken).toBe("user-data-1");
    expect(result.custompassword).toBe("user-data-2");
    expect(result.dbconnectionstring).toBe("user-data-3");
  });

  test("accessToken, bearerToken, refreshToken, idToken ARE redacted (explicit camelCase)", () => {
    const input: Record<string, unknown> = {
      accessToken: "at-1",
      bearerToken: "bt-1",
      refreshToken: "rt-1",
      idToken: "it-1",
      apiToken: "apit-1",
      authToken: "autht-1",
      sessionToken: "st-1",
      csrfToken: "csrf-1",
    };
    const result = redact(input);
    expect(result.accessToken).toBe("[REDACTED]");
    expect(result.bearerToken).toBe("[REDACTED]");
    expect(result.refreshToken).toBe("[REDACTED]");
    expect(result.idToken).toBe("[REDACTED]");
    expect(result.apiToken).toBe("[REDACTED]");
    expect(result.authToken).toBe("[REDACTED]");
    expect(result.sessionToken).toBe("[REDACTED]");
    expect(result.csrfToken).toBe("[REDACTED]");
  });

  test("token, password, secret as exact keys ARE redacted", () => {
    const input: Record<string, unknown> = {
      token: "t",
      password: "p",
      secret: "s",
      connectionString: "c",
    };
    const result = redact(input);
    expect(result.token).toBe("[REDACTED]");
    expect(result.password).toBe("[REDACTED]");
    expect(result.secret).toBe("[REDACTED]");
    expect(result.connectionString).toBe("[REDACTED]");
  });

  test("separator-bounded generic words ARE redacted (x-token, auth-password)", () => {
    const input: Record<string, unknown> = {
      "x-token": "1",
      "auth-password": "2",
      "stored-secret": "3",
    };
    const result = redact(input);
    expect(result["x-token"]).toBe("[REDACTED]");
    expect(result["auth-password"]).toBe("[REDACTED]");
    expect(result["stored-secret"]).toBe("[REDACTED]");
  });

  // mt#1181 R6 finding: shared references in a DAG must not be collapsed to [Circular]
  test("shared references in a DAG are redacted on every branch (not [Circular])", () => {
    const shared = { token: "x", normal: "y" };
    const input: Record<string, unknown> = { a: shared, b: shared };
    const result = redact(input) as {
      a: { token: string; normal: string };
      b: { token: string; normal: string };
    };
    expect(result.a).toEqual({ token: "[REDACTED]", normal: "y" });
    expect(result.b).toEqual({ token: "[REDACTED]", normal: "y" });
    // Critically, b is NOT "[Circular]"
    expect(result.b).not.toBe("[Circular]");
  });

  test("true cycle is still detected as [Circular]", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const result = redact(obj) as { a: number; self: unknown };
    expect(result.self).toBe("[Circular]");
  });
});
