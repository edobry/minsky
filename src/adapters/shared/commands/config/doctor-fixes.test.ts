/**
 * Tests for the config doctor auto-fixes (mt#2679).
 *
 * Exercises `fixMcpAuthTokenFromSecretsFile` with injected readFile/writer
 * seams — no real user config or filesystem is touched. Verifies:
 *   1. Happy path: secrets file present with the token → the config writer is
 *      called with (mcp.auth.token, token) and the diagnostic passes.
 *   2. Secret hygiene: the token value NEVER appears in any diagnostic text.
 *   3. Miss paths: missing file / malformed JSON / missing key / empty value
 *      → non-fixed warning naming the gap, writer never called.
 *   4. Writer failure → error diagnostic, still no secret in the message.
 */

import { describe, expect, test } from "bun:test";
import { join } from "path";

import {
  fixMcpAuthTokenFromSecretsFile,
  MCP_AUTH_TOKEN_CONFIG_KEY,
  MCP_AUTH_TOKEN_SECRET_KEY,
  RAILWAY_SECRETS_FILENAME,
  type ConfigValueWriter,
} from "./doctor-fixes";

const CONFIG_DIR = "/fake/config/minsky";
const SECRETS_PATH = join(CONFIG_DIR, RAILWAY_SECRETS_FILENAME);
const SECRET_TOKEN = "super-secret-token-value-1234";

function makeWriter(result: { success: boolean; error?: string; filePath?: string }): {
  writer: ConfigValueWriter;
  calls: Array<{ key: string; value: unknown }>;
} {
  const calls: Array<{ key: string; value: unknown }> = [];
  return {
    calls,
    writer: {
      async setConfigValue(key: string, value: unknown) {
        calls.push({ key, value });
        return result;
      },
    },
  };
}

function readFileReturning(content: string): (path: string) => string {
  return (path: string) => {
    if (path !== SECRETS_PATH) throw new Error(`ENOENT: ${path}`);
    return content;
  };
}

describe("fixMcpAuthTokenFromSecretsFile", () => {
  test("provisions mcp.auth.token from the secrets file and reports pass", async () => {
    const { writer, calls } = makeWriter({ success: true, filePath: "/fake/config.yaml" });
    const diag = await fixMcpAuthTokenFromSecretsFile({
      configDir: CONFIG_DIR,
      readFile: readFileReturning(JSON.stringify({ [MCP_AUTH_TOKEN_SECRET_KEY]: SECRET_TOKEN })),
      writer,
    });

    expect(diag.status).toBe("pass");
    expect(calls).toEqual([{ key: MCP_AUTH_TOKEN_CONFIG_KEY, value: SECRET_TOKEN }]);
    expect(diag.message).toContain(RAILWAY_SECRETS_FILENAME);
    expect(diag.message).toContain("/fake/config.yaml");
  });

  test("never includes the secret value in any diagnostic text", async () => {
    const scenarios = [
      // pass
      await fixMcpAuthTokenFromSecretsFile({
        configDir: CONFIG_DIR,
        readFile: readFileReturning(JSON.stringify({ [MCP_AUTH_TOKEN_SECRET_KEY]: SECRET_TOKEN })),
        writer: makeWriter({ success: true }).writer,
      }),
      // writer failure
      await fixMcpAuthTokenFromSecretsFile({
        configDir: CONFIG_DIR,
        readFile: readFileReturning(JSON.stringify({ [MCP_AUTH_TOKEN_SECRET_KEY]: SECRET_TOKEN })),
        writer: makeWriter({ success: false, error: "disk full" }).writer,
      }),
    ];

    for (const diag of scenarios) {
      const text = `${diag.message} ${diag.suggestion ?? ""}`;
      expect(text).not.toContain(SECRET_TOKEN);
    }
  });

  test("missing secrets file → warning, writer untouched", async () => {
    const { writer, calls } = makeWriter({ success: true });
    const diag = await fixMcpAuthTokenFromSecretsFile({
      configDir: CONFIG_DIR,
      readFile: () => {
        throw new Error("ENOENT");
      },
      writer,
    });

    expect(diag.status).toBe("warning");
    expect(diag.message).toContain("no readable");
    expect(calls).toHaveLength(0);
  });

  test("malformed JSON → warning, writer untouched", async () => {
    const { writer, calls } = makeWriter({ success: true });
    const diag = await fixMcpAuthTokenFromSecretsFile({
      configDir: CONFIG_DIR,
      readFile: readFileReturning("{not json"),
      writer,
    });

    expect(diag.status).toBe("warning");
    expect(diag.message).toContain("not valid JSON");
    expect(calls).toHaveLength(0);
  });

  test.each([
    ["missing key", JSON.stringify({ OTHER_KEY: "x" })],
    ["empty value", JSON.stringify({ [MCP_AUTH_TOKEN_SECRET_KEY]: "   " })],
    ["non-string value", JSON.stringify({ [MCP_AUTH_TOKEN_SECRET_KEY]: 42 })],
    ["non-object root", JSON.stringify(["array"])],
  ])("%s in secrets file → warning, writer untouched", async (_label, content) => {
    const { writer, calls } = makeWriter({ success: true });
    const diag = await fixMcpAuthTokenFromSecretsFile({
      configDir: CONFIG_DIR,
      readFile: readFileReturning(content),
      writer,
    });

    expect(diag.status).toBe("warning");
    expect(calls).toHaveLength(0);
  });

  test("writer failure → error diagnostic naming the write error", async () => {
    const diag = await fixMcpAuthTokenFromSecretsFile({
      configDir: CONFIG_DIR,
      readFile: readFileReturning(JSON.stringify({ [MCP_AUTH_TOKEN_SECRET_KEY]: SECRET_TOKEN })),
      writer: makeWriter({ success: false, error: "disk full" }).writer,
    });

    expect(diag.status).toBe("error");
    expect(diag.message).toContain("disk full");
  });

  test("trims whitespace around the token before writing", async () => {
    const { writer, calls } = makeWriter({ success: true });
    await fixMcpAuthTokenFromSecretsFile({
      configDir: CONFIG_DIR,
      readFile: readFileReturning(
        JSON.stringify({ [MCP_AUTH_TOKEN_SECRET_KEY]: `  ${SECRET_TOKEN}\n` })
      ),
      writer,
    });

    expect(calls[0]?.value).toBe(SECRET_TOKEN);
  });
});
