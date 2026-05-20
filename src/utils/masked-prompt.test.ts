/**
 * masked-prompt tests (mt#1426 PR #1142 R1).
 *
 * Verifies the masked-paste readline loop accepts BS (0x08) as well as
 * DEL (0x7F) for backspace — reviewer flagged BS missing on some terminals.
 * Tests use injected mock streams to simulate TTY raw-mode behaviour.
 */
import { describe, it, expect } from "bun:test";
import { promptMaskedLine, CredentialEntryAbortedError } from "./masked-prompt";

/**
 * Build a mock NodeJS.ReadStream that emits the given character sequence
 * one chunk at a time after `on("data", handler)` is attached.
 */
function mockTtyInput(chars: string): NodeJS.ReadStream {
  const handlers: Array<(chunk: string) => void> = [];

  const stream: any = {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) {
      stream.isRaw = raw;
    },
    resume() {},
    pause() {},
    setEncoding(_enc: string) {},
    on(event: string, handler: (chunk: string) => void) {
      if (event === "data") {
        handlers.push(handler);
        // Defer emission to next tick so the caller has time to attach.
        queueMicrotask(() => {
          for (const ch of chars) {
            handler(ch);
          }
        });
      }
    },
    removeListener() {},
  };
  return stream as NodeJS.ReadStream;
}

function mockOutput(): { stream: NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = [];

  const stream: any = {
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  };
  return { stream: stream as NodeJS.WriteStream, writes };
}

const CR = "\r";
const DEL = "\x7F";
const BS = "\b";
const CTRL_C = "\x03";
const ESC = "\x1B";

describe("promptMaskedLine", () => {
  it("returns the typed line on Enter (CR)", async () => {
    const out = mockOutput();
    const result = await promptMaskedLine({
      prompt: "Paste: ",
      input: mockTtyInput(`abc${CR}`),
      output: out.stream,
    });
    expect(result).toBe("abc");
  });

  it("DEL (0x7F) erases the last character", async () => {
    const out = mockOutput();
    const result = await promptMaskedLine({
      prompt: "Paste: ",
      input: mockTtyInput(`abc${DEL}d${CR}`),
      output: out.stream,
    });
    // abc, then DEL removes 'c', then 'd' is appended → "abd"
    expect(result).toBe("abd");
  });

  it("BS (0x08) erases the last character (mt#1426 PR #1142 R1)", async () => {
    const out = mockOutput();
    const result = await promptMaskedLine({
      prompt: "Paste: ",
      input: mockTtyInput(`abc${BS}d${CR}`),
      output: out.stream,
    });
    // BS must behave identically to DEL — terminals differ on which they emit.
    expect(result).toBe("abd");
  });

  it("Ctrl+C aborts with CredentialEntryAbortedError", async () => {
    const out = mockOutput();
    let caught: unknown;
    try {
      await promptMaskedLine({
        prompt: "Paste: ",
        input: mockTtyInput(`abc${CTRL_C}`),
        output: out.stream,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CredentialEntryAbortedError);
  });

  it("ESC aborts with CredentialEntryAbortedError", async () => {
    const out = mockOutput();
    let caught: unknown;
    try {
      await promptMaskedLine({
        prompt: "Paste: ",
        input: mockTtyInput(`xyz${ESC}`),
        output: out.stream,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CredentialEntryAbortedError);
  });

  it("masks input with the default `*` per character (does not echo the typed char)", async () => {
    const out = mockOutput();
    const prompt = "> ";
    await promptMaskedLine({
      prompt,
      input: mockTtyInput(`xyz${CR}`),
      output: out.stream,
    });
    // First write is the prompt; subsequent writes are mask chars per typed character.
    expect(out.writes[0]).toBe(prompt);
    // The actual typed characters must never appear in any output write.
    const writesAfterPrompt = out.writes.slice(1).join("");
    expect(writesAfterPrompt.includes("x")).toBe(false);
    expect(writesAfterPrompt.includes("y")).toBe(false);
    expect(writesAfterPrompt.includes("z")).toBe(false);
    // Three '*' chars should be present for the three typed characters.
    expect(writesAfterPrompt.match(/\*/g)?.length ?? 0).toBe(3);
  });

  it("throws when stdin is non-TTY", async () => {
    const nonTty: any = { isTTY: false };
    await expect(
      promptMaskedLine({
        prompt: "Paste: ",
        input: nonTty as NodeJS.ReadStream,
      })
    ).rejects.toThrow(/interactive TTY/);
  });
});
