import { describe, test, expect } from "bun:test";
import { parseTweetsJs } from "./tweet-archive-parser";

describe("parseTweetsJs", () => {
  test("strips the window.YTD.tweets.part0 prefix and returns the inner tweet objects", () => {
    const body = `window.YTD.tweets.part0 = [
      {
        "tweet": {
          "id": "1",
          "id_str": "1",
          "full_text": "first tweet",
          "created_at": "Wed Sep 10 14:45:55 +0000 2025",
          "favorite_count": "3",
          "retweet_count": "0"
        }
      },
      {
        "tweet": {
          "id": "2",
          "id_str": "2",
          "full_text": "RT @other: a retweet body",
          "created_at": "Wed Sep 10 15:00:00 +0000 2025",
          "favorite_count": "0",
          "retweet_count": "5"
        }
      }
    ]`;
    const tweets = parseTweetsJs(body);
    expect(tweets).toHaveLength(2);
    expect(tweets[0]?.id).toBe("1");
    expect(tweets[0]?.full_text).toBe("first tweet");
    expect(tweets[1]?.full_text.startsWith("RT @")).toBe(true);
  });

  test("throws on missing assignment", () => {
    expect(() => parseTweetsJs('[{"tweet": {}}]')).toThrow();
  });

  test("throws on non-array body", () => {
    expect(() => parseTweetsJs('window.YTD.tweets.part0 = {"foo": "bar"}')).toThrow();
  });

  test("skips malformed entries (missing tweet field)", () => {
    const body = `window.YTD.tweets.part0 = [
      { "tweet": { "id": "1", "full_text": "valid", "created_at": "Wed Sep 10 14:45:55 +0000 2025" } },
      { "not_a_tweet": true }
    ]`;
    const tweets = parseTweetsJs(body);
    expect(tweets).toHaveLength(1);
    expect(tweets[0]?.id).toBe("1");
  });
});
