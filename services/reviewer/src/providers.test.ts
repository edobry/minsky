import { describe, expect, test, mock } from "bun:test";
import {
  isReasoningModel,
  callOpenAIWithClient,
  buildReadFileEnvelope,
  buildListDirectoryEnvelope,
} from "./providers";
import type OpenAI from "openai";
import type { ReviewerToolContext } from "./tools";

describe("isReasoningModel", () => {
  describe("o-series reasoning models", () => {
    test("accepts o1 variants", () => {
      expect(isReasoningModel("o1")).toBe(true);
      expect(isReasoningModel("o1-mini")).toBe(true);
      expect(isReasoningModel("o1-preview")).toBe(true);
    });

    test("accepts o3 variants", () => {
      expect(isReasoningModel("o3")).toBe(true);
      expect(isReasoningModel("o3-mini")).toBe(true);
    });

    test("accepts o4 variants", () => {
      expect(isReasoningModel("o4")).toBe(true);
      expect(isReasoningModel("o4-mini")).toBe(true);
    });
  });

  describe("gpt-5 family", () => {
    test("accepts plain gpt-5", () => {
      expect(isReasoningModel("gpt-5")).toBe(true);
    });

    test("accepts gpt-5 variants", () => {
      expect(isReasoningModel("gpt-5-turbo")).toBe(true);
      expect(isReasoningModel("gpt-5-mini")).toBe(true);
    });
  });

  describe("non-reasoning models (must return false)", () => {
    test("rejects gpt-4o family", () => {
      expect(isReasoningModel("gpt-4o")).toBe(false);
      expect(isReasoningModel("gpt-4o-mini")).toBe(false);
    });

    test("rejects gpt-4 family", () => {
      expect(isReasoningModel("gpt-4")).toBe(false);
      expect(isReasoningModel("gpt-4-turbo")).toBe(false);
    });

    test("rejects gpt-3.5 family", () => {
      expect(isReasoningModel("gpt-3.5-turbo")).toBe(false);
    });

    test("rejects non-OpenAI-prefixed names", () => {
      expect(isReasoningModel("claude-opus-4")).toBe(false);
      expect(isReasoningModel("gemini-2.5-pro")).toBe(false);
    });
  });

  describe("edge cases", () => {
    test("rejects empty string", () => {
      expect(isReasoningModel("")).toBe(false);
    });

    test("rejects names that start with a letter but not the o-series pattern", () => {
      // "open-mistral" or similar — starts with "o" but not "o<digit>"
      expect(isReasoningModel("open-mistral-7b")).toBe(false);
      expect(isReasoningModel("other-model")).toBe(false);
    });

    test("does not match gpt-5 as a substring of a longer name (boundary check)", () => {
      // "gpt-50-turbo" is hypothetical but a boundary concern
      expect(isReasoningModel("gpt-50")).toBe(false);
      expect(isReasoningModel("gpt-55-turbo")).toBe(false);
    });
  });
});

// ----- Tool result envelopes (mt#1216) -----

describe("buildReadFileEnvelope", () => {
  test("text result becomes ok:true with content + truncated:false", () => {
    expect(buildReadFileEnvelope({ kind: "text", content: "hello\n", truncated: false })).toEqual({
      ok: true,
      content: "hello\n",
      truncated: false,
    });
  });

  test("truncated text result rides as truncated:true, no string-prefix", () => {
    const envelope = buildReadFileEnvelope({
      kind: "text",
      content: "{ partial json",
      truncated: true,
    });
    expect(envelope).toEqual({ ok: true, content: "{ partial json", truncated: true });
    // Regression guard: ensure the content field is not decorated.
    if (envelope.ok) expect(envelope.content).not.toContain("[TRUNCATED]");
  });

  test("binary result surfaces size and a placeholder content string", () => {
    const envelope = buildReadFileEnvelope({ kind: "binary", size: 4096, truncated: false });
    expect(envelope).toEqual({
      ok: true,
      content: "[BINARY FILE: 4096 bytes, not decoded]",
      truncated: false,
      binary: true,
      size: 4096,
    });
  });

  test("binary + truncated: envelope propagates truncated:true and annotates placeholder", () => {
    // Regression guard: a prior revision hardcoded truncated:false on the
    // binary branch. For large binaries GitHub sets truncated:true and the
    // model needs to know the snippet isn't authoritative.
    const envelope = buildReadFileEnvelope({
      kind: "binary",
      size: 2_500_000,
      truncated: true,
    });
    expect(envelope).toEqual({
      ok: true,
      content: "[BINARY FILE: 2500000 bytes, truncated snippet, not decoded]",
      truncated: true,
      binary: true,
      size: 2_500_000,
    });
  });

  test("null (404) becomes ok:false with error:'not_found'", () => {
    // Structural disambiguation — a missing file no longer collides with a
    // file whose content is the literal string "null".
    expect(buildReadFileEnvelope(null)).toEqual({ ok: false, error: "not_found" });
  });
});

