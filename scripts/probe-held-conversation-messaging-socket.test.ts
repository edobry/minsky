/**
 * mt#4870 — the single-writer verifier, replayed against two recorded live specimens.
 *
 * Both fixtures were captured on 2026-09-03 against Claude Code 2.1.258, from one holder
 * (`claude --name mt4870-holder`, pid 79267, conversation 9bd2e5b9-…) running under a real pty
 * in the scratch cwd /private/tmp/mt4870-probe:
 *
 *   holder-socket-delivered.jsonl            verbatim, the transcript immediately after ONE
 *                                            message was delivered over the holder's messaging
 *                                            socket by an outside process. 12 rows.
 *   negative-control-resume-fork.structure…  a STRUCTURAL PROJECTION (per-row fields kept,
 *                                            message content truncated to 400 chars, attachment
 *                                            bodies reduced to their type) of the SAME transcript
 *                                            after the negative control: an external
 *                                            `claude -p --resume <id>` wrote a turn, then the
 *                                            holder's operator typed one. Projected rather than
 *                                            stored verbatim because the raw attachment rows carry
 *                                            ~100KB of unrelated injected context.
 *
 * The pair is the measured contrast mt#4870's Acceptance Test 2 asks for: the socket path keeps
 * one writer; the `--resume` path admits a second and forks.
 */

/* eslint-disable custom/no-real-fs-in-tests -- These tests replay two RECORDED live specimens
   captured from a real Claude Code 2.1.258 holder; the recorded bytes on disk are the evidence
   under test. Mocking the filesystem here would replace the specimen with a hand-written
   assumption about its shape, which is the exact thing the probe exists to avoid. The reads are
   of two committed fixtures under this directory — no external state, no ordering dependence. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifySingleWriter } from "./probe-held-conversation-messaging-socket";

const FIXTURES = join(import.meta.dir, "fixtures", "mt4870");
const SOCKET_DELIVERED = "holder-socket-delivered.jsonl";
const RESUME_FORK = "negative-control-resume-fork.structure.jsonl";
const HOLDER_PID = 79267;
const CONVERSATION_ID = "9bd2e5b9-5b26-4425-9ef4-ea967f64de38";

function loadSpecimen(name: string): ReturnType<typeof JSON.parse>[] {
  return readFileSync(join(FIXTURES, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

const holder = {
  pid: HOLDER_PID,
  sessionId: CONVERSATION_ID,
  cwd: "/private/tmp/mt4870-probe",
  name: "mt4870-holder",
  kind: "interactive",
  entrypoint: "cli",
  version: "2.1.258",
  peerProtocol: 1,
  peerFeatures: ["notify_idle", "reply_across_default_dirs", "artifact_yield"],
  messagingSocketPath: "/tmp/cc-socks/79267.sock",
};

// The live roster carried exactly one entry for this conversation for the whole probe — the
// external `claude -p --resume` process registered its own entry under its own pid and removed
// it on exit, so it never appears as a second carrier of this id.
const rosterAtProbeTime = [holder];

describe("verifySingleWriter", () => {
  test("passes on the socket-delivered specimen: one writer, linear chain, refs on lineage", () => {
    const rows = loadSpecimen(SOCKET_DELIVERED);
    const result = verifySingleWriter(rows, rosterAtProbeTime, holder);

    expect(result.ok).toBe(true);
    expect(result.lines.some((l) => l.startsWith("[FAIL]"))).toBe(false);
    expect(result.lines.join("\n")).toContain("[PASS] linear parentUuid chain");
  });

  test("the socket-delivered turn is authored by the holder and carries peer provenance", () => {
    const rows = loadSpecimen(SOCKET_DELIVERED);
    const delivered = rows.find((row) => row.origin?.kind === "peer");

    expect(delivered).toBeDefined();
    // Not "typed": the holder stamps a socket-delivered turn as a system prompt with an
    // explicit peer origin, and marks it isMeta. This is the provenance answer mt#4870's
    // fifth success criterion asks for.
    expect(delivered.promptSource).toBe("system");
    expect(delivered.isMeta).toBe(true);
    expect(delivered.origin.from).toBe("unknown");
    expect(typeof delivered.origin.verifiedPeerPid).toBe("number");
    // The operator's text is wrapped, not delivered raw.
    expect(delivered.message.content).toContain("Another Claude session sent a message:");
    expect(delivered.message.content).toContain("not typed by your user");
    // …and the holder answered it in the same lineage.
    const reply = rows.find((row) => row.type === "assistant");
    expect(reply.sessionId).toBe(CONVERSATION_ID);
  });

  test("fails on the negative control: the external --resume writer forks the transcript", () => {
    const rows = loadSpecimen(RESUME_FORK);
    const result = verifySingleWriter(rows, rosterAtProbeTime, holder);

    expect(result.ok).toBe(false);
    const report = result.lines.join("\n");
    expect(report).toContain("[FAIL] linear parentUuid chain");
    expect(report).toContain("branch point");
  });

  test("the fork's two branches are an sdk-origin turn and a typed turn under one parent", () => {
    const rows = loadSpecimen(RESUME_FORK);
    const external = rows.find((row) => row.promptSource === "sdk");
    const typed = rows.find((row) => row.promptSource === "typed");

    expect(external).toBeDefined();
    expect(typed).toBeDefined();
    // Same parent — the holder never re-read the file after the external writer appended, so
    // both turns were parented off the pre-race tip (mem#805's cached-tip mechanism).
    expect(external.parentUuid).toBe(typed.parentUuid);
    expect(typed.origin.kind).toBe("human");
    // Both branches were answered, so neither is a mere abandoned prompt.
    const answered = (uuid: string) => {
      const seen = new Set([uuid]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const row of rows) {
          if (row.parentUuid && seen.has(row.parentUuid) && row.uuid && !seen.has(row.uuid)) {
            seen.add(row.uuid);
            grew = true;
          }
        }
      }
      return rows.some((row) => row.type === "assistant" && row.uuid && seen.has(row.uuid));
    };
    expect(answered(external.uuid)).toBe(true);
    expect(answered(typed.uuid)).toBe(true);
  });

  test("last-prompt refs after the fork name leaves on different branches", () => {
    const rows = loadSpecimen(RESUME_FORK);
    const refs = rows.filter((row) => row.type === "last-prompt" && row.leafUuid);
    expect(refs.length).toBeGreaterThanOrEqual(3);

    const parentOf = new Map(rows.filter((r) => r.uuid).map((r) => [r.uuid, r.parentUuid]));
    const ancestry = (uuid: string) => {
      const chain: string[] = [];
      let cursor: string | null | undefined = uuid;
      while (cursor) {
        chain.push(cursor);
        cursor = parentOf.get(cursor) ?? null;
      }
      return chain;
    };
    const chains = refs.map((ref) => ancestry(ref.leafUuid));
    const last = chains[chains.length - 1];
    // At least one earlier ref names a leaf that is NOT an ancestor of the final ref's leaf —
    // that divergence is the closest thing the format offers to a writer-identity trace.
    expect(chains.some((chain) => !last.includes(chain[0]))).toBe(true);
  });
});
