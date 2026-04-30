import { describe, expect, test, mock } from "bun:test";
import {
  isReasoningModel,
  callOpenAIWithClient,
  buildReadFileEnvelope,
  buildListDirectoryEnvelope,
} from "./providers";
import type OpenAI from "openai";
import type { ReviewerToolContext } from "./tools";
import type { ReviewToolCall } from "./output-tools";

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

// ----- Token budget and reasoning_effort selection (mt#1232) -----
//
// Verifies that the tools-active path uses a larger token budget and lower
// reasoning effort to prevent reasoning tokens from crowding out tool-call JSON.

describe("callOpenAIWithClient token budget and reasoning_effort (mt#1232)", () => {
  const REASONING_MODEL = "gpt-5";
  const NON_REASONING_MODEL = "gpt-4o";

  const makeUsage = (prompt = 100, completion = 50) => ({
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    completion_tokens_details: { reasoning_tokens: 0 },
  });

  function makeSingleCaptureClient(): {
    client: OpenAI;
    capturedParams: () => Record<string, unknown>;
  } {
    let lastParams: Record<string, unknown> = {};
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            lastParams = { ...params };
            return {
              choices: [{ message: { content: "review text", tool_calls: undefined } }],
              usage: makeUsage(),
            };
          },
        },
      },
    } as unknown as OpenAI;
    return { client, capturedParams: () => lastParams };
  }

  test("no-tools path: sends max_completion_tokens:16384 (reasoning model)", async () => {
    const { client, capturedParams } = makeSingleCaptureClient();
    await callOpenAIWithClient(client, REASONING_MODEL, "system", "user");
    expect(capturedParams().max_completion_tokens).toBe(16384);
  });

  test("no-tools path: sends reasoning_effort:'medium' by default (reasoning model)", async () => {
    const { client, capturedParams } = makeSingleCaptureClient();
    await callOpenAIWithClient(client, REASONING_MODEL, "system", "user");
    expect(capturedParams().reasoning_effort).toBe("medium");
  });

  test("no-tools path: does not send reasoning_effort for non-reasoning model", async () => {
    const { client, capturedParams } = makeSingleCaptureClient();
    await callOpenAIWithClient(client, NON_REASONING_MODEL, "system", "user");
    expect(capturedParams().reasoning_effort).toBeUndefined();
  });

  test("no-tools path: max_completion_tokens:16384 even for non-reasoning model", async () => {
    const { client, capturedParams } = makeSingleCaptureClient();
    await callOpenAIWithClient(client, NON_REASONING_MODEL, "system", "user");
    expect(capturedParams().max_completion_tokens).toBe(16384);
  });

  test("tools-active path: sends max_completion_tokens:32768 on first round (reasoning model)", async () => {
    const allCaptured: Array<Record<string, unknown>> = [];
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            allCaptured.push({ ...params });
            return {
              choices: [{ message: { content: "review text", tool_calls: undefined } }],
              usage: makeUsage(),
            };
          },
        },
      },
    } as unknown as OpenAI;

    const tools: ReviewerToolContext = {
      readFile: mock(async () => null),
      listDirectory: mock(async () => null),
    };

    await callOpenAIWithClient(client, REASONING_MODEL, "system", "user", tools);
    expect(allCaptured[0]?.max_completion_tokens).toBe(32768);
  });

  test("tools-active path: sends reasoning_effort:'low' by default (reasoning model)", async () => {
    const allCaptured: Array<Record<string, unknown>> = [];
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            allCaptured.push({ ...params });
            return {
              choices: [{ message: { content: "review text", tool_calls: undefined } }],
              usage: makeUsage(),
            };
          },
        },
      },
    } as unknown as OpenAI;

    const tools: ReviewerToolContext = {
      readFile: mock(async () => null),
      listDirectory: mock(async () => null),
    };

    await callOpenAIWithClient(client, REASONING_MODEL, "system", "user", tools);
    expect(allCaptured[0]?.reasoning_effort).toBe("low");
  });

  test("tools-active path: caller-supplied reasoningEffort overrides default 'low'", async () => {
    const allCaptured: Array<Record<string, unknown>> = [];
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            allCaptured.push({ ...params });
            return {
              choices: [{ message: { content: "review text", tool_calls: undefined } }],
              usage: makeUsage(),
            };
          },
        },
      },
    } as unknown as OpenAI;

    const tools: ReviewerToolContext = {
      readFile: mock(async () => null),
      listDirectory: mock(async () => null),
    };

    await callOpenAIWithClient(client, REASONING_MODEL, "system", "user", tools, {
      reasoningEffort: "high",
    });
    expect(allCaptured[0]?.reasoning_effort).toBe("high");
  });

  test("no-tools path: caller-supplied reasoningEffort overrides default 'medium'", async () => {
    const { client, capturedParams } = makeSingleCaptureClient();
    await callOpenAIWithClient(client, REASONING_MODEL, "system", "user", undefined, {
      reasoningEffort: "low",
    });
    expect(capturedParams().reasoning_effort).toBe("low");
  });
});

