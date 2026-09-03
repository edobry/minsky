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
 * Exit codes:
 *   0  pass, or SKIP (no target selected / no roster match / no socket / no key file)
 *   1  the run happened and single-writer verification did NOT hold
 *   2  the run could not happen: ambiguous selector, transport error, unexpected exception
 */

import { connect } from "node:net";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROSTER_DIR = join(homedir(), ".claude", "sessions");
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const KEY_FILE_RE = /^(\d+)\.[0-9a-f]{64}\.key$/;

/**
 * Row types that participate in the conversation's `parentUuid` chain as TURNS. Branch detection
 * is scoped to these: a transcript interleaves attachment / system / file-history-snapshot rows
 * on the same chain, and two of those legitimately sharing a parent is not a fork. A fork is two
 * TURNS under one parent — which is exactly the shape the mem#805 two-writer race produces.
 */
const TURN_TYPES = new Set(["user", "assistant"]);

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

/** The run could not happen at all — distinct from a run whose verification failed. */
function usage(reason: string): never {
  console.error(`USAGE: ${reason}`);
  process.exit(2);
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
    usage(
      `selector is ambiguous — ${matches.length} roster entries match ` +
        `(pids ${matches.map((m) => m.pid).join(", ")}); select by --pid`
    );
  }
  const holder = matches[0];
  if (!holder) usage("roster match vanished between filter and read");
  return holder;
}

function readPeerToken(pid: number): string | undefined {
  // The roster directory is created by the first `claude` process on this machine and removed by
  // nothing we control, so treat its absence as "no roster" — the same reading `readRoster` takes
  // — rather than letting readdirSync throw ENOENT out of a probe whose contract is to SKIP.
  if (!existsSync(ROSTER_DIR)) return undefined;
  const file = readdirSync(ROSTER_DIR).find((f) => KEY_FILE_RE.exec(f)?.[1] === String(pid));
  if (!file) return undefined;
  return readFileSync(join(ROSTER_DIR, file), "utf8").trim();
}

/**
 * Locate the holder's transcript. The vendor's cwd → project-slug rule is undocumented, so
 * SEARCH for the conversation id across every project directory first and fall back to the
 * derived slug only if the scan finds nothing. That way a slug-rule change degrades to the old
 * behaviour instead of silently reporting "no transcript" for a live conversation.
 */
