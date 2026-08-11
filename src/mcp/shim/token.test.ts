import { describe, test, expect } from "bun:test";
import { readAuthToken, type TokenFsDeps } from "./token";

const MOCK_PATH = "/mock/config/minsky/local-mcp-token";

function makeMockFsDeps(content: string | Error): TokenFsDeps {
  return {
    readFileSync: (path: string) => {
      expect(path).toBe(MOCK_PATH);
      if (content instanceof Error) throw content;
      return content;
    },
  };
}

describe("readAuthToken", () => {
  test("reads and trims a token", () => {
    expect(readAuthToken(MOCK_PATH, makeMockFsDeps("secret-token-value\n"))).toBe(
      "secret-token-value"
    );
  });

  test("returns null when the file read throws (missing file)", () => {
    expect(readAuthToken(MOCK_PATH, makeMockFsDeps(new Error("ENOENT")))).toBeNull();
  });

  test("returns null for an empty file", () => {
    expect(readAuthToken(MOCK_PATH, makeMockFsDeps(""))).toBeNull();
  });

  test("returns null for a whitespace-only file", () => {
    expect(readAuthToken(MOCK_PATH, makeMockFsDeps("   \n\n  "))).toBeNull();
  });
});