// ----- Output tool accumulation (mt#1399) -----
//
// Verifies that output tool calls (submit_finding, conclude_review, etc.) are
// parsed, accumulated, and returned in output.toolCalls — separately from the
// read-only tools (read_file, list_directory) which are executed and NOT added
// to toolCalls.

describe("callOpenAIWithClient output tool accumulation (mt#1399)", () => {
  const MODEL = "gpt-4o";

  const makeUsage = (prompt = 100, completion = 50) => ({
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    completion_tokens_details: { reasoning_tokens: 0 },
  });

  const VALID_FINDING_ARGS = JSON.stringify({
    severity: "BLOCKING",
    file: "src/foo.ts",
    line: 42,
    summary: "Missing null check",
    details: "The variable may be null here.",
  });

  const VALID_CONCLUDE_ARGS = JSON.stringify({
    event: "REQUEST_CHANGES",
    summary: "Found blocking issues.",
  });

  function makeOutputToolCall(id: string, name: string, argsJson: string) {
    return {
      id,
      type: "function",
      function: { name, arguments: argsJson },
    };
  }

  function makeFakeClient(
    responses: Array<{
      choices: Array<{ message: { content: string | null; tool_calls?: unknown[] } }>;
      usage?: ReturnType<typeof makeUsage>;
    }>
  ): { client: OpenAI } {
    let callCount = 0;
    const client = {
      chat: {
        completions: {
          create: async (_params: { messages: unknown[] }) => {
            return responses[callCount++];
          },
        },
      },
    } as unknown as OpenAI;
    return { client };
  }

  const defaultTools: ReviewerToolContext = {
    readFile: mock(async () => null),
    listDirectory: mock(async () => null),
  };

  test("submit_finding x3 + conclude_review x1 → toolCalls has 4 entries in order", async () => {
    const { client } = makeFakeClient([
      // Round 1: three submit_finding calls
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                makeOutputToolCall("c1", "submit_finding", VALID_FINDING_ARGS),
                makeOutputToolCall("c2", "submit_finding", VALID_FINDING_ARGS),
                makeOutputToolCall("c3", "submit_finding", VALID_FINDING_ARGS),
              ],
            },
          },
        ],
        usage: makeUsage(),
      },
      // Round 2: conclude_review
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [makeOutputToolCall("c4", "conclude_review", VALID_CONCLUDE_ARGS)],
            },
          },
        ],
        usage: makeUsage(),
      },
      // Round 3: final text response
      {
        choices: [{ message: { content: "review summary" } }],
        usage: makeUsage(),
      },
    ]);

    const result = await callOpenAIWithClient(client, MODEL, "system", "user", defaultTools);

    expect(result.toolCalls).toHaveLength(4);
    expect(result.toolCalls[0]?.name).toBe("submit_finding");
    expect(result.toolCalls[1]?.name).toBe("submit_finding");
    expect(result.toolCalls[2]?.name).toBe("submit_finding");
    expect(result.toolCalls[3]?.name).toBe("conclude_review");
  });

  test("no output tools emitted → toolCalls is empty array (never undefined)", async () => {
    const { client } = makeFakeClient([
      {
        choices: [{ message: { content: "plain text review" } }],
        usage: makeUsage(),
      },
    ]);

    const result = await callOpenAIWithClient(client, MODEL, "system", "user", defaultTools);

    expect(result.toolCalls).toBeDefined();
    expect(Array.isArray(result.toolCalls)).toBe(true);
    expect(result.toolCalls).toHaveLength(0);
  });

  test("read_file interleaved with submit_finding → toolCalls contains only submit_finding entries", async () => {
    const { client } = makeFakeClient([
      // Round 1: read_file + submit_finding + conclude_review interleaved.
      // conclude_review is included so the reminder mechanism does not fire
      // (a well-behaved model emits conclude_review as its terminator).
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "rf1",
                  type: "function",
                  function: { name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) },
                },
                makeOutputToolCall("sf1", "submit_finding", VALID_FINDING_ARGS),
                makeOutputToolCall("cr1", "conclude_review", VALID_CONCLUDE_ARGS),
              ],
            },
          },
        ],
        usage: makeUsage(),
      },
      // Round 2: final text
      {
        choices: [{ message: { content: "done" } }],
        usage: makeUsage(),
      },
    ]);

    const toolsWithReadFile: ReviewerToolContext = {
      readFile: mock(async () => ({
        kind: "text" as const,
        content: "contents",
        truncated: false,
      })),
      listDirectory: mock(async () => null),
    };

    const result = await callOpenAIWithClient(client, MODEL, "system", "user", toolsWithReadFile);

    // Only submit_finding and conclude_review should be in toolCalls — not read_file.
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]?.name).toBe("submit_finding");
    expect(result.toolCalls[1]?.name).toBe("conclude_review");
  });

  test("malformed output tool args → parse error logged, call not added, subsequent valid calls recorded", async () => {
    const MALFORMED_ARGS = JSON.stringify({ severity: "URGENT", file: "src/b.ts", line: 1 });

    const { client } = makeFakeClient([
      // Round 1: malformed submit_finding, then a valid one, then conclude_review.
      // conclude_review is included so the reminder mechanism does not fire
      // (a well-behaved model emits conclude_review as its terminator).
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                makeOutputToolCall("bad1", "submit_finding", MALFORMED_ARGS),
                makeOutputToolCall("good1", "submit_finding", VALID_FINDING_ARGS),
                makeOutputToolCall("cr1", "conclude_review", VALID_CONCLUDE_ARGS),
              ],
            },
          },
        ],
        usage: makeUsage(),
      },
      // Round 2: final text
      {
        choices: [{ message: { content: "recovered" } }],
        usage: makeUsage(),
      },
    ]);

    const result = await callOpenAIWithClient(client, MODEL, "system", "user", defaultTools);

    // Malformed call is NOT in toolCalls; the valid finding and conclude_review are.
    expect(result.toolCalls).toHaveLength(2);
    expect((result.toolCalls[0] as ReviewToolCall).name).toBe("submit_finding");
    expect((result.toolCalls[1] as ReviewToolCall).name).toBe("conclude_review");

    // Loop continues; final text is returned.
    expect(result.text).toBe("recovered");
  });

  test("no-tools path: toolCalls is empty array (never undefined)", async () => {
    const { client } = makeFakeClient([
      {
        choices: [{ message: { content: "no tools" } }],
        usage: makeUsage(),
      },
    ]);

    // Call without tools context — no tool use loop at all.
    const result = await callOpenAIWithClient(client, MODEL, "system", "user");

    expect(result.toolCalls).toBeDefined();
    expect(Array.isArray(result.toolCalls)).toBe(true);
    expect(result.toolCalls).toHaveLength(0);
  });
});

