/**
 * Twitter archive parser.
 *
 * Extracts originals (drops retweets and replies-to-others) from a Twitter
 * archive ZIP's `data/tweets.js` file. Originating task: mt#1930.
 *
 * The archive is a self-contained HTML site bundle; `data/tweets.js`
 * assigns an array of tweet objects to a global variable
 * (`window.YTD.tweets.part0 = [...]`). We strip the prefix and parse the
 * trailing array as JSON.
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import type { TweetRecord } from "./types";

/**
 * Raw tweet shape as it appears in the Twitter archive. Mirrors the export
 * format; many fields are unused. All numeric fields are exported as
 * strings.
 */
export interface RawTweet {
  id: string;
  id_str?: string;
  full_text: string;
  created_at: string;
  favorite_count?: string | number;
  retweet_count?: string | number;
  reply_count?: string | number;
  in_reply_to_status_id?: string | null;
  in_reply_to_status_id_str?: string | null;
  in_reply_to_user_id?: string | null;
  in_reply_to_user_id_str?: string | null;
  retweeted?: boolean;
  // Additional fields exist but are not required for the parser.
}

export interface ArchiveParseOptions {
  /** Path to the Twitter archive ZIP. */
  zipPath: string;
  /** The principal's Twitter user_id (numeric string). Used to detect self-replies. */
  accountUserId: string;
  /** The principal's @-handle, used to build the canonical tweet URL. */
  screenName: string;
  /**
   * If true, drop tweets that are replies to OTHER users (i.e. tweets whose
   * `in_reply_to_user_id` is non-null and ≠ accountUserId). Default false.
   *
   * Originally true, but pre-filtering replies-to-others coarsely removes a
   * meaningful set of substantive content — quote-tweet replies, thread starts
   * with @mentions, and substantive engagement with others. The relevance
   * classifier is the right judgment surface; the parser should not pre-filter
   * what the classifier could decide more precisely.
   */
  dropRepliesToOthers?: boolean;
}

export interface ArchiveParseResult {
  /** All tweet entries parsed from the archive. */
  total: number;
  /** Originals retained: principal-authored tweets (always excludes retweets; replies-to-others controlled by option). */
  originals: TweetRecord[];
  /** Counts dropped by reason. */
  dropped: {
    retweets: number;
    repliesToOthers: number;
    malformed: number;
  };
}

/**
 * Parse a Twitter archive and return tweets the principal authored.
 *
 * Always drops:
 * - **Retweets** — `full_text` starting with `RT @`. Retweets are someone
 *   else's content republished verbatim; not the principal's voice.
 *
 * NOT dropped (vs. pre-mt#1930):
 * - **Quote tweets** — these have the principal's own text appended to a URL
 *   pointing at the quoted tweet. They don't start with `RT @`, so they pass
 *   through unchanged. Crucial for Visa-style thread engagement.
 * - **Replies to others** — by default we keep them. The relevance classifier
 *   downstream is the right judgment surface for whether they carry substance.
 *   Pass `dropRepliesToOthers: true` to restore the pre-mt#1930 behaviour.
 *
 * Self-replies (threads) are always kept and tagged via `inReplyToStatusId`
 * so downstream code can re-thread them.
 */
export function parseTwitterArchive(opts: ArchiveParseOptions): ArchiveParseResult {
  const { zipPath, accountUserId, screenName, dropRepliesToOthers = false } = opts;
  if (!existsSync(zipPath)) {
    throw new Error(`Twitter archive ZIP not found at ${zipPath}`);
  }

  const tweetsJs = extractTweetsJs(zipPath);
  const rawTweets = parseTweetsJs(tweetsJs);

  const dropped = { retweets: 0, repliesToOthers: 0, malformed: 0 };
  const originals: TweetRecord[] = [];

  for (const rt of rawTweets) {
    try {
      const text = rt.full_text || "";
      // Always drop retweets.
      if (text.startsWith("RT @")) {
        dropped.retweets++;
        continue;
      }

      const replyUserId = rt.in_reply_to_user_id || rt.in_reply_to_user_id_str || null;
      const isReplyToOther = replyUserId !== null && String(replyUserId) !== accountUserId;
      if (dropRepliesToOthers && isReplyToOther) {
        dropped.repliesToOthers++;
        continue;
      }

      const id = String(rt.id_str || rt.id);
      const replyStatusId = rt.in_reply_to_status_id || rt.in_reply_to_status_id_str || null;

      originals.push({
        id,
        text,
        createdAt: new Date(rt.created_at).toISOString(),
        favoriteCount: toNum(rt.favorite_count),
        retweetCount: toNum(rt.retweet_count),
        replyCount: toNum(rt.reply_count),
        inReplyToStatusId: replyStatusId ? String(replyStatusId) : null,
        inReplyToUserId: replyUserId ? String(replyUserId) : null,
        url: `https://twitter.com/${screenName}/status/${id}`,
      });
    } catch {
      dropped.malformed++;
    }
  }

  return { total: rawTweets.length, originals, dropped };
}

