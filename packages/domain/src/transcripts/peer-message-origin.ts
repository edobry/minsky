/**
 * peer-message-origin — read a delivered cross-session message off a `user` line.
 *
 * Sibling of {@link ./user-line-origin}, which answers WHO authored a line. This
 * answers WHAT a `peer`-kind line carries: sender, transport, correlation key,
 * and the message body.
 *
 * ## Read `origin`, never parse the envelope text
 *
 * The harness hands us a fully structured object, so parsing the rendered
 * envelope out of `message.content` would be re-deriving what we were already
 * given — and it does not even cover the corpus uniformly. Measured over all 11
 * peer lines in the local corpus (2026-09-01): 7 render as
 * `<cross-session-message …>` and 4 as `<agent-message …>`. `origin` is the only
 * shape present on all of them.
 *
 * | field              | present | what it is |
 * | ------------------ | ------- | ---------- |
 * | `kind`             | 11/11   | always `"peer"` for this class |
 * | `from`             | 11/11   | `uds:/tmp/cc-socks/<pid>.sock`, or a bare agent name |
 * | `name`             | 11/11   | the sender's session name |
 * | `body`             | 11/11   | the message text, unwrapped |
 * | `verifiedPeerPid`  | 7/11    | the sender's pid — **not** a session id |
 * | `msg_id`           | 7/11    | the correlation key, when present |
 * | `fromMode`         | 7/11    | the sender's mode at send time |
 * | `senderTaskId`     | 4/11    | the task the sender was working |
 * | `hopChain`         | 2/11    | relay path, when the message was forwarded |
 *
 * ## This reads an UNDOCUMENTED harness internal, deliberately
 *
 * Claude Code's cross-session-messaging documentation describes the channel as
 * *"Plain text only"* and documents no envelope, no `origin` object, and none of
 * the keys above (read 2026-09-01). So every field here is observed rather than
 * specified, and the harness may change or drop any of them without a version
 * note.
 *
 * That is why {@link readPeerMessageOrigin} fails OPEN on every field
 * independently rather than validating a schema: a missing `msg_id` must degrade
 * to "not correlatable", never to "this is not a peer message". The alternative
 * — parsing the text — depends on the same undocumented surface AND is less
 * stable, since the tag varies across the corpus while `origin` does not.
 *
 * @see mt#4874 — this file
 * @see ./user-line-origin — the authorship sibling; `classifyUserLineOrigin`
 *   is what makes a `peer` line findable at all (mt#4875)
 */

/**
 * Where a peer message came from.
 *
 * `session` means another Claude Code SESSION on this machine — `origin.from`
 * carries a `uds:` socket path. `agent` means a teammate or subagent INSIDE one
 * session, where `from` is a bare agent name like `implementer`.
 *
 * The distinction is load-bearing for any surface showing these: `origin.kind`
 * is `peer` for both, so a consumer that does not split them presents an
 * in-session subagent's message as if it came from another of the operator's
 * terminals.
 */
export type PeerFromKind = "session" | "agent";

/** A delivered cross-session message, projected off the harness's `origin` object. */
export interface PeerMessageOrigin {
  /** Raw `origin.from` — a `uds:` socket path, or a bare agent name. */
  from: string;
  /** Which sense of "peer" this is; derived from {@link from}. */
  fromKind: PeerFromKind;
  /** The sender's OS process id, when the transport is a socket. */
  peerPid: number | null;
  /** Correlation key, when the harness supplied one. */
  msgId: string | null;
  /** The sender's session name. */
  name: string | null;
  /** The sender's mode at send time (e.g. `prompting`). */
  fromMode: string | null;
  /** The task the sender was working, when it declared one. */
  senderTaskId: string | null;
  /** Relay path, when the message was forwarded rather than sent directly. */
  hopChain: string[] | null;
  /** The message text, already unwrapped from its rendered envelope. */
  body: string | null;
}

/** The `uds:` prefix that marks a socket transport, i.e. a genuine cross-SESSION message. */
const SOCKET_PREFIX = "uds:";

/** Read a field off an arbitrary object without assuming its shape. */
function readField(source: unknown, key: string): unknown {
  if (!source || typeof source !== "object") return undefined;
  return (source as Record<string, unknown>)[key];
}

/** A trimmed non-empty string, or null. Everything else — numbers, objects, "" — is null. */
function readString(source: unknown, key: string): string | null {
  const value = readField(source, key);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `from` decides the kind, and `verifiedPeerPid` only corroborates it.
 *
 * Both were checked against the whole local corpus and agree there — exactly the
 * 7 `uds:` lines are the 7 carrying a pid. But they answer different questions:
 * `from` names the TRANSPORT, `verifiedPeerPid` reports a verification the
 * harness performed. A message whose pid could not be verified is still a
 * cross-session message, so keying on the pid would silently reclassify it as an
 * in-session agent. Agreement in one corpus is not a reason to key on the
 * weaker signal.
 */
function classifyFrom(from: string): PeerFromKind {
  return from.startsWith(SOCKET_PREFIX) ? "session" : "agent";
}

/** Read `hopChain` as a string array, dropping non-string members rather than failing. */
function readHopChain(origin: unknown): string[] | null {
  const value = readField(origin, "hopChain");
  if (!Array.isArray(value)) return null;
  const hops = value.filter(
    (hop): hop is string => typeof hop === "string" && hop.trim().length > 0
  );
  return hops.length > 0 ? hops : null;
}

/**
 * Project a `user` line's `origin` into {@link PeerMessageOrigin}, or null when
 * the line is not a delivered peer message.
 *
 * Takes `unknown` for the same reason `classifyUserLineOrigin` does: several
 * types describe this line across the codebase and each drops a different subset
 * of the fields read here.
 *
 * **Null means "not a peer message", and nothing else.** A peer line missing
 * every optional field still returns an object — that is the fail-open posture
 * this module's header argues for, and it is what keeps an un-correlatable
 * message visible instead of invisible.
 */
export function readPeerMessageOrigin(line: unknown): PeerMessageOrigin | null {
  const origin = readField(line, "origin");
  if (!origin || typeof origin !== "object") return null;
  if (readString(origin, "kind") !== "peer") return null;

  // `from` is the one field this projection cannot do without: it is the sender's
  // identity AND the discriminator. Absent, there is nothing to attribute the
  // message to, so it is not usable as a peer message even though `kind` says so.
  const from = readString(origin, "from");
  if (from === null) return null;

  const pid = readField(origin, "verifiedPeerPid");

  return {
    from,
    fromKind: classifyFrom(from),
    // Guarded rather than cast: the pid arrives as a number today, and a
    // non-finite or non-numeric value must degrade to "no pid" rather than
    // becoming NaN and poisoning a later time-bounded lookup.
    peerPid: typeof pid === "number" && Number.isFinite(pid) ? pid : null,
    msgId: readString(origin, "msg_id"),
    name: readString(origin, "name"),
    fromMode: readString(origin, "fromMode"),
    senderTaskId: readString(origin, "senderTaskId"),
    hopChain: readHopChain(origin),
    body: readString(origin, "body"),
  };
}
