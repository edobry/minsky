/**
 * Masked terminal prompt for credential entry (mt#1426).
 *
 * Reads a line from stdin in raw mode, echoing `*` (or nothing) per
 * keystroke so the value never appears on the terminal. Backspace removes
 * one character. Enter submits. Ctrl+C / ESC throws AbortError.
 *
 * No third-party dependency — uses Node/Bun's built-in stdin raw-mode
 * support and ANSI escape sequences. Bubble Tea / Ink intentionally
 * skipped per the mt#1426 surface decision.
 *
 * The value is intentionally never echoed back after submission, nor
 * logged, nor included in errors. Callers that need to display "success"
 * should not include the value in any follow-up output.
 */

export class CredentialEntryAbortedError extends Error {
  constructor() {
    super("Credential entry aborted by user");
    this.name = "CredentialEntryAbortedError";
  }
}

export interface MaskedPromptOptions {
  /** Prompt string written to stdout before reading (e.g., "Paste token: "). */
  prompt: string;
  /** Character echoed per keystroke. Default "*". Set to "" to echo nothing. */
  maskChar?: string;
  /** Override input stream for testing. Defaults to process.stdin. */
  input?: NodeJS.ReadStream;
  /** Override output stream for testing. Defaults to process.stdout. */
  output?: NodeJS.WriteStream;
}

const KEY_RETURN = "\r";
const KEY_NEWLINE = "\n";
const KEY_BACKSPACE = "";
const KEY_CTRL_C = "";
const KEY_ESC = "";

/**
 * Prompt for a secret on the terminal. Returns the typed string.
 * Throws `CredentialEntryAbortedError` on Ctrl+C, ESC, or non-TTY input.
 */
export async function promptMaskedLine(options: MaskedPromptOptions): Promise<string> {
  const input = options.input ?? (process.stdin as NodeJS.ReadStream);
  const output = options.output ?? (process.stdout as NodeJS.WriteStream);
  const maskChar = options.maskChar ?? "*";

  if (!input.isTTY) {
    // Non-interactive stdin can't be masked safely — refuse rather than
    // accept input that might be logged or echoed elsewhere.
    throw new Error(
      "Masked prompt requires an interactive TTY. Run this command from a real terminal."
    );
  }

  output.write(options.prompt);

  const previousRawMode = input.isRaw;
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  return new Promise<string>((resolve, reject) => {
    let buffer = "";

    const cleanup = (): void => {
      input.setRawMode(previousRawMode ?? false);
      input.pause();
      input.removeListener("data", onData);
      output.write("\n");
    };

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === KEY_RETURN || ch === KEY_NEWLINE) {
          cleanup();
          resolve(buffer);
          return;
        }
        if (ch === KEY_CTRL_C || ch === KEY_ESC) {
          cleanup();
          reject(new CredentialEntryAbortedError());
          return;
        }
        if (ch === KEY_BACKSPACE) {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            if (maskChar) {
              // Erase one mask character: backspace, space, backspace.
              output.write("\b \b");
            }
          }
          continue;
        }
        // Ignore other control characters (including arrow keys, which arrive
        // as multi-char escape sequences starting with ESC — already handled).
        if (ch.charCodeAt(0) < 0x20) {
          continue;
        }
        buffer += ch;
        if (maskChar) {
          output.write(maskChar);
        }
      }
    };

    input.on("data", onData);
  });
}
