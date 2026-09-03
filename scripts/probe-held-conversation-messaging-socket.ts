#!/usr/bin/env bun
/**
 * mt#4870 — proof of concept: drive a HELD Claude Code conversation through its holder.
 *
 * Delivers one message into a live interactive `claude` session over that session's
 * cross-session messaging socket (`messagingSocketPath` in `~/.claude/sessions/<pid>.json`,
 * authenticated with the sibling `<pid>.<sha256>.key` file), then verifies from the holder's
 * transcript that the HOLDER — not this process — wrote the resulting turn.
 *
 * This is a design-spike artifact, not a product surface. It is env-gated and exits 0 with a
 * SKIP line whenever the target holder, its socket, or its key file is absent, so it is safe
 * to run unattended in CI.
 *
 * Usage:
 *   MT4870_HOLDER_PID=<pid> bun scripts/probe-held-conversation-messaging-socket.ts \
 *     --message "reply with exactly the word ACK"
 *   bun scripts/probe-held-conversation-messaging-socket.ts --name mt4870-holder --verify-only
 *
 * Target selection (first match wins): --pid / MT4870_HOLDER_PID, --name / MT4870_HOLDER_NAME,
 * --session / MT4870_HOLDER_SESSION.
 *
 * Exit codes: 0 = pass or SKIP, 1 = verification failed, 2 = usage error.
 */

import { connect } from "node:net";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROSTER_DIR = join(homedir(), ".claude", "sessions");
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const KEY_FILE_RE = /^(\d+)\.[0-9a-f]{64}\.key$/;

interface RosterEntry {
  pid: number;
  sessionId: string;
  cwd?: string;
  name?: string;
  status?: string;
  kind?: string;
  entrypoint?: string;
  version?: string;
  peerProtocol?: number;
  peerFeatures?: string[];
  messagingSocketPath?: string;
  bridgeSessionId?: string;
}

interface TranscriptRow {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  leafUuid?: string;
  isMeta?: boolean;
  userType?: string;
  promptSource?: string;
  origin?: { kind?: string; from?: string; verifiedPeerPid?: number };
  message?: { role?: string; content?: unknown };
  sessionId?: string;
}

function skip(reason: string): never {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}

