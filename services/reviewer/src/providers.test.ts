/* eslint-disable max-lines -- test file covers the full OpenAI tool-loop + forced-pass surface */
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
import { captureConsoleLogs } from "./test-helpers/log-capture";

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
    // mt#1086: tool calls now receive (path, signal?) — assert the path
    // arg only; signal is an internal cancellation plumbing detail.
    expect(readFileMock.mock.calls[0]?.[0]).toBe("src/foo.ts");

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
    // mt#1086: tool calls now receive (path, signal?) — assert path only.
    expect(listDirectoryMock.mock.calls[0]?.[0]).toBe("src");

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
      // conclude_review is included so the post-loop forced pass does not fire
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
      // conclude_review is included so the post-loop forced pass does not fire
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

// ----- conclude_review post-loop forced pass (mt#1450 / mt#1471) -----
//
// mt#1450 introduced an in-loop conclude_review reminder gated on
// `!isLastRound`. Live re-verification on 2026-04-30 showed the reminder
// fired only 1/15 times because the dominant production failure mode was
// the loop exhausting its round budget on read_file calls and exiting via
// round 9's forced text-only response — at which point the in-loop trigger
// could not fire.
//
// mt#1471 replaces the in-loop reminder with a single post-loop forced
// conclude_review pass that uses `tool_choice` to constrain the model to
// emit conclude_review. The pass is decoupled from the loop's round budget,
// fires on any exit path that ended with output tool calls but no
// conclude_review, and does not retry. Composition-side severity-derived
// event recovery (mt#1413) remains the safety net if the forced pass fails
// to produce a parseable conclude_review.

