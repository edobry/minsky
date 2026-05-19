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
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
}

export interface ArchiveParseResult {
  /** All tweet entries parsed from the archive. */
  total: number;
  /** Originals retained: not retweets, not replies-to-others. */
  originals: TweetRecord[];
  /** Counts dropped by reason. */
  dropped: {
    retweets: number;
    repliesToOthers: number;
    malformed: number;
  };
}

/**
 * Parse a Twitter archive and return only the principal's originals.
 *
 * "Original" means:
 * - NOT a retweet (full_text does not start with "RT @")
 * - NOT a reply to someone else (in_reply_to_user_id is null/missing OR equals accountUserId)
 *
 * Self-replies (threads) ARE kept and tagged via `inReplyToStatusId` so
 * downstream code can re-thread them.
 */
export function parseTwitterArchive(opts: ArchiveParseOptions): ArchiveParseResult {
  const { zipPath, accountUserId, screenName } = opts;
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
      // Drop retweets
      if (text.startsWith("RT @")) {
        dropped.retweets++;
        continue;
      }

      // Drop replies-to-others (any non-null in_reply_to_user_id NOT equal to the account)
      const replyUserId = rt.in_reply_to_user_id || rt.in_reply_to_user_id_str || null;
      if (replyUserId !== null && String(replyUserId) !== accountUserId) {
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
 * Extract `data/tweets.js` from the ZIP. Uses `unzip -p` (already a
 * dependency since the workshop instructions used it; macOS ships it by
 * default). Falls back to a temp-dir extract if the streaming pipe is
 * unavailable.
 */
function extractTweetsJs(zipPath: string): string {
  const result = spawnSync("unzip", ["-p", zipPath, "data/tweets.js"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024, // 256MB — the file is ~38MB but allow headroom
  });
  if (result.status === 0 && result.stdout) {
    return result.stdout;
  }
  // Fallback: extract to a temp dir
  const dir = mkdtempSync(join(tmpdir(), "minsky-twitter-archive-"));
  const dest = join(dir, "tweets.js");
  const extract = spawnSync("unzip", ["-jo", zipPath, "data/tweets.js", "-d", dir], {
    encoding: "utf8",
  });
  if (extract.status !== 0) {
    throw new Error(
      `Failed to extract data/tweets.js from ${zipPath}: ${extract.stderr || extract.stdout}`
    );
  }
  writeFileSync(`${dest}.sentinel`, "1");
  const buf = readFileSync(dest, { encoding: "utf8" });
  return String(buf);
}

/**
 * Strip the `window.YTD.tweets.part0 = ` prefix and parse the rest as JSON.
 * The Twitter archive exports one big JS file that begins with this
 * assignment; the rest of the file is a JSON array of `{ tweet: {...} }`
 * objects.
 */
export function parseTweetsJs(text: string): RawTweet[] {
  const eqIdx = text.indexOf("=");
  if (eqIdx === -1) {
    throw new Error("tweets.js missing the leading assignment prefix");
  }
  const jsonText = text.slice(eqIdx + 1).trim();
  // The trailing characters are valid JSON.
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
