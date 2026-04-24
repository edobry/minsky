/**
 * Unit tests for `DirectCognitionProvider`.
 *
 * Uses a narrow stub of the subset of `AICompletionService` the provider
 * consumes — see the `Pick<..., "generateObject">` dependency in `direct.ts`.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { AICompletionError, type AIObjectGenerationRequest } from "../../ai/types";
import type { CognitionTask } from "../types";
import { CognitionExecutionError } from "../types";
import { DirectCognitionProvider } from "./direct";

/** Stub for the subset of AICompletionService that DirectCognitionProvider needs. */
interface GenerateObjectStub {
  generateObject(req: AIObjectGenerationRequest): Promise<unknown>;
}

function stubService(
  handler: (req: AIObjectGenerationRequest) => Promise<unknown> | unknown
): GenerateObjectStub {
  return {
    async generateObject(req: AIObjectGenerationRequest): Promise<unknown> {
      return handler(req);
    },
  };
}

function makeTask<T>(
  schema: z.ZodType<T>,
  id: string,
  evidence: Record<string, unknown> = {}
): CognitionTask<T> {
  return {
    id,
    kind: "test",
    systemPrompt: "system",
    userPrompt: "user",
    evidence,
    schema,
  };
}

interface CapturedMessage {
  role: string;
  content: string;
}

/**
 * Narrow an observed request into `[system, user]` messages, throwing if the
 * request is absent or the shape doesn't match expectations. This keeps the
 * test body free of non-null assertions.
 */
function captureMessages(req: AIObjectGenerationRequest | undefined): {
  system: CapturedMessage;
  user: CapturedMessage;
} {
  if (!req || !req.messages || req.messages.length < 2) {
    throw new Error("expected a captured request with at least system+user messages");
  }
  const [system, user] = req.messages;
  if (!system || !user) {
    throw new Error("expected both system and user messages to be present");
  }
  return { system, user };
}

