/**
 * Tests for `withCallerTemperatureOnly` (mt#2735).
 *
 * mt#2733 stopped `completion-service.ts` from FABRICATING a temperature, but
 * AI SDK v4 re-inserts `temperature: 0` inside its own `prepareCallSettings`,
 * downstream of our call arguments — so omitting the key at the call site never
 * reached the provider. `@ai-sdk/anthropic` forwards that `0` unconditionally
 * and `JSON.stringify` preserves it (unlike `undefined`), so it hits the wire,
 * and current Claude models reject the field's presence.
 *
 * These tests assert at the layer that matters: what reaches the MODEL's
 * `doGenerate` / `doStream`, not what was passed to `generateText`. That is the
 * distinction mt#2733's test file could not make — see its header, which
 * documents the SDK re-defaulting as an acknowledged limitation.
 *
 * Acceptance-test numbering follows mt#2735's `## Acceptance Tests`.
 */

import { describe, expect, test } from "bun:test";
import { generateText, streamText, type LanguageModelV1CallOptions } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { withCallerTemperatureOnly } from "./provider-model-factory";

/** Captures the call options the SDK actually hands to the model. */
function recordingModel(): {
  model: MockLanguageModelV1;
  calls: LanguageModelV1CallOptions[];
} {
  const calls: LanguageModelV1CallOptions[] = [];

  const model = new MockLanguageModelV1({
    doGenerate: async (options) => {
      calls.push(options);
      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: "stop" as const,
        usage: { promptTokens: 1, completionTokens: 1 },
        text: "ok",
      };
    },
  });

  return { model, calls };
}

/** Captures the options handed to `doStream`. */
function recordingStreamModel(): {
  model: MockLanguageModelV1;
  calls: LanguageModelV1CallOptions[];
} {
  const calls: LanguageModelV1CallOptions[] = [];

  const model = new MockLanguageModelV1({
    doStream: async (options) => {
      calls.push(options);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta" as const, textDelta: "ok" });
            controller.enqueue({
              type: "finish" as const,
              finishReason: "stop" as const,
              usage: { promptTokens: 1, completionTokens: 1 },
            });
            controller.close();
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });

  return { model, calls };
}

describe("withCallerTemperatureOnly", () => {
  // AT1: caller omits temperature → doGenerate carries no numeric temperature.
  test("AT1: strips the SDK-injected temperature when the caller set none", async () => {
    const { model, calls } = recordingModel();

    await generateText({ model: withCallerTemperatureOnly(model, undefined), prompt: "hi" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.temperature).toBeUndefined();
    // The value the SDK would otherwise have injected.
    expect(calls[0]?.temperature).not.toBe(0);
  });

  // AT2: an explicit temperature still reaches the model unchanged.
  test("AT2: preserves an explicit temperature", async () => {
    const { model, calls } = recordingModel();

    await generateText({
      model: withCallerTemperatureOnly(model, 0.7),
      prompt: "hi",
      temperature: 0.7,
    });

    expect(calls[0]?.temperature).toBe(0.7);
  });

  // AT2: the case the middleware alone cannot distinguish — an explicit 0 is a
  // caller choice and must survive, even though the SDK's injected value is
  // also 0. This is why the caller's intent is a parameter rather than
  // something the middleware tries to infer.
  test("AT2: preserves an explicit temperature of 0, which the injected default is indistinguishable from", async () => {
    const { model, calls } = recordingModel();

    await generateText({
      model: withCallerTemperatureOnly(model, 0),
      prompt: "hi",
      temperature: 0,
    });

    expect(calls[0]?.temperature).toBe(0);
  });

  test("returns the model unwrapped when the caller supplied a temperature", () => {
    const { model } = recordingModel();

    expect(withCallerTemperatureOnly(model, 0.5)).toBe(model);
    expect(withCallerTemperatureOnly(model, 0)).toBe(model);
    expect(withCallerTemperatureOnly(model, undefined)).not.toBe(model);
  });

  test("leaves every other call option untouched", async () => {
    const { model, calls } = recordingModel();

    await generateText({
      model: withCallerTemperatureOnly(model, undefined),
      prompt: "hi",
      maxTokens: 42,
      topP: 0.5,
    });

    expect(calls[0]?.maxTokens).toBe(42);
    expect(calls[0]?.topP).toBe(0.5);
    expect(calls[0]?.temperature).toBeUndefined();
  });

  test("covers the streaming path, not only generate", async () => {
    const { model, calls } = recordingStreamModel();

    const result = streamText({
      model: withCallerTemperatureOnly(model, undefined),
      prompt: "hi",
    });
    // Drain the stream so doStream actually runs.
    for await (const _chunk of result.textStream) {
      // consume
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.temperature).toBeUndefined();
  });

  test("streaming preserves an explicit temperature", async () => {
    const { model, calls } = recordingStreamModel();

    const result = streamText({
      model: withCallerTemperatureOnly(model, 0.3),
      prompt: "hi",
      temperature: 0.3,
    });
    for await (const _chunk of result.textStream) {
      // consume
    }

    expect(calls[0]?.temperature).toBe(0.3);
  });

  // The behavior is provider-independent by design: the injected `0` is a value
  // no caller requested no matter who receives it, and scoping the strip to a
  // list of temperature-rejecting models would mean hand-maintaining a
  // version-specific table of exactly the kind that rots silently. The mock
  // stands in for ANY provider, which is what makes this assertion meaningful.
  test("behaves identically regardless of which provider the model belongs to", async () => {
    for (const provider of ["openai", "anthropic", "google", "some-future-provider"]) {
      const calls: LanguageModelV1CallOptions[] = [];
      const model = new MockLanguageModelV1({
        provider,
        doGenerate: async (options) => {
          calls.push(options);
          return {
            rawCall: { rawPrompt: null, rawSettings: {} },
            finishReason: "stop" as const,
            usage: { promptTokens: 1, completionTokens: 1 },
            text: "ok",
          };
        },
      });

      await generateText({ model: withCallerTemperatureOnly(model, undefined), prompt: "hi" });

      expect(calls[0]?.temperature).toBeUndefined();
    }
  });
});