// ----- conclude_review reminder mechanism (mt#1450) -----
//
// Verifies that the loop-side reminder fires when the model exits without
// emitting conclude_review, and that structured log entries are emitted with
// the correct finally_emitted value.

describe("callOpenAIWithClient conclude_review reminder (mt#1450)", () => {
  const MODEL = "gpt-5";
  const CONCLUDE_REVIEW_REMINDER_EVENT = "reviewer.conclude_review_reminder";

  const makeUsage = (prompt = 100, completion = 50) => ({
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    completion_tokens_details: { reasoning_tokens: 0 },
  });

  const VALID_FINDING_ARGS = JSON.stringify({
    severity: "BLOCKING",
    file: "src/foo.ts",
    line: 10,
    summary: "Null deref",
    details: "May crash at runtime.",
  });

  const VALID_CONCLUDE_ARGS = JSON.stringify({
    event: "REQUEST_CHANGES",
    summary: "Found blocking issues.",
  });

  function makeOutputToolCall(id: string, name: string, argsJson: string) {
    return {
      id,
      type: "function",
      function: { name, arguments: argsJson },
    };
  }

  function makeFakeClient(
    responses: Array<{
      choices: Array<{ message: { content: string | null; tool_calls?: unknown[] } }>;
      usage?: ReturnType<typeof makeUsage>;
    }>
  ): { client: OpenAI } {
    let callCount = 0;
    const client = {
      chat: {
        completions: {
          create: async (_params: { messages: unknown[] }) => {
            return responses[callCount++];
          },
        },
      },
    } as unknown as OpenAI;
    return { client };
  }

  const defaultTools: ReviewerToolContext = {
    readFile: mock(async () => null),
    listDirectory: mock(async () => null),
  };

  test("reminder fires once with finally_emitted:true when model emits conclude_review after reminder", async () => {
    // Capture console.log calls to verify structured log output.
    const loggedEvents: unknown[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => {
      try {
        loggedEvents.push(JSON.parse(msg));
      } catch {
        originalLog(msg);
      }
    };

    try {
      const { client } = makeFakeClient([
        // Round 0: 3 submit_finding calls
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  makeOutputToolCall("c1", "submit_finding", VALID_FINDING_ARGS),
                  makeOutputToolCall("c2", "submit_finding", VALID_FINDING_ARGS),
                  makeOutputToolCall("c3", "submit_finding", VALID_FINDING_ARGS),
                ],
              },
            },
          ],
          usage: makeUsage(),
        },
        // Round 1: no tool calls — would normally terminate, triggers reminder
        {
          choices: [{ message: { content: "Done reviewing.", tool_calls: undefined } }],
          usage: makeUsage(),
        },
        // Round 2: model responds to reminder with conclude_review
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [makeOutputToolCall("c4", "conclude_review", VALID_CONCLUDE_ARGS)],
              },
            },
          ],
          usage: makeUsage(),
        },
        // Round 3: final text response after conclude_review
        {
          choices: [{ message: { content: "Review complete." } }],
          usage: makeUsage(),
        },
      ]);

      const result = await callOpenAIWithClient(client, MODEL, "system", "user", defaultTools);

      // All 4 tool calls (3 findings + 1 conclude_review) must be in output.
      expect(result.toolCalls).toHaveLength(4);
      expect(result.toolCalls[0]?.name).toBe("submit_finding");
      expect(result.toolCalls[1]?.name).toBe("submit_finding");
      expect(result.toolCalls[2]?.name).toBe("submit_finding");
      expect(result.toolCalls[3]?.name).toBe("conclude_review");

      // Exactly one reminder log, with finally_emitted: true.
      const reminderLogs = loggedEvents.filter(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          (e as Record<string, unknown>)["event"] === CONCLUDE_REVIEW_REMINDER_EVENT
      );
      expect(reminderLogs).toHaveLength(1);
      const reminderLog = reminderLogs[0] as Record<string, unknown>;
      expect(reminderLog["provider"]).toBe("openai");
      expect(reminderLog["reminder_count"]).toBe(1);
      expect(reminderLog["finally_emitted"]).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  test("reminder fires twice with finally_emitted:false when model refuses conclude_review both times", async () => {
    const loggedEvents: unknown[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => {
      try {
        loggedEvents.push(JSON.parse(msg));
      } catch {
        originalLog(msg);
      }
    };

    try {
      const { client } = makeFakeClient([
        // Round 0: 3 submit_finding calls
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  makeOutputToolCall("c1", "submit_finding", VALID_FINDING_ARGS),
                  makeOutputToolCall("c2", "submit_finding", VALID_FINDING_ARGS),
                  makeOutputToolCall("c3", "submit_finding", VALID_FINDING_ARGS),
                ],
              },
            },
          ],
          usage: makeUsage(),
        },
        // Round 1: no tool calls — first exit attempt, triggers reminder #1
        {
          choices: [{ message: { content: "Done.", tool_calls: undefined } }],
          usage: makeUsage(),
        },
        // Round 2: no tool calls again — refuses reminder #1, triggers reminder #2
        {
          choices: [{ message: { content: "Still done.", tool_calls: undefined } }],
          usage: makeUsage(),
        },
        // Round 3: no tool calls again — refuses reminder #2, loop terminates
        {
          choices: [{ message: { content: "Final text." } }],
          usage: makeUsage(),
        },
      ]);

      const result = await callOpenAIWithClient(client, MODEL, "system", "user", defaultTools);

      // Only 3 findings in toolCalls — conclude_review was never emitted.
      expect(result.toolCalls).toHaveLength(3);
      expect(result.toolCalls.every((tc) => tc.name === "submit_finding")).toBe(true);

      // Exactly 2 reminder logs, both with finally_emitted: false.
      const reminderLogs = loggedEvents.filter(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          (e as Record<string, unknown>)["event"] === CONCLUDE_REVIEW_REMINDER_EVENT
      );
      expect(reminderLogs).toHaveLength(2);

      const first = reminderLogs[0] as Record<string, unknown>;
      expect(first["reminder_count"]).toBe(1);
      expect(first["finally_emitted"]).toBe(false);

      const second = reminderLogs[1] as Record<string, unknown>;
      expect(second["reminder_count"]).toBe(2);
      expect(second["finally_emitted"]).toBe(false);
    } finally {
      console.log = originalLog;
    }
  });

  test("no reminder fires when model emits conclude_review proactively", async () => {
    const loggedEvents: unknown[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => {
      try {
        loggedEvents.push(JSON.parse(msg));
      } catch {
        originalLog(msg);
      }
    };

    try {
      const { client } = makeFakeClient([
        // Round 0: 3 findings + conclude_review all in one turn
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  makeOutputToolCall("c1", "submit_finding", VALID_FINDING_ARGS),
                  makeOutputToolCall("c2", "submit_finding", VALID_FINDING_ARGS),
                  makeOutputToolCall("c3", "submit_finding", VALID_FINDING_ARGS),
                  makeOutputToolCall("c4", "conclude_review", VALID_CONCLUDE_ARGS),
                ],
              },
            },
          ],
          usage: makeUsage(),
        },
        // Round 1: final text after conclude_review
        {
          choices: [{ message: { content: "Review done." } }],
          usage: makeUsage(),
        },
      ]);

      const result = await callOpenAIWithClient(client, MODEL, "system", "user", defaultTools);

      expect(result.toolCalls).toHaveLength(4);
      expect(result.toolCalls[3]?.name).toBe("conclude_review");

      // No reminder logs at all.
      const reminderLogs = loggedEvents.filter(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          (e as Record<string, unknown>)["event"] === CONCLUDE_REVIEW_REMINDER_EVENT
      );
      expect(reminderLogs).toHaveLength(0);
    } finally {
      console.log = originalLog;
    }
  });
});
