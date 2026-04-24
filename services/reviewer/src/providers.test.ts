import { describe, expect, test, mock } from "bun:test";
import { isReasoningModel, callOpenAIWithClient } from "./providers";
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

  /** Build a fake OpenAI client whose completions.create cycles through the given responses. */
  function makeFakeClient(
    responses: Array<{
      choices: Array<{ message: { content: string | null; tool_calls?: unknown[] } }>;
      usage?: ReturnType<typeof makeUsage>;
    }>
  ): OpenAI {
    let callCount = 0;
    return {
      chat: {
        completions: {
          create: async () => responses[callCount++],
        },
      },
    } as unknown as OpenAI;
  }

  test("single-turn: returns text immediately when no tool calls", async () => {
    const client = makeFakeClient([
      { choices: [{ message: { content: "review text" } }], usage: makeUsage() },
    ]);
    const result = await callOpenAIWithClient(client, MODEL, "system", "user");
    expect(result.text).toBe("review text");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe(MODEL);
  });

  test("with tools: performs read_file call then returns final text", async () => {
    const client = makeFakeClient([
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

    const readFileMock = mock(async (_path: string) => "file contents here");
    const tools: ReviewerToolContext = {
      readFile: readFileMock,
      listDirectory: mock(async () => null),
    };

    const result = await callOpenAIWithClient(client, MODEL, "system", "user", tools);
    expect(result.text).toBe("final review");
    expect(readFileMock).toHaveBeenCalledWith("src/foo.ts");
    // Tokens are accumulated across rounds.
    expect(result.usage?.promptTokens).toBe(500); // 200 + 300
    expect(result.usage?.completionTokens).toBe(90); // 30 + 60
  });

  test("with tools: list_directory tool calls flow through", async () => {
    const client = makeFakeClient([
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

    const listDirectoryMock = mock(async (_path: string) => [
      { name: "index.ts", type: "file" as const },
    ]);
    const tools: ReviewerToolContext = {
      readFile: mock(async () => null),
      listDirectory: listDirectoryMock,
    };

    const result = await callOpenAIWithClient(client, MODEL, "system", "user", tools);
    expect(result.text).toBe("dir review");
    expect(listDirectoryMock).toHaveBeenCalledWith("src");
  });

  test("with tools: tool errors are returned as error strings (not thrown)", async () => {
    const client = makeFakeClient([
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
    // The loop should recover and continue; final text is from the second round.
    expect(result.text).toBe("recovered");
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
