/**
 * Principal-corpus domain types.
 *
 * The principal-corpus namespace stores the principal's personal corpus
 * (e.g., Twitter archive originals) for principal-scoped semantic search.
 * Originating task: mt#1930.
 */

/**
 * A tweet record as extracted from the Twitter archive. Originals only —
 * retweets and replies-to-others are filtered out by the parser.
 */
export interface TweetRecord {
  /** Tweet ID (numeric string, e.g. "1540123456789012345"). */
  id: string;
  /** Tweet text content (full_text from the archive). */
  text: string;
  /** ISO-8601 created_at timestamp. */
  createdAt: string;
  /** Favorite (like) count at archive time. */
  favoriteCount: number;
  /** Retweet count at archive time. */
  retweetCount: number;
  /** Reply count at archive time (may be 0 when archive doesn't carry it). */
  replyCount: number;
  /** Self-reply parent tweet ID (if this tweet replies to another from the same account, i.e. a thread). */
  inReplyToStatusId?: string | null;
  /** Self-reply parent's user ID — present even on self-thread tweets. */
  inReplyToUserId?: string | null;
  /** Public URL on twitter.com (for citation in memeplexes). */
  url: string;
}

/**
 * Metadata stored in the embeddings table's JSONB column for each tweet.
 * Mirrors TweetRecord but uses snake_case for JSONB consumer ergonomics.
 */
export interface TweetMetadata {
  text: string;
  created_at: string;
  favorite_count: number;
  retweet_count: number;
  reply_count: number;
  in_reply_to_status_id?: string | null;
  in_reply_to_user_id?: string | null;
  url: string;
  /** Relevance score from the classifier pass (0.0-1.0). */
  relevance?: number;
  /** Classifier-assigned thematic tag (free-form, set during filter pass). */
  classifier_theme?: string;
}

/**
 * A search result with score + denormalized metadata.
 */
export interface PrincipalCorpusSearchResult {
  id: string;
  score: number;
  metadata?: TweetMetadata;
}

/**
 * Response shape for search / similar queries.
 */
export interface PrincipalCorpusSearchResponse {
  results: PrincipalCorpusSearchResult[];
  backend: string;
  degraded: boolean;
  degradedReason?: string;
}
