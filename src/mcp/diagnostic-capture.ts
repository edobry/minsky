import { appendFileSync, mkdirSync } from "fs";
import { hostname } from "os";
import { join } from "path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/**
 * Diagnostic capture for mt#953 — agent identity research.
 *
 * Gated on env var `MINSKY_MCP_DIAG_CAPTURE=<directory>`. When enabled, dumps
 * process environment, MCP `initialize` contents, and every incoming request
 * to a JSONL file in the given directory. When disabled, all operations are
 * no-ops.
 *
 * This is a research tool. The captured files feed `docs/research/mt953-mcp-signals.md`
 * and become fixtures for the ADR. Safe to remove once the research is complete.
 */

const ENV_VAR = "MINSKY_MCP_DIAG_CAPTURE";
const HARNESS_ENV_PATTERN =
  /^(CLAUDE|CLAUDECODE|ANTHROPIC|CURSOR|WINDSURF|CODEX|CLINE|ZED|MCP|COPILOT|AGUI|OPENAI|GEMINI|SSH_|TERM_)/i;

export interface DiagnosticCapture {
  readonly enabled: boolean;
  captureProcess(): void;
  captureInit(server: Server): void;
  captureRequest(method: string, request: unknown, extra: unknown): void;
}

const NOOP: DiagnosticCapture = {
  enabled: false,
  captureProcess() {},
  captureInit() {},
  captureRequest() {},
};

type ExtendedProcess = typeof process & {
  ppid?: number;
  versions?: Record<string, string>;
  execPath?: string;
};

export function createDiagnosticCapture(): DiagnosticCapture {
  const captureDir = process.env[ENV_VAR];
  if (!captureDir) return NOOP;

  mkdirSync(captureDir, { recursive: true });
  const filepath = join(captureDir, `capture-${Date.now()}-${process.pid}.jsonl`);

  const emit = (entry: Record<string, unknown>): void => {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
    appendFileSync(filepath, line);
  };

  return {
    enabled: true,

    captureProcess() {
      const harnessEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && HARNESS_ENV_PATTERN.test(k)) harnessEnv[k] = v;
      }
      const p = process as ExtendedProcess;
      emit({
        event: "process",
        pid: process.pid,
        ppid: p.ppid,
        platform: process.platform,
        arch: process.arch,
        runtime: p.versions,
        cwd: process.cwd(),
        argv: process.argv,
        execPath: p.execPath,
        user: process.env.USER ?? process.env.USERNAME,
        hostname: hostname(),
        stdinIsTTY: Boolean(process.stdin.isTTY),
        stdoutIsTTY: Boolean(process.stdout.isTTY),
        harnessEnv,
      });
    },

    captureInit(server: Server) {
      const previous = server.oninitialized;
      server.oninitialized = () => {
        emit({
          event: "initialized",
          clientVersion: server.getClientVersion(),
          clientCapabilities: server.getClientCapabilities(),
        });
        previous?.();
      };
    },

    captureRequest(method, request, extra) {
      const e = extra as { sessionId?: string; _meta?: unknown } | undefined;
      emit({
        event: "request",
        method,
        request,
        extra: {
          sessionId: e?.sessionId,
          _meta: e?._meta,
        },
      });
    },
  };
}