describe("callOpenAIWithClient conclude_review post-loop forced pass (mt#1471)", () => {
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

  const TOOL_DOC_IMPACT = "submit_documentation_impact";
  const GATE_BRANCH_NO_CONCLUDE = "emitted_no_conclude";

  const VALID_DOC_IMPACT_ARGS = JSON.stringify({
    kind: "no-update-needed",
    evidence: "Internal refactor, no docs affected.",
  });

  function makeOutputToolCall(id: string, name: string, argsJson: string) {
    return {
      id,
      type: "function",
      function: { name, arguments: argsJson },
    };
  }

  function docImpactForcedResponse() {
    return {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [makeOutputToolCall("di1", TOOL_DOC_IMPACT, VALID_DOC_IMPACT_ARGS)],
          },
        },
      ],
      usage: makeUsage(),
    };
  }

  /** Build a fake OpenAI client that cycles responses and captures requests. */
  function makeFakeClient(
    responses: Array<{
      choices: Array<{ message: { content: string | null; tool_calls?: unknown[] } }>;
      usage?: ReturnType<typeof makeUsage>;
    }>
  ): { client: OpenAI; capturedParams: Array<Record<string, unknown>> } {
    let callCount = 0;
    const capturedParams: Array<Record<string, unknown>> = [];
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            capturedParams.push({ ...params });
            return responses[callCount++];
          },
        },
      },
    } as unknown as OpenAI;
    return { client, capturedParams };
  }

  const defaultTools: ReviewerToolContext = {
    readFile: mock(async () => null),
    listDirectory: mock(async () => null),
  };

  /**
   * Capture log lines emitted by the reviewer-local winston logger during
   * `fn`, parse each line as JSON, and pass the resulting events array to the
   * caller. Lines that fail JSON.parse are silently skipped.
   */
  async function withCapturedLogs<T>(
    fn: (events: unknown[]) => Promise<T>
  ): Promise<{ events: unknown[]; result: T }> {
    const events: unknown[] = [];
    const { logs, restore } = captureConsoleLogs();
    try {
      const result = await fn(events);
      for (const line of logs) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // Non-JSON line — skip (consistent with prior behavior).
        }
      }
      return { events, result };
    } finally {
      restore();
    }
  }

  test("emits conclude_review via post-loop forced pass when model exits early without it", async () => {
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
      // Round 1: model emits no tool calls — loop exits early without conclude_review
      {
        choices: [{ message: { content: "Done reviewing.", tool_calls: undefined } }],
        usage: makeUsage(),
      },
      docImpactForcedResponse(), // mt#2115
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
    ]);

    const { events, result } = await withCapturedLogs(async () =>
      callOpenAIWithClient(client, MODEL, "system", "user", defaultTools)
    );

    // All 5 tool calls (3 findings + 1 doc_impact + 1 conclude_review) end up in output.
    expect(result.toolCalls).toHaveLength(5);
    expect(result.toolCalls[0]?.name).toBe("submit_finding");
    expect(result.toolCalls[4]?.name).toBe("conclude_review");

    const reminderLogs = events.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>)["event"] === CONCLUDE_REVIEW_REMINDER_EVENT
    );
    expect(reminderLogs).toHaveLength(1);
    const log = reminderLogs[0] as Record<string, unknown>;
    expect(log["provider"]).toBe("openai");
    expect(log["reminder_count"]).toBe(1);
    expect(log["finally_emitted"]).toBe(true);
    expect(log["fired_at_turn"]).toBe(2); // fired after 2 main-loop rounds (the forced pass itself is the 3rd API call)
  });

  test("post-loop forced pass uses tool_choice constrained to conclude_review", async () => {
    const { client, capturedParams } = makeFakeClient([
      // Round 0: 1 finding
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [makeOutputToolCall("c1", "submit_finding", VALID_FINDING_ARGS)],
            },
          },
        ],
        usage: makeUsage(),
      },
      // Round 1: empty exit
      {
        choices: [{ message: { content: "Done.", tool_calls: undefined } }],
        usage: makeUsage(),
      },
      docImpactForcedResponse(), // mt#2115
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [makeOutputToolCall("c2", "conclude_review", VALID_CONCLUDE_ARGS)],
            },
          },
        ],
        usage: makeUsage(),
      },
    ]);

    await withCapturedLogs(async () =>
      callOpenAIWithClient(client, MODEL, "system", "user", defaultTools)
    );

    // Four API calls: 2 main-loop rounds + 1 doc-impact forced + 1 conclude forced.
    expect(capturedParams).toHaveLength(4);

    const forcedCallParams = capturedParams[3];
    expect(forcedCallParams).toBeDefined();

    // The conclude forced call constrains tool_choice to conclude_review.
    expect(forcedCallParams?.tool_choice).toEqual({
      type: "function",
      function: { name: "conclude_review" },
    });

    // The conclude forced call only registers conclude_review.
    const forcedTools = forcedCallParams?.tools as Array<{ function: { name: string } }>;
    expect(Array.isArray(forcedTools)).toBe(true);
    expect(forcedTools).toHaveLength(1);
    expect(forcedTools[0]?.function.name).toBe("conclude_review");

    // The doc-impact forced call (index 2) constrains to submit_documentation_impact.
    const docImpactCallParams = capturedParams[2];
    expect(docImpactCallParams?.tool_choice).toEqual({
      type: "function",
      function: { name: TOOL_DOC_IMPACT },
    });

    // The conclude forced call's messages include the user reminder as the last message.
    const forcedMessages = forcedCallParams?.messages as Array<{
      role: string;
      content: string;
    }>;
    const lastMessage = forcedMessages[forcedMessages.length - 1];
    expect(lastMessage?.role).toBe("user");
    expect(typeof lastMessage?.content).toBe("string");
    expect(lastMessage?.content).toContain("conclude_review");
  });

  test("post-loop forced pass: log finally_emitted:false when model returns no conclude_review", async () => {
    const { client } = makeFakeClient([
      // Round 0: 2 findings
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                makeOutputToolCall("c1", "submit_finding", VALID_FINDING_ARGS),
                makeOutputToolCall("c2", "submit_finding", VALID_FINDING_ARGS),
              ],
            },
          },
        ],
        usage: makeUsage(),
      },
      // Round 1: empty exit
      {
        choices: [{ message: { content: "All done.", tool_calls: undefined } }],
        usage: makeUsage(),
      },
      docImpactForcedResponse(), // mt#2115
      // Post-loop forced pass: model returns no tool calls (rare under
      // tool_choice constraint, but defensive)
      {
        choices: [{ message: { content: "Refused.", tool_calls: undefined } }],
        usage: makeUsage(),
      },
    ]);

    const { events, result } = await withCapturedLogs(async () =>
      callOpenAIWithClient(client, MODEL, "system", "user", defaultTools)
    );

    // 2 findings + 1 doc_impact; no conclude_review was emitted.
    expect(result.toolCalls).toHaveLength(3);
    expect(result.toolCalls.filter((tc) => tc.name === "submit_finding")).toHaveLength(2);
    expect(result.toolCalls.filter((tc) => tc.name === TOOL_DOC_IMPACT)).toHaveLength(1);

    const reminderLogs = events.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>)["event"] === CONCLUDE_REVIEW_REMINDER_EVENT
    );
    // Single forced-pass log with finally_emitted: false (no retries in new design).
    expect(reminderLogs).toHaveLength(1);
    const log = reminderLogs[0] as Record<string, unknown>;
    expect(log["reminder_count"]).toBe(1);
    expect(log["finally_emitted"]).toBe(false);
  });

  test("post-loop forced pass: log finally_emitted:false when conclude_review args are malformed", async () => {
    const MALFORMED_CONCLUDE_ARGS = JSON.stringify({ event: "INVALID_EVENT", summary: "x" });

    const { client } = makeFakeClient([
      // Round 0: 1 finding
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [makeOutputToolCall("c1", "submit_finding", VALID_FINDING_ARGS)],
            },
          },
        ],
        usage: makeUsage(),
      },
      // Round 1: empty exit
      {
        choices: [{ message: { content: "Done.", tool_calls: undefined } }],
        usage: makeUsage(),
      },
      docImpactForcedResponse(), // mt#2115
      // Post-loop forced pass: returns conclude_review with malformed args
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [makeOutputToolCall("c2", "conclude_review", MALFORMED_CONCLUDE_ARGS)],
            },
          },
        ],
        usage: makeUsage(),
      },
    ]);

    const { events, result } = await withCapturedLogs(async () =>
      callOpenAIWithClient(client, MODEL, "system", "user", defaultTools)
    );

    // 1 finding + 1 doc_impact; malformed conclude_review is NOT appended.
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]?.name).toBe("submit_finding");

    const reminderLogs = events.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>)["event"] === CONCLUDE_REVIEW_REMINDER_EVENT
    );
    expect(reminderLogs).toHaveLength(1);
    const log = reminderLogs[0] as Record<string, unknown>;
    expect(log["finally_emitted"]).toBe(false);
  });

  test("no forced pass when model emits conclude_review proactively in main loop", async () => {
    const { client, capturedParams } = makeFakeClient([
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
      docImpactForcedResponse(), // mt#2115 — no doc-impact in main loop
    ]);

    const { events, result } = await withCapturedLogs(async () =>
      callOpenAIWithClient(client, MODEL, "system", "user", defaultTools)
    );

    expect(result.toolCalls).toHaveLength(5);
    expect(result.toolCalls[3]?.name).toBe("conclude_review");
    expect(result.toolCalls[4]?.name).toBe(TOOL_DOC_IMPACT);

    // 2 main-loop calls + 1 doc-impact forced pass; no conclude forced pass.
    expect(capturedParams).toHaveLength(3);

    // No conclude_review reminder logs (it was emitted proactively).
    const reminderLogs = events.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>)["event"] === CONCLUDE_REVIEW_REMINDER_EVENT
    );
    expect(reminderLogs).toHaveLength(0);
  });

  test("forced pass fires (emitted_nothing branch) when no main-loop output tools (mt#1639 + mt#2115)", async () => {
    // Main-loop emitted nothing; gate_branch uses mainLoopOutputCount snapshot.
    const { client, capturedParams } = makeFakeClient([
      // Round 0: read_file call (no output tools)
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
              ],
            },
          },
        ],
        usage: makeUsage(),
      },
      // Round 1: empty exit, no output tools were used
      {
        choices: [{ message: { content: "Nothing to review.", tool_calls: undefined } }],
        usage: makeUsage(),
      },
      docImpactForcedResponse(), // mt#2115
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                makeOutputToolCall(
                  "cr1",
                  "conclude_review",
                  JSON.stringify({ event: "COMMENT", summary: "No issues found." })
                ),
              ],
            },
          },
        ],
        usage: makeUsage(),
      },
    ]);

    const tools: ReviewerToolContext = {
      readFile: mock(async () => ({ kind: "text" as const, content: "x", truncated: false })),
      listDirectory: mock(async () => null),
    };

    const { events, result } = await withCapturedLogs(async () =>
      callOpenAIWithClient(client, MODEL, "system", "user", tools)
    );

    // doc_impact + conclude_review emitted by forced passes.
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]?.name).toBe(TOOL_DOC_IMPACT);
    expect(result.toolCalls[1]?.name).toBe("conclude_review");

    // 4 API calls total: 2 main-loop + 1 doc-impact forced + 1 conclude forced.
    expect(capturedParams).toHaveLength(4);

    // The conclude forced call constrains tool_choice to conclude_review.
    const forcedCallParams = capturedParams[3];
    expect(forcedCallParams?.tool_choice).toEqual({
      type: "function",
      function: { name: "conclude_review" },
    });

    // Forced pass uses conclude_review-only tool list.
    const forcedTools = forcedCallParams?.tools as Array<{ function: { name: string } }>;
    expect(Array.isArray(forcedTools)).toBe(true);
    expect(forcedTools).toHaveLength(1);
    expect(forcedTools[0]?.function.name).toBe("conclude_review");

    const reminderLogs = events.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>)["event"] === CONCLUDE_REVIEW_REMINDER_EVENT
    );
    // gate_branch uses mainLoopOutputCount snapshot — main loop emitted nothing.
    expect(reminderLogs).toHaveLength(1);
    const log = reminderLogs[0] as Record<string, unknown>;
    expect(log["finally_emitted"]).toBe(true);
    expect(log["gate_branch"]).toBe("emitted_nothing");
    expect(log["reminder_count"]).toBe(1);
    expect(log["fired_at_turn"]).toBe(2);
  });

  test("post-loop forced pass fires when main loop exhausts MAX_TOOL_ROUNDS without conclude_review (production failure mode)", async () => {
    // Reproduces the dominant production failure mode that mt#1450's in-loop
    // reminder did not handle: the model keeps making tool calls (mostly
    // failing read_file probes) for all 10 main-loop rounds, never exiting
    // voluntarily and never emitting conclude_review. On round 9 the loop
    // forces text-only mode, the model returns text, and the loop ends.
    //
    // The new post-loop forced pass MUST fire here because the gate is
    // (!hasConcludeReview && hasEmittedOutputCalls), independent of how the
    // loop ended.

    // Build 10 main-loop responses: each round emits a read_file call
    // (rounds 1-3, 5-6, 8) or a submit_finding (rounds 0, 4, 7 — to ensure
    // accumulatedToolCalls.length > 0). Round 9 has no tools passed by the
    // implementation, so the model can't emit tool calls — return text-only.
    const mainLoopResponses = [];
    for (let i = 0; i < 9; i++) {
      // Mix in submit_findings on a few rounds so hasEmittedOutputCalls=true.
      if (i === 0 || i === 4 || i === 7) {
        mainLoopResponses.push({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [makeOutputToolCall(`sf${i}`, "submit_finding", VALID_FINDING_ARGS)],
              },
            },
          ],
          usage: makeUsage(),
        });
      } else {
        mainLoopResponses.push({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: `rf${i}`,
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({ path: `src/path${i}.ts` }),
                    },
                  },
                ],
              },
            },
          ],
          usage: makeUsage(),
        });
      }
    }

    // Round 9 (the last round): tools NOT passed by the implementation.
    // The fake just returns text; the production loop can't emit tool calls
    // because tool_choice is omitted on the last round.
    mainLoopResponses.push({
      choices: [{ message: { content: "Done.", tool_calls: undefined } }],
      usage: makeUsage(),
    });

    mainLoopResponses.push(docImpactForcedResponse()); // mt#2115
    mainLoopResponses.push({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [makeOutputToolCall("cr", "conclude_review", VALID_CONCLUDE_ARGS)],
          },
        },
      ],
      usage: makeUsage(),
    });

    const { client, capturedParams } = makeFakeClient(mainLoopResponses);

    const { events, result } = await withCapturedLogs(async () =>
      callOpenAIWithClient(client, MODEL, "system", "user", defaultTools)
    );

    // 12 API calls total: 10 main-loop + 1 doc-impact forced + 1 conclude forced.
    expect(capturedParams).toHaveLength(12);

    // 3 findings + 1 doc_impact + 1 conclude_review.
    expect(result.toolCalls).toHaveLength(5);
    expect(result.toolCalls.filter((tc) => tc.name === "submit_finding")).toHaveLength(3);
    expect(result.toolCalls[4]?.name).toBe("conclude_review");

    // Forced-pass reminder log present and finally_emitted:true.
    const reminderLogs = events.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>)["event"] === CONCLUDE_REVIEW_REMINDER_EVENT
    );
    expect(reminderLogs).toHaveLength(1);
    const log = reminderLogs[0] as Record<string, unknown>;
    expect(log["finally_emitted"]).toBe(true);
    expect(log["fired_at_turn"]).toBe(10); // all 10 main-loop rounds were used

    // Sanity: round 9 was the last main-loop call. Inspect the params: tools
    // should have been omitted on that round (forced text-only mode).
    const round9Params = capturedParams[9];
    expect(round9Params?.tools).toBeUndefined();
    expect(round9Params?.tool_choice).toBeUndefined();
  });

  test("forced-pass conclude_review emits reviewer.output_tool_call log for observability parity", async () => {
    // Regression guard for the PR #915 round-1 blocking finding: the forced
    // path must emit the same `reviewer.output_tool_call` log shape as the
    // main loop so downstream metrics see the conclude_review emission.
    const { client } = makeFakeClient([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [makeOutputToolCall("c1", "submit_finding", VALID_FINDING_ARGS)],
            },
          },
        ],
        usage: makeUsage(),
      },
      {
        choices: [{ message: { content: "Done.", tool_calls: undefined } }],
        usage: makeUsage(),
      },
      docImpactForcedResponse(),
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [makeOutputToolCall("c2", "conclude_review", VALID_CONCLUDE_ARGS)],
            },
          },
        ],
        usage: makeUsage(),
      },
    ]);

    const { events } = await withCapturedLogs(async () =>
      callOpenAIWithClient(client, MODEL, "system", "user", defaultTools)
    );

    const outputToolCallLogs = events.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>)["event"] === "reviewer.output_tool_call"
    );
    // At least one of each expected tool type was logged.
    const byTool = (tool: string) =>
      outputToolCallLogs.filter((e) => (e as Record<string, unknown>)["tool"] === tool);
    expect(byTool("submit_finding").length).toBeGreaterThanOrEqual(1);
    expect(byTool(TOOL_DOC_IMPACT).length).toBeGreaterThanOrEqual(1);
    expect(byTool("conclude_review").length).toBeGreaterThanOrEqual(1);
  });

  test("empty exit content from a non-last round prefers earlier non-empty assistant text (PR #915 R2)", async () => {
    // Regression guard for the PR #915 round-2 blocking finding: when the exit
    // turn has empty content but an earlier round produced narrative text,
    // surface that earlier text instead of the [TOOL CAP REACHED] sentinel
    // (which falsely implies budget exhaustion that didn't happen).
    const { client } = makeFakeClient([
      // Round 0: model emits narrative text alongside tool calls
      {
        choices: [
          {
            message: {
              content: "Reviewing the diff for null-safety issues.",
              tool_calls: [makeOutputToolCall("c1", "submit_finding", VALID_FINDING_ARGS)],
            },
          },
        ],
        usage: makeUsage(),
      },
      // Round 1: empty exit content; not the last round
      {
        choices: [{ message: { content: "", tool_calls: undefined } }],
        usage: makeUsage(),
      },
      docImpactForcedResponse(), // mt#2115
      // Post-loop forced pass: emits conclude_review.
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [makeOutputToolCall("c2", "conclude_review", VALID_CONCLUDE_ARGS)],
            },
          },
        ],
        usage: makeUsage(),
      },
    ]);

    const { result } = await withCapturedLogs(async () =>
      callOpenAIWithClient(client, MODEL, "system", "user", defaultTools)
    );

    // Should surface the earlier round's narrative text — not empty, not
    // [TOOL CAP REACHED] (the cap wasn't actually hit).
    expect(result.text).toBe("Reviewing the diff for null-safety issues.");
    expect(result.text).not.toContain("[TOOL CAP REACHED]");
  });

  test("empty exit on non-last round with no prior assistant text falls back to neutral notice, not TOOL CAP REACHED", async () => {
    // When NO earlier round had non-empty content either, a non-last-round
    // empty exit must use the neutral "[REVIEWER NOTE] No final summary
    // provided." message rather than the [TOOL CAP REACHED] sentinel —
    // saying "tool cap reached" when the cap wasn't hit is a UX lie.
    const { client } = makeFakeClient([
      // Round 0: tool call only, no narrative text
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [makeOutputToolCall("c1", "submit_finding", VALID_FINDING_ARGS)],
            },
          },
        ],
        usage: makeUsage(),
      },
      // Round 1: empty content, not last round
      {
        choices: [{ message: { content: "", tool_calls: undefined } }],
        usage: makeUsage(),
      },
      docImpactForcedResponse(), // mt#2115
      // Post-loop forced pass: emits conclude_review
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [makeOutputToolCall("c2", "conclude_review", VALID_CONCLUDE_ARGS)],
            },
          },
        ],
        usage: makeUsage(),
      },
    ]);

    const { result } = await withCapturedLogs(async () =>
      callOpenAIWithClient(client, MODEL, "system", "user", defaultTools)
    );

    expect(result.text).toBe("[REVIEWER NOTE] No final summary provided.");
    expect(result.text).not.toContain("[TOOL CAP REACHED]");
  });

  test("post-loop forced pass uses shallow-copied messages, does not mutate the caller's array", async () => {
    // Regression guard for the PR #915 round-2 NB: forceConcludeReview should
    // not append the exit turn or the user reminder onto the parent `messages`
    // array, since that's shared with the main loop. We assert by counting
    // messages on the captured forced-call params vs the messages still in
    // the main loop's array (the main loop doesn't reuse `messages` after
    // the forced pass, but the no-mutation invariant prevents future bugs).
    const { client, capturedParams } = makeFakeClient([
      // Round 0: 1 finding
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [makeOutputToolCall("c1", "submit_finding", VALID_FINDING_ARGS)],
            },
          },
        ],
        usage: makeUsage(),
      },
      // Round 1: empty exit
      {
        choices: [{ message: { content: "Done.", tool_calls: undefined } }],
        usage: makeUsage(),
      },
      docImpactForcedResponse(), // mt#2115
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [makeOutputToolCall("c2", "conclude_review", VALID_CONCLUDE_ARGS)],
            },
          },
        ],
        usage: makeUsage(),
      },
    ]);

    await withCapturedLogs(async () =>
      callOpenAIWithClient(client, MODEL, "system", "user", defaultTools)
    );

    expect(capturedParams).toHaveLength(4);

    const round1Messages = capturedParams[1]?.messages as unknown[];
    const forcedMessages = capturedParams[3]?.messages as unknown[];

    // The forced call's messages array must be longer than the prior round's
    // (it has the exit turn + the reminder appended), AND the prior round's
    // captured messages must not retroactively include those — the messages
    // were snapshotted (the fake client did `[...params.messages]` at the
    // time of each call) so mutation would only show up if both arrays were
    // the same reference. The forced call appends 2 entries (exitMessage +
    // user reminder).
    expect(forcedMessages.length).toBeGreaterThan(round1Messages.length);
    const lastForcedMessage = forcedMessages[forcedMessages.length - 1] as {
      role: string;
      content: string;
    };
    expect(lastForcedMessage.role).toBe("user");
    expect(lastForcedMessage.content).toContain("conclude_review");
  });

  test("post-loop forced reminder log includes mode:'post_loop_forced' for downstream segmentation", async () => {
    // Regression guard for the PR #915 round-2 NB: include a `mode` field on
    // the reminder log so consumers can distinguish the forced-pass path from
    // any future reminder modes without losing parity with prior multi-
    // reminder tracking.
    const { client } = makeFakeClient([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [makeOutputToolCall("c1", "submit_finding", VALID_FINDING_ARGS)],
            },
          },
        ],
        usage: makeUsage(),
      },
      {
        choices: [{ message: { content: "Done.", tool_calls: undefined } }],
        usage: makeUsage(),
      },
      docImpactForcedResponse(),
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [makeOutputToolCall("c2", "conclude_review", VALID_CONCLUDE_ARGS)],
            },
          },
        ],
        usage: makeUsage(),
      },
    ]);

    const { events } = await withCapturedLogs(async () =>
      callOpenAIWithClient(client, MODEL, "system", "user", defaultTools)
    );

    const reminderLogs = events.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>)["event"] === CONCLUDE_REVIEW_REMINDER_EVENT
    );
    expect(reminderLogs).toHaveLength(1);
    expect((reminderLogs[0] as Record<string, unknown>)["mode"]).toBe("post_loop_forced");
  });

  // ----- mt#1639: gate_branch discriminator tests -----

  test("mt#1639 + mt#2115: gate_branch:'emitted_nothing' preserved when main loop produces zero output calls", async () => {
    // gate_branch uses mainLoopOutputCount snapshot, not post-forced-pass count.
    const { client } = makeFakeClient([
      // Round 0: exits immediately with no tool calls at all
      {
        choices: [{ message: { content: "Looks fine.", tool_calls: undefined } }],
        usage: makeUsage(),
      },
      // Post-loop forced doc-impact pass (mt#2115)
      docImpactForcedResponse(),
      // Post-loop forced conclude_review pass
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                makeOutputToolCall(
                  "cr1",
                  "conclude_review",
                  JSON.stringify({ event: "COMMENT", summary: "No issues found." })
                ),
              ],
            },
          },
        ],
        usage: makeUsage(),
      },
    ]);

    const { events, result } = await withCapturedLogs(async () =>
      callOpenAIWithClient(client, MODEL, "system", "user", defaultTools)
    );

    // doc_impact + conclude_review appended from forced passes.
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[1]?.name).toBe("conclude_review");

    const reminderLogs = events.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>)["event"] === CONCLUDE_REVIEW_REMINDER_EVENT
    );
    expect(reminderLogs).toHaveLength(1);
    const log = reminderLogs[0] as Record<string, unknown>;
    expect(log["gate_branch"]).toBe("emitted_nothing");
    expect(log["finally_emitted"]).toBe(true);
    expect(log["reminder_count"]).toBe(1);
    expect(log["fired_at_turn"]).toBe(1); // 1 main-loop round
  });

  test("mt#1639: audit log includes gate_branch:'emitted_no_conclude' on partial-output path (no regression)", async () => {
    // Unit test for Acceptance Test #2 + #3: mt#1471's existing path
    // (hasEmittedOutputCalls=true && !hasConcludeReview) still fires AND its
    // audit log now carries gate_branch:GATE_BRANCH_NO_CONCLUDE for segmentation.
    const { client } = makeFakeClient([
      // Round 0: 1 finding, no conclude_review
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [makeOutputToolCall("c1", "submit_finding", VALID_FINDING_ARGS)],
            },
          },
        ],
        usage: makeUsage(),
      },
      // Round 1: model exits without conclude_review
      {
        choices: [{ message: { content: "Done.", tool_calls: undefined } }],
        usage: makeUsage(),
      },
      // Post-loop forced doc-impact pass (mt#2115)
      docImpactForcedResponse(),
      // Post-loop forced conclude pass: emits conclude_review
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [makeOutputToolCall("c2", "conclude_review", VALID_CONCLUDE_ARGS)],
            },
          },
        ],
        usage: makeUsage(),
      },
    ]);

    const { events, result } = await withCapturedLogs(async () =>
      callOpenAIWithClient(client, MODEL, "system", "user", defaultTools)
    );

    // submit_finding + doc_impact + conclude_review all in toolCalls.
    expect(result.toolCalls).toHaveLength(3);
    expect(result.toolCalls[0]?.name).toBe("submit_finding");
    expect(result.toolCalls[2]?.name).toBe("conclude_review");

    const reminderLogs = events.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>)["event"] === CONCLUDE_REVIEW_REMINDER_EVENT
    );
    expect(reminderLogs).toHaveLength(1);
    const log = reminderLogs[0] as Record<string, unknown>;
    // Discriminator must be emitted_no_conclude on the partial-output path.
    expect(log["gate_branch"]).toBe(GATE_BRANCH_NO_CONCLUDE);
    expect(log["finally_emitted"]).toBe(true);
    expect(log["reminder_count"]).toBe(1);
  });

  test("post-loop forced pass: API-error path logs reminder with finally_emitted:false and error message (PR #915 R3)", async () => {
    // Regression guard for the PR #915 round-3 NB-3: the forced post-loop
    // call wraps `client.chat.completions.create` in a try/catch and logs
    // a reminder event with `finally_emitted: false` plus the error message
    // when the API throws. This test simulates a transport-level error on
    // the third (forced) call and verifies the catch branch's logging.
    let callCount = 0;
    const client = {
      chat: {
        completions: {
          create: async (_params: { messages: unknown[] }) => {
            callCount++;
            if (callCount === 1) {
              return {
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [makeOutputToolCall("c1", "submit_finding", VALID_FINDING_ARGS)],
                    },
                  },
                ],
                usage: makeUsage(),
              };
            }
            if (callCount === 2) {
              return {
                choices: [{ message: { content: "Done.", tool_calls: undefined } }],
                usage: makeUsage(),
              };
            }
            if (callCount === 3) {
              // Third call: doc-impact forced pass (mt#2115)
              return docImpactForcedResponse();
            }
            // Fourth call (conclude forced pass): throw a transport error
            throw new Error("simulated network error on forced call");
          },
        },
      },
    } as unknown as OpenAI;

    const { events, result } = await withCapturedLogs(async () =>
      callOpenAIWithClient(client, MODEL, "system", "user", defaultTools)
    );

    // doc_impact appended; no conclude_review because the forced call threw.
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]?.name).toBe("submit_finding");
    expect(result.toolCalls[1]?.name).toBe(TOOL_DOC_IMPACT);

    const reminderLogs = events.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>)["event"] === CONCLUDE_REVIEW_REMINDER_EVENT
    );
    expect(reminderLogs).toHaveLength(1);
    const log = reminderLogs[0] as Record<string, unknown>;
    expect(log["finally_emitted"]).toBe(false);
    expect(log["mode"]).toBe("post_loop_forced");
    expect(log["reminder_count"]).toBe(1);
    expect(log["fired_at_turn"]).toBe(2);
    expect(log["error"]).toBe("simulated network error on forced call");
  });
});