describe("DirectCognitionProvider.perform", () => {
  it("returns schema-validated value on success", async () => {
    const schema = z.object({ x: z.number() });
    const provider = new DirectCognitionProvider(stubService(async () => ({ x: 42 })));

    const result = await provider.perform(makeTask(schema, "t1"));

    expect(result).toEqual({ kind: "completed", value: { x: 42 } });
  });

  it("wraps AICompletionError in CognitionExecutionError with cause preserved", async () => {
    const schema = z.object({ x: z.number() });
    const apiError = new AICompletionError("provider down", "openai", "gpt-4", "provider_error");
    const provider = new DirectCognitionProvider(
      stubService(async () => {
        throw apiError;
      })
    );

    let caught: unknown;
    try {
      await provider.perform(makeTask(schema, "t-err"));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CognitionExecutionError);
    expect((caught as CognitionExecutionError).cause).toBe(apiError);
    expect((caught as Error).message).toContain("t-err");
    expect((caught as Error).message).toContain("provider down");
  });

  it("re-throws non-AICompletionError errors unchanged", async () => {
    const schema = z.object({ x: z.number() });
    const unrelated = new RangeError("something else");
    const provider = new DirectCognitionProvider(
      stubService(async () => {
        throw unrelated;
      })
    );

    let caught: unknown;
    try {
      await provider.perform(makeTask(schema, "t-other"));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(unrelated);
  });

  it("emits system + user messages and serializes evidence into the user message", async () => {
    const schema = z.object({ ok: z.boolean() });
    let captured: AIObjectGenerationRequest | undefined;
    const provider = new DirectCognitionProvider(
      stubService(async (req) => {
        captured = req;
        return { ok: true };
      })
    );

    await provider.perform(makeTask(schema, "t-ev", { foo: 1, bar: [1, 2] }));

    const { system, user } = captureMessages(captured);
    expect(system).toEqual({ role: "system", content: "system" });
    expect(user.role).toBe("user");
    expect(user.content).toContain("user");
    expect(user.content).toContain("<evidence>");
    expect(user.content).toContain('"foo": 1');
    expect(user.content).toContain('"bar"');
  });

  it("omits the evidence block when evidence is empty", async () => {
    const schema = z.object({ ok: z.boolean() });
    let captured: AIObjectGenerationRequest | undefined;
    const provider = new DirectCognitionProvider(
      stubService(async (req) => {
        captured = req;
        return { ok: true };
      })
    );

    await provider.perform(makeTask(schema, "t-no-ev"));

    const { user } = captureMessages(captured);
    expect(user.content).toBe("user");
  });

  it("forwards a ModelHint to the underlying request", async () => {
    const schema = z.object({ ok: z.boolean() });
    let captured: AIObjectGenerationRequest | undefined;
    const provider = new DirectCognitionProvider(
      stubService(async (req) => {
        captured = req;
        return { ok: true };
      })
    );
    const task: CognitionTask<{ ok: boolean }> = {
      ...makeTask(schema, "t-hint"),
      model: { provider: "anthropic", model: "claude-opus" },
    };

    await provider.perform(task);

    if (!captured) throw new Error("request was not captured");
    expect(captured.provider).toBe("anthropic");
    expect(captured.model).toBe("claude-opus");
  });

  it("runs zod validation — rejects values that don't conform to the schema", async () => {
    const schema = z.object({ x: z.number() });
    const provider = new DirectCognitionProvider(stubService(async () => ({ x: "not a number" })));

    let caught: unknown;
    try {
      await provider.perform(makeTask(schema, "t-bad"));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(z.ZodError);
  });
});

describe("DirectCognitionProvider.performBatch", () => {
  it("resolves a homogeneous batch with aligned outputs", async () => {
    const schema = z.object({ n: z.number() });
    let calls = 0;
    const provider = new DirectCognitionProvider(stubService(async () => ({ n: ++calls })));

    const tasks = [makeTask(schema, "a"), makeTask(schema, "b")] as const;
    const result = await provider.performBatch(tasks);

    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.value).toHaveLength(2);
      // Each task produced one output.
      expect(result.value[0].n).toBeGreaterThan(0);
      expect(result.value[1].n).toBeGreaterThan(0);
    }
  });

  it("preserves per-task output types across a heterogeneous batch", async () => {
    const schemaA = z.object({ x: z.number() });
    const schemaB = z.object({ y: z.string() });

    const provider = new DirectCognitionProvider(
      stubService(async (req) => {
        const userContent = req.messages?.[1]?.content ?? "";
        if (userContent.includes("prompt-a")) return { x: 7 };
        return { y: "hello" };
      })
    );

    const taskA: CognitionTask<{ x: number }> = {
      id: "a",
      kind: "test",
      systemPrompt: "s",
      userPrompt: "prompt-a",
      evidence: {},
      schema: schemaA,
    };
    const taskB: CognitionTask<{ y: string }> = {
      id: "b",
      kind: "test",
      systemPrompt: "s",
      userPrompt: "prompt-b",
      evidence: {},
      schema: schemaB,
    };

    const result = await provider.performBatch([taskA, taskB] as const);

    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      // Compile-time witnesses: tuple inference must preserve per-element types.
      // If either line below stops type-checking, the type-level guarantee has regressed.
      const x: number = result.value[0].x;
      const y: string = result.value[1].y;
      expect(x).toBe(7);
      expect(y).toBe("hello");
    }
  });

  it("executes batch tasks in parallel", async () => {
    const schema = z.object({ n: z.number() });
    let inFlightPeak = 0;
    let inFlight = 0;
    const provider = new DirectCognitionProvider(
      stubService(async () => {
        inFlight += 1;
        if (inFlight > inFlightPeak) inFlightPeak = inFlight;
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { n: 1 };
      })
    );

    await provider.performBatch([
      makeTask(schema, "p1"),
      makeTask(schema, "p2"),
      makeTask(schema, "p3"),
    ] as const);

    // Sequential execution would leave peak at 1. Parallelism pushes it above 1.
    expect(inFlightPeak).toBeGreaterThan(1);
  });

  it("rejects the batch with a CognitionExecutionError when any task's API call fails", async () => {
    const schema = z.object({ n: z.number() });
    let calls = 0;
    const apiError = new AICompletionError("boom", "openai", "gpt-4", "fail");
    const provider = new DirectCognitionProvider(
      stubService(async () => {
        calls += 1;
        if (calls === 2) throw apiError;
        return { n: calls };
      })
    );

    let caught: unknown;
    try {
      await provider.performBatch([makeTask(schema, "a"), makeTask(schema, "b")] as const);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CognitionExecutionError);
    expect((caught as CognitionExecutionError).cause).toBe(apiError);
  });
});
