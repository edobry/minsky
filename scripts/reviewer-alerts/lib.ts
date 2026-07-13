/**
 * Pure helpers for the reviewer-alerts setup scripts (mt#2419).
 *
 * Kept side-effect-free so they are unit-testable without subprocesses or
 * network. The scripts (`discover-chat-id.ts`, `verify-send.ts`) own the I/O.
 */

/** One discovered chat, with non-secret display context. */
export interface DiscoveredChat {
  chatId: string;
  /** "private" | "group" | "supergroup" | "channel" (Telegram chat.type). */
  type: string;
  /** Best-effort display label (username / first_name / title). Non-secret. */
  label: string;
}

/** Shape-tolerant extraction of distinct chats from a getUpdates response. */
export function extractChats(updatesBody: unknown): DiscoveredChat[] {
  const seen = new Map<string, DiscoveredChat>();
  if (updatesBody === null || typeof updatesBody !== "object") return [];
  const body = updatesBody as {
    result?: Array<{ message?: { chat?: Record<string, unknown> } }>;
  };
  for (const update of body.result ?? []) {
    const chat = update.message?.chat;
    if (!chat || chat["id"] === undefined) continue;
    const chatId = String(chat["id"]);
    if (seen.has(chatId)) continue;
    const label = String(chat["username"] ?? chat["first_name"] ?? chat["title"] ?? "(unnamed)");
    seen.set(chatId, { chatId, type: String(chat["type"] ?? "unknown"), label });
  }
  return Array.from(seen.values());
}

/**
 * Redact a secret from arbitrary text before it can reach stdout/stderr.
 * Telegram API URLs embed the bot token (`/bot<token>/`), so fetch errors and
 * response echoes can leak it — every printed string passes through this.
 */
export function redactSecret(secret: string, text: string): string {
  if (!secret) return text;
  return text.split(secret).join("***REDACTED***");
}

/**
 * Classify a non-ok getUpdates outcome into an operator-actionable message.
 * 409 = a Telegram webhook is registered on the bot (getUpdates is blocked
 * while one is set); 401 = bad token.
 */
export function classifyGetUpdatesFailure(status: number, description?: string): string {
  if (status === 401) {
    return "Telegram rejected the token (401). Re-check the value set in Pulumi config.";
  }
  if (status === 409) {
    return (
      "getUpdates is blocked because a Telegram webhook is set on this bot (409). " +
      "Delete it (deleteWebhook) or use a dedicated alert bot with no webhook."
    );
  }
  return `Telegram getUpdates failed (HTTP ${status})${description ? `: ${description}` : ""}.`;
}