function transcriptPath(entry: RosterEntry): string | undefined {
  const filename = `${entry.sessionId}.jsonl`;
  if (existsSync(PROJECTS_DIR)) {
    for (const project of readdirSync(PROJECTS_DIR)) {
      const candidate = join(PROJECTS_DIR, project, filename);
      if (existsSync(candidate)) return candidate;
    }
  }
  if (!entry.cwd) return undefined;
  const slug = entry.cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const derived = join(PROJECTS_DIR, slug, filename);
  return existsSync(derived) ? derived : undefined;
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

interface SendOutcome {
  /** Raw bytes the holder sent back on this connection, if any. */
  raw: string;
  /** Newline-delimited frames we could parse out of `raw`. */
  frames: Record<string, unknown>[];
}

async function sendOverSocket(
  socketPath: string,
  token: string | undefined,
  text: string,
  waitMs: number
): Promise<SendOutcome> {
  const raw = await new Promise<string>((resolve, reject) => {
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

  const frames: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      frames.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A partial trailing frame is expected when the wait window closes mid-write; the raw
      // bytes are reported alongside, so nothing is lost by not parsing this one.
      continue;
    }
  }
  return { raw, frames };
}

interface VerifyResult {
  ok: boolean;
  lines: string[];
}

interface VerifyOptions {
  /**
   * Assert that a peer-origin user row exists AND that the holder answered it. Set when this run
   * actually delivered a message; left false for `--verify-only` inspection of a transcript that
   * may predate any peer send.
   */
  expectDeliveredTurn?: boolean;
}

/**
 * Single-writer verification, per mt#4870's Acceptance Test 1. Pure over its inputs so the
 * checks can be exercised against a recorded specimen without a live holder.
 */
export function verifySingleWriter(
  rows: TranscriptRow[],
  roster: RosterEntry[],
  holder: RosterEntry,
  options: VerifyOptions = {}
): VerifyResult {
  const lines: string[] = [];
  let ok = true;

  const uuidToRow = new Map<string, TranscriptRow>();
  for (const row of rows) if (row.uuid) uuidToRow.set(row.uuid, row);

  // (1) exactly one roster entry carries this conversation id, and it is the holder's pid.
  const carriers = roster.filter((entry) => entry.sessionId === holder.sessionId);
  const oneCarrier = carriers.length === 1 && carriers[0]?.pid === holder.pid;
  ok &&= oneCarrier;
  lines.push(
    `[${oneCarrier ? "PASS" : "FAIL"}] one roster entry for ${holder.sessionId}: ` +
      `${carriers.length} entry/entries (pids ${carriers.map((c) => c.pid).join(", ") || "none"}), ` +
      `holder pid ${holder.pid}`
  );

  // (2) the chain is linear at TURN granularity — no uuid is the parent of two user/assistant
  // rows. Non-turn rows (attachment, system, file-history-snapshot) are counted separately and
  // reported as INFO: they interleave on the same chain and sharing a parent is not a fork.
  const childrenByParent = new Map<string, string[]>();
  const nonTurnByParent = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.uuid) continue;
    const parent = row.parentUuid ?? "<root>";
    const bucket = TURN_TYPES.has(row.type ?? "") ? childrenByParent : nonTurnByParent;
    bucket.set(parent, [...(bucket.get(parent) ?? []), row.uuid]);
  }
  const forks = [...childrenByParent.entries()].filter(([, kids]) => kids.length > 1);
  const turnRows = rows.filter((r) => r.uuid && TURN_TYPES.has(r.type ?? ""));
  const linear = forks.length === 0;
  ok &&= linear;
  lines.push(
    `[${linear ? "PASS" : "FAIL"}] linear parentUuid chain over ${turnRows.length} turn row(s) ` +
      `(of ${rows.length} total): ${forks.length} branch point(s)${
        linear ? "" : ` — ${forks.map(([p, k]) => `${p} -> ${k.join(" | ")}`).join("; ")}`
      }`
  );
  const nonTurnShares = [...nonTurnByParent.entries()].filter(([, kids]) => kids.length > 1);
  lines.push(
    `[INFO] ${nonTurnShares.length} parent(s) with multiple non-turn children ` +
      `(attachment/system/snapshot rows — not counted as forks)`
  );

  // (3) every last-prompt row names a leaf that is ON the lineage of the final tip, not merely
  // a uuid that exists somewhere in the file. Two refs naming leaves on different branches is
  // the closest thing this format offers to a writer-identity trace (mem#805), so existence
  // alone would not discharge the Acceptance Test.
  const lastTurn = [...turnRows].reverse()[0];
  const lineage = new Set<string>();
  for (let cursor = lastTurn?.uuid; cursor; ) {
    lineage.add(cursor);
    const parent: string | null | undefined = uuidToRow.get(cursor)?.parentUuid;
    cursor = parent ?? undefined;
  }
  const refs = rows.filter((r) => r.type === "last-prompt" && r.leafUuid);
  const strayRefs = refs.filter((r) => r.leafUuid && !lineage.has(r.leafUuid));
  const refsOk = strayRefs.length === 0;
  ok &&= refsOk;
  lines.push(
    `[${refsOk ? "PASS" : "FAIL"}] ${refs.length} last-prompt row(s); ` +
      `${strayRefs.length} naming a leaf off the tip's lineage (${lineage.size} uuids on it)${
        refsOk ? "" : ` — ${strayRefs.map((r) => r.leafUuid).join(", ")}`
      }`
  );

  // (4) the delivered turn is present and the HOLDER answered it — the substance of AT1, which
  // an INFO line alone would not assert.
  const peerRows = rows.filter((r) => r.origin?.kind === "peer");
  if (options.expectDeliveredTurn) {
    const answeredPeerRow = peerRows.find((row) => {
      const reachable = new Set<string>([row.uuid ?? ""]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const candidate of rows) {
          if (candidate.parentUuid && reachable.has(candidate.parentUuid) && candidate.uuid) {
            if (!reachable.has(candidate.uuid)) {
              reachable.add(candidate.uuid);
              grew = true;
            }
          }
        }
      }
      return rows.some(
        (r) =>
          r.type === "assistant" &&
          r.uuid &&
          reachable.has(r.uuid) &&
          r.sessionId === holder.sessionId
      );
    });
    const delivered = Boolean(answeredPeerRow);
    ok &&= delivered;
    lines.push(
      `[${delivered ? "PASS" : "FAIL"}] a peer-origin user row exists and the holder answered it ` +
        `(${peerRows.length} peer row(s); answered=${answeredPeerRow?.uuid ?? "none"})`
    );
  }

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
    const outcome = await sendOverSocket(socketPath, token, text, waitMs);
    if (outcome.frames.length > 0) {
      for (const frame of outcome.frames)
        console.log(`sender-side frame: ${JSON.stringify(frame)}`);
    } else {
      // Silence is NOT delivery. The vendor models held / denied / expired / refused /
      // not-accepting as sender-side status frames, and none of them arrived inside our wait
      // window — which is consistent with acceptance and equally consistent with a hold that
      // has not been decided yet. Only the transcript check below distinguishes them.
      console.log(
        `sender-side frames: none within ${waitMs}ms${
          outcome.raw ? ` (unparsed bytes: ${JSON.stringify(outcome.raw.slice(0, 200))})` : ""
        } — silence is not evidence of delivery; the transcript check below is`
      );
    }
    const settleMs = Number(args["settle-ms"] ?? 25000);
    console.log(`waiting ${settleMs}ms for the holder's turn to land …`);
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }

  const path = transcriptPath(holder);
  if (!path) skip(`no transcript found for ${holder.sessionId} under ${PROJECTS_DIR}`);
  console.log(`\ntranscript: ${path}`);

  const result = verifySingleWriter(readTranscript(path), readRoster(), holder, {
    expectDeliveredTurn: !verifyOnly,
  });
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
