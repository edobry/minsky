/**
 * Shared helpers for formatting PR titles consistently across PR subcommands
 */

export function parseConventionalTitle(title: string): {
  type?: string;
  scope?: string;
  title: string;
} {
  if (!title) return { title: "" };
  const match =
    title.match(/^([a-z]+)!?\(([^)]*)\):\s*(.*)$/i) || title.match(/^([a-z]+)!?:\s*(.*)$/i);
  if (match) {
    if (match.length === 4) {
      const [, type, scope, rest] = match;
      return { type: type!.toLowerCase(), scope, title: rest ?? "" };
    }
    if (match.length === 3) {
      const [, type, rest] = match;
      return { type: type!.toLowerCase(), title: rest ?? "" };
    }
  }
  return { title };
}

export function getStatusIcon(status?: string): string {
  const normalized = (status || "").toLowerCase();
  switch (normalized) {
    case "open":
      return "🟢";
    case "draft":
      return "📝";
    case "merged":
      return "🟣";
    case "closed":
      return "🔴";
    case "created":
      return "🆕";
    default:
      return "•";
  }
}

export function formatPrTitleLine(input: {
  status?: string;
  rawTitle: string;
  prNumber?: number;
  taskId?: string;
  sessionId?: string;
}): string {
  const displayId = input.taskId || input.sessionId || "";
  const { type, title: cleanedTitle } = parseConventionalTitle(input.rawTitle || "");
  const statusIcon = getStatusIcon(input.status);

  const idBadge = displayId ? `[${displayId}]` : "";
  const typeBadge = type ? `[${type}]` : "";
  const prSuffix = input.prNumber ? `[#${input.prNumber}]` : "";
  return [statusIcon, typeBadge, idBadge, cleanedTitle, prSuffix]
    .filter((p) => p && p.trim().length > 0)
    .join(" ");
}