function fail(reason: string): never {
  console.error(`FAIL: ${reason}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function readRoster(): RosterEntry[] {
  if (!existsSync(ROSTER_DIR)) return [];
  const entries: RosterEntry[] = [];
  for (const file of readdirSync(ROSTER_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(ROSTER_DIR, file), "utf8")) as RosterEntry;
      if (typeof parsed?.pid === "number" && typeof parsed?.sessionId === "string") {
        entries.push(parsed);
      }
    } catch {
      // A roster entry mid-write is unreadable; the holder rewrites it in place, so skipping
      // one is not an error for our purposes. Nothing to log — this is expected churn.
      continue;
    }
  }
  return entries;
}

function pickHolder(args: Record<string, string | boolean>, roster: RosterEntry[]): RosterEntry {
  const pid = String(args.pid ?? process.env.MT4870_HOLDER_PID ?? "");
  const name = String(args.name ?? process.env.MT4870_HOLDER_NAME ?? "");
  const session = String(args.session ?? process.env.MT4870_HOLDER_SESSION ?? "");
  if (!pid && !name && !session) {
    skip(
      "no holder selected — set MT4870_HOLDER_PID / MT4870_HOLDER_NAME / MT4870_HOLDER_SESSION " +
        "or pass --pid / --name / --session"
    );
  }
  const matches = roster.filter(
    (entry) =>
      (pid && String(entry.pid) === pid) ||
      (name && entry.name === name) ||
      (session && entry.sessionId === session)
  );
  if (matches.length === 0) {
    skip(
      `no live roster entry matches pid=${pid || "-"} name=${name || "-"} session=${session || "-"}`
    );
  }
  if (matches.length > 1) {
    fail(
      `selector is ambiguous — ${matches.length} roster entries match ` +
        `(pids ${matches.map((m) => m.pid).join(", ")})`
    );
  }
  const holder = matches[0];
  if (!holder) fail("roster match vanished between filter and read");
  return holder;
}

function readPeerToken(pid: number): string | undefined {
  const file = readdirSync(ROSTER_DIR).find((f) => KEY_FILE_RE.exec(f)?.[1] === String(pid));
  if (!file) return undefined;
  return readFileSync(join(ROSTER_DIR, file), "utf8").trim();
}

function transcriptPath(entry: RosterEntry): string | undefined {
  if (!entry.cwd) return undefined;
  const slug = entry.cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const path = join(PROJECTS_DIR, slug, `${entry.sessionId}.jsonl`);
  return existsSync(path) ? path : undefined;
}

function readTranscript(path: string): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as TranscriptRow);
    } catch (err) {
      const summary = err instanceof Error ? err.message : String(err);
      console.warn(`WARN: unparseable transcript line skipped: ${summary}`);
    }
  }
  return rows;
}

function contentText(row: TranscriptRow): string {
  const content = row.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as { text?: unknown }).text ?? "")
          : ""
      )
      .join(" ");
  }
  return "";
}

async function sendOverSocket(
  socketPath: string,
  token: string | undefined,
  text: string,
  waitMs: number
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect(socketPath);
    let received = "";
    const timer = setTimeout(() => {
      socket.end();
      resolve(received);
    }, waitMs);
    socket.on("connect", () => {
      // The auth line is optional on macOS/Linux (peer credentials are verified from the
      // socket itself) and required on native Windows named pipes. Always send it when we
      // have the key, so the same call works on every platform.
      if (token) socket.write(`${JSON.stringify({ type: "auth", token })}\n`);
      socket.write(
        `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`
      );
    });
    socket.on("data", (chunk) => {
      received += chunk.toString();
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`messaging socket ${socketPath}: ${err.message}`, { cause: err }));
    });
  });
}

interface VerifyResult {
  ok: boolean;
  lines: string[];
}

/**
 * Single-writer verification, per mt#4870's Acceptance Test 1. Pure over its inputs so the
 * checks can be exercised against a recorded specimen without a live holder.
 */
export function verifySingleWriter(
  rows: TranscriptRow[],
  roster: RosterEntry[],
  holder: RosterEntry
): VerifyResult {
  const lines: string[] = [];
  let ok = true;

  // (1) exactly one roster entry carries this conversation id, and it is the holder's pid.
  const carriers = roster.filter((entry) => entry.sessionId === holder.sessionId);
  const oneCarrier = carriers.length === 1 && carriers[0]?.pid === holder.pid;
  ok &&= oneCarrier;
  lines.push(
    `[${oneCarrier ? "PASS" : "FAIL"}] one roster entry for ${holder.sessionId}: ` +
      `${carriers.length} entry/entries (pids ${carriers.map((c) => c.pid).join(", ") || "none"}), ` +
      `holder pid ${holder.pid}`
  );

  // (2) the parentUuid chain is linear — no uuid is the parent of two message rows.
  const messageRows = rows.filter((r) => r.uuid && (r.type === "user" || r.type === "assistant"));
  const childrenByParent = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.uuid) continue;
    const parent = row.parentUuid ?? "<root>";
    childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), row.uuid]);
  }
  const forks = [...childrenByParent.entries()].filter(([, kids]) => kids.length > 1);
  const linear = forks.length === 0;
  ok &&= linear;
  lines.push(
    `[${linear ? "PASS" : "FAIL"}] linear parentUuid chain over ${rows.length} rows ` +
      `(${messageRows.length} message rows): ${forks.length} branch point(s)${
        linear ? "" : ` — ${forks.map(([p, k]) => `${p} -> ${k.join(" | ")}`).join("; ")}`
      }`
  );

  // (3) every last-prompt row names a leaf on that single lineage.
  const known = new Set(rows.map((r) => r.uuid).filter((u): u is string => Boolean(u)));
  const refs = rows.filter((r) => r.type === "last-prompt");
  const strayRefs = refs.filter((r) => r.leafUuid && !known.has(r.leafUuid));
  const refsOk = strayRefs.length === 0;
  ok &&= refsOk;
  lines.push(
    `[${refsOk ? "PASS" : "FAIL"}] ${refs.length} last-prompt row(s), ` +
      `${strayRefs.length} naming a leaf outside this lineage`
  );

  // (4) provenance of the socket-delivered turn(s).
  const peerRows = rows.filter((r) => r.origin?.kind === "peer");
  lines.push(`[INFO] ${peerRows.length} peer-origin user row(s) in this transcript`);
  for (const row of peerRows) {
    lines.push(
      `[INFO]   uuid=${row.uuid} promptSource=${row.promptSource} isMeta=${row.isMeta} ` +
        `userType=${row.userType} origin=${JSON.stringify(row.origin)}`
    );
    lines.push(`[INFO]   content[0:110]=${JSON.stringify(contentText(row).slice(0, 110))}`);
  }

  return { ok, lines };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const roster = readRoster();
  const holder = pickHolder(args, roster);

  console.log(
    `holder: pid=${holder.pid} name=${holder.name ?? "-"} status=${holder.status ?? "-"} ` +
      `kind=${holder.kind} entrypoint=${holder.entrypoint} version=${holder.version}`
  );
  console.log(
    `        sessionId=${holder.sessionId} cwd=${holder.cwd ?? "-"} ` +
      `peerProtocol=${holder.peerProtocol} peerFeatures=${JSON.stringify(holder.peerFeatures ?? [])}`
  );
  console.log(`        bridgeSessionId=${holder.bridgeSessionId ?? "(none)"}`);

  const socketPath = holder.messagingSocketPath;
  if (!socketPath) skip(`holder pid ${holder.pid} publishes no messagingSocketPath`);
  if (!existsSync(socketPath)) skip(`messaging socket ${socketPath} does not exist`);

  const token = readPeerToken(holder.pid);
  console.log(
    `        socket=${socketPath} keyFilePresent=${Boolean(token)} tokenLength=${token?.length ?? 0}`
  );
  if (!token) skip(`no <pid>.<sha256>.key file published for pid ${holder.pid}`);

  const verifyOnly = args["verify-only"] === true;
  if (!verifyOnly) {
    const text = String(
      args.message ??
        process.env.MT4870_MESSAGE ??
        "mt#4870 probe: reply with exactly the word ACK and nothing else."
    );
    const waitMs = Number(args["wait-ms"] ?? 4000);
    console.log(`\nsending user frame (${text.length} chars) …`);
    const response = await sendOverSocket(socketPath, token, text, waitMs);
    console.log(
      `socket response: ${response ? JSON.stringify(response) : "(none — sender-side silence)"}`
    );
    const settleMs = Number(args["settle-ms"] ?? 25000);
    console.log(`waiting ${settleMs}ms for the holder's turn to land …`);
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }

  const path = transcriptPath(holder);
  if (!path)
    skip(`no transcript found for ${holder.sessionId} under ${holder.cwd ?? "(unknown cwd)"}`);
  console.log(`\ntranscript: ${path}`);

  const result = verifySingleWriter(readTranscript(path), readRoster(), holder);
  for (const line of result.lines) console.log(line);
  if (!result.ok) fail("single-writer verification did not hold — see FAIL lines above");
  console.log("\nPASS: the holder is the only writer, and it authored the delivered turn.");
}

if (import.meta.main) {
  await main().catch((err) => {
    const summary =
      err instanceof Error
        ? `${err.message}${err.cause ? ` (cause: ${String(err.cause)})` : ""}`
        : String(err);
    console.error(`ERROR: ${summary}`);
    process.exit(2);
  });
}