/**
 * Extract `data/tweets.js` from the ZIP via the system `unzip` binary.
 *
 * Operational scope: this is a script run by the operator on their local
 * machine (the Twitter archive is held off-repo on the principal's
 * filesystem). macOS and most Linux distros ship `unzip` by default; the
 * parser is not invoked from CI or a deployed service. We surface a clear
 * actionable error when `unzip` is missing so the operator knows what to
 * install. (For a future portable-across-environments version, switch to
 * a pure-JS reader like yauzl — out of scope here.)
 */
function extractTweetsJs(zipPath: string): string {
  const result = spawnSync("unzip", ["-p", zipPath, "data/tweets.js"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024, // 256MB — the file is ~38MB but allow headroom
  });
  // ENOENT on the binary surfaces as result.error with code "ENOENT".
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `Cannot extract Twitter archive: the 'unzip' binary is not on PATH. ` +
          `Install it (macOS: pre-installed; Debian/Ubuntu: 'apt-get install unzip'; ` +
          `Alpine: 'apk add unzip'). Archive path: ${zipPath}`
      );
    }
    throw new Error(`Failed to invoke unzip on ${zipPath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Failed to extract data/tweets.js from ${zipPath} ` +
        `(unzip exit=${result.status}): ${result.stderr || "(no stderr)"}`
    );
  }
  if (!result.stdout) {
    throw new Error(
      `unzip succeeded but produced no output for data/tweets.js in ${zipPath} — ` +
        `archive may be corrupt or missing the expected entry`
    );
  }
  return result.stdout;
}

/**
 * Strip the `window.YTD.tweets.part0 = ` prefix and parse the rest as JSON.
 * The Twitter archive exports one big JS file that begins with this
 * assignment; the rest of the file is a JSON array of `{ tweet: {...} }`
 * objects.
 *
 * Robust against:
 * - trailing `;` (Twitter exports sometimes append one to the assignment)
 * - trailing whitespace / newlines
 * - leading whitespace between `=` and `[`
 * - extra trailing prose after the array (we locate the first balanced
 *   array span and parse just that)
 */
export function parseTweetsJs(text: string): RawTweet[] {
  const eqIdx = text.indexOf("=");
  if (eqIdx === -1) {
    throw new Error("tweets.js missing the leading assignment prefix");
  }
  const tail = text.slice(eqIdx + 1).trim();
  // Locate the first '['; balanced-bracket-scan to find its matching ']'.
  // String-content aware: `[` and `]` inside JSON strings don't affect depth.
  const startIdx = tail.indexOf("[");
  if (startIdx === -1) {
    throw new Error("tweets.js: no '[' found after assignment");
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx = -1;
  for (let i = startIdx; i < tail.length; i++) {
    const ch = tail[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) {
    throw new Error("tweets.js: array body did not close (unbalanced brackets)");
  }
  const jsonText = tail.slice(startIdx, endIdx + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Failed to parse tweets.js JSON body: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("tweets.js body did not parse as an array");
  }
  const out: RawTweet[] = [];
  for (const entry of parsed) {
    if (
      entry &&
      typeof entry === "object" &&
      "tweet" in entry &&
      (entry as { tweet?: unknown }).tweet
    ) {
      out.push((entry as { tweet: RawTweet }).tweet);
    }
  }
  return out;
}

function toNum(v: string | number | undefined): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