describe("buildListDirectoryEnvelope", () => {
  test("entries become ok:true with the entries array", () => {
    const entries = [
      { name: "index.ts", type: "file" as const },
      { name: "lib", type: "dir" as const },
    ];
    expect(buildListDirectoryEnvelope(entries)).toEqual({ ok: true, entries });
  });

  test("passes through symlink and submodule entry types (mt#1216)", () => {
    const entries = [
      { name: "link", type: "symlink" as const },
      { name: "vendor", type: "submodule" as const },
    ];
    expect(buildListDirectoryEnvelope(entries)).toEqual({ ok: true, entries });
  });

  test("null (404) becomes ok:false with error:'not_found'", () => {
    expect(buildListDirectoryEnvelope(null)).toEqual({ ok: false, error: "not_found" });
  });
});

// ----- callOpenAIWithClient tool-use loop -----
//
// Tests use callOpenAIWithClient (DI-friendly) so we can inject a fake
// OpenAI client without module mocking (no-global-module-mocks rule).

describe("callOpenAIWithClient tool-use loop", () => {
  const MODEL = "gpt-4o";

  const makeUsage = (prompt = 100, completion = 50) => ({
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    completion_tokens_details: { reasoning_tokens: 0 },
  });

  /**
   * Extract the tool-message content string from a captured OpenAI request
   * round. Throws on missing or non-string content so test failures surface
   * at the helper boundary rather than as cryptic NPEs downstream.
   */
  function extractToolMessageContent(round: unknown[] | undefined): string {
    if (!round)
      throw new Error("captured round is undefined (fake client returned too few responses?)");
    const toolMsg = (round as Array<{ role: string; content?: unknown }>).find(
      (m) => m.role === "tool"
    );
    if (!toolMsg) throw new Error("no tool message found in captured round");
    if (typeof toolMsg.content !== "string") {
      throw new Error("tool message content is not a string");
    }
    return toolMsg.content;
  }

  /**
   * Build a fake OpenAI client that cycles through the given responses and
   * captures each request's messages so tests can assert on the tool-result
   * content the model would see.
   */
  function makeFakeClient(
    responses: Array<{
      choices: Array<{ message: { content: string | null; tool_calls?: unknown[] } }>;
      usage?: ReturnType<typeof makeUsage>;
    }>
  ): { client: OpenAI; capturedMessages: Array<unknown[]> } {
    let callCount = 0;
    const capturedMessages: Array<unknown[]> = [];
    const client = {
      chat: {
        completions: {
          create: async (params: { messages: unknown[] }) => {
            capturedMessages.push([...params.messages]);
            return responses[callCount++];
          },
        },
      },
    } as unknown as OpenAI;
    return { client, capturedMessages };
  }

  test("single-turn: returns text immediately when no tool calls", async () => {
    const { client } = makeFakeClient([
      { choices: [{ message: { content: "review text" } }], usage: makeUsage() },
    ]);
    const result = await callOpenAIWithClient(client, MODEL, "system", "user");
    expect(result.text).toBe("review text");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe(MODEL);
  });

  test("with tools: read_file result is wrapped in a JSON envelope the model sees", async () => {
    const { client, capturedMessages } = makeFakeClient([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: "src/foo.ts" }),
                  },
                },
              ],
            },
          },
        ],
        usage: makeUsage(200, 30),
      },
      {
        choices: [{ message: { content: "final review" } }],
        usage: makeUsage(300, 60),
      },
    ]);

    const readFileMock = mock(async (_path: string) => ({
      kind: "text" as const,
      content: "file contents here",
      truncated: false,
    }));
    const tools: ReviewerToolContext = {
      readFile: readFileMock,
      listDirectory: mock(async () => null),
    };

    const result = await callOpenAIWithClient(client, MODEL, "system", "user", tools);
    expect(result.text).toBe("final review");
    expect(readFileMock).toHaveBeenCalledWith("src/foo.ts");

    // On the second round the conversation carries the tool result message;
    // parse its content and assert the envelope shape.
    expect(JSON.parse(extractToolMessageContent(capturedMessages[1]))).toEqual({
      ok: true,
      content: "file contents here",
      truncated: false,
    });

    // Tokens are accumulated across rounds.
    expect(result.usage?.promptTokens).toBe(500); // 200 + 300
    expect(result.usage?.completionTokens).toBe(90); // 30 + 60
  });

  test("with tools: list_directory result envelope carries entries array", async () => {
    const { client, capturedMessages } = makeFakeClient([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_dir",
                  type: "function",
                  function: {
                    name: "list_directory",
                    arguments: JSON.stringify({ path: "src" }),
                  },
                },
              ],
            },
          },
        ],
        usage: makeUsage(100, 20),
      },
      {
        choices: [{ message: { content: "dir review" } }],
        usage: makeUsage(150, 40),
      },
    ]);

    const entries = [
      { name: "index.ts", type: "file" as const },
      { name: "link", type: "symlink" as const },
    ];
    const listDirectoryMock = mock(async (_path: string) => entries);
    const tools: ReviewerToolContext = {
      readFile: mock(async () => null),
      listDirectory: listDirectoryMock,
    };

    const result = await callOpenAIWithClient(client, MODEL, "system", "user", tools);
    expect(result.text).toBe("dir review");
    expect(listDirectoryMock).toHaveBeenCalledWith("src");

    expect(JSON.parse(extractToolMessageContent(capturedMessages[1]))).toEqual({
      ok: true,
      entries,
    });
  });

  test("with tools: not-found envelope for null readFile result", async () => {
    const { client, capturedMessages } = makeFakeClient([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_missing",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: "missing/file.ts" }),
                  },
                },
              ],
            },
          },
        ],
        usage: makeUsage(),
      },
      {
        choices: [{ message: { content: "followup" } }],
        usage: makeUsage(),
      },
    ]);

    const tools: ReviewerToolContext = {
      readFile: mock(async () => null),
      listDirectory: mock(async () => null),
    };

    await callOpenAIWithClient(client, MODEL, "system", "user", tools);

    expect(JSON.parse(extractToolMessageContent(capturedMessages[1]))).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  test("with tools: readFile throws → error envelope (not raw string, not thrown)", async () => {
    const { client, capturedMessages } = makeFakeClient([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_fail",
                  type: "function",
                  function: { name: "read_file", arguments: JSON.stringify({ path: "boom.ts" }) },
                },
              ],
            },
          },
        ],
        usage: makeUsage(),
      },
      {
        choices: [{ message: { content: "recovered" } }],
        usage: makeUsage(),
      },
    ]);

    const tools: ReviewerToolContext = {
      readFile: mock(async () => {
        throw new Error("network error");
      }),
      listDirectory: mock(async () => null),
    };

    const result = await callOpenAIWithClient(client, MODEL, "system", "user", tools);
    // The loop recovers and continues; final text is from the second round.
    expect(result.text).toBe("recovered");

    // The tool-call result carries an envelope, not a raw `Error: …` string.
    expect(JSON.parse(extractToolMessageContent(capturedMessages[1]))).toEqual({
      ok: false,
      error: "network error",
    });
  });

  test("with tools: unknown tool name → unknown_tool error envelope", async () => {
    const { client, capturedMessages } = makeFakeClient([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_bogus",
                  type: "function",
                  function: { name: "bogus_tool", arguments: JSON.stringify({ path: "x" }) },
                },
              ],
            },
          },
        ],
        usage: makeUsage(),
      },
      {
        choices: [{ message: { content: "carried on" } }],
        usage: makeUsage(),
      },
    ]);

    const tools: ReviewerToolContext = {
      readFile: mock(async () => null),
      listDirectory: mock(async () => null),
    };

    await callOpenAIWithClient(client, MODEL, "system", "user", tools);

    expect(JSON.parse(extractToolMessageContent(capturedMessages[1]))).toEqual({
      ok: false,
      error: "unknown_tool: bogus_tool",
    });
  });

  test("single-turn without tools: uses no tool definitions", async () => {
    let capturedParams: Record<string, unknown> = {};
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            capturedParams = params;
            return {
              choices: [{ message: { content: "plain review" } }],
              usage: makeUsage(),
            };
          },
        },
      },
    } as unknown as OpenAI;

    await callOpenAIWithClient(client, MODEL, "system", "user");
    // No tools parameter should be sent to the API in no-tools mode.
    expect(capturedParams.tools).toBeUndefined();
  });
});
